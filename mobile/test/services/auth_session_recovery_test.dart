import 'dart:io';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/domain/utils/background_sync.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/repositories/auth.repository.dart';
import 'package:immich_mobile/repositories/auth_api.repository.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/routing/auth_guard.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:immich_mobile/services/auth.service.dart';
import 'package:immich_mobile/services/network.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:immich_mobile/services/widget.service.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../fixtures/user.stub.dart';

class _MockAuthService extends Mock implements AuthService {}

class _MockAuthApiRepository extends Mock implements AuthApiRepository {}

class _MockAuthRepository extends Mock implements AuthRepository {}

class _MockApiService extends Mock implements ApiService {}

class _MockUserService extends Mock implements UserService {}

class _MockSecureStorageService extends Mock implements SecureStorageService {}

class _MockWidgetService extends Mock implements WidgetService {}

class _MockAuthenticationApi extends Mock implements AuthenticationApi {}

class _MockNavigationResolver extends Mock implements NavigationResolver {}

class _MockStackRouter extends Mock implements StackRouter {}

class _MockNetworkService extends Mock implements NetworkService {}

class _MockBackgroundSyncManager extends Mock implements BackgroundSyncManager {}

class _MemoryStoreRepository extends Mock implements DriftStoreRepository {
  final Map<int, StoreDto<Object>> values = {};

  @override
  Future<bool> deleteAll() async {
    values.clear();
    return true;
  }

  @override
  Future<List<StoreDto<Object>>> getAll() async => values.values.toList();

  @override
  Stream<List<StoreDto<Object>>> watchAll() => const Stream.empty();

  @override
  Future<void> delete<T>(StoreKey<T> key) async {
    values.remove(key.id);
  }

  @override
  Future<bool> upsert<T>(StoreKey<T> key, T value) async {
    values[key.id] = StoreDto<Object>(key as StoreKey<Object>, value as Object);
    return true;
  }

  @override
  Stream<T?> watch<T>(StoreKey<T> key) => const Stream.empty();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    registerFallbackValue(<PageRouteInfo<dynamic>>[]);
    await StoreService.init(storeRepository: _MemoryStoreRepository());
  });

  setUp(() async {
    await Store.clear();
    await Store.put(StoreKey.serverUrl, 'txt://immich.example.test');
    await Store.put(StoreKey.serverEndpoint, 'http://192.0.2.10:2283/api');
    await Store.put(StoreKey.deviceId, 'device-id');
  });

  test('network headers rebind the stored access token to a changed TXT host', () async {
    const token = 'persisted-access-token';
    await Store.put(StoreKey.accessToken, token);
    await Store.put(StoreKey.serverEndpoint, 'http://198.51.100.20:2283/api');

    Map<String, String>? capturedHeaders;
    List<String>? capturedUrls;
    String? capturedToken;
    final client = MockClient((_) async => http.Response('{}', 200));
    final service = ApiService(
      clientProvider: () => client,
      requestHeadersProvider: () => const {},
      serverUrlsProvider: () => [Store.get(StoreKey.serverEndpoint)],
      setHeaders: (headers, urls, {token}) async {
        capturedHeaders = headers;
        capturedUrls = urls;
        capturedToken = token;
      },
    );

    await service.updateHeaders();

    expect(capturedHeaders, isEmpty);
    expect(capturedUrls, contains('http://198.51.100.20:2283/api'));
    expect(capturedToken, token);
  });

  test('network headers do not invent credentials before the first login', () async {
    await Store.delete(StoreKey.accessToken);
    String? capturedToken = 'not-called';
    final client = MockClient((_) async => http.Response('{}', 200));
    final service = ApiService(
      clientProvider: () => client,
      requestHeadersProvider: () => const {},
      serverUrlsProvider: () => [Store.get(StoreKey.serverEndpoint)],
      setHeaders: (_, _, {token}) async => capturedToken = token,
    );

    await service.updateHeaders();

    expect(capturedToken, isNull);
  });

  test('cached user stays authenticated when startup network and widget refresh fail', () async {
    const token = 'persisted-access-token';
    final authService = _MockAuthService();
    final apiService = _MockApiService();
    final userService = _MockUserService();
    final secureStorageService = _MockSecureStorageService();
    final widgetService = _MockWidgetService();
    await Store.put(StoreKey.accessToken, token);

    when(() => apiService.updateHeaders()).thenThrow(const SocketException('offline'));
    when(() => userService.tryGetMyUser()).thenReturn(UserStub.admin);
    when(() => userService.refreshMyUser()).thenThrow(ApiException(503, 'offline'));
    when(
      () => widgetService.writeCredentials(any(), any(), any()),
    ).thenThrow(PlatformException(code: 'widget-unavailable'));

    late AuthNotifier notifier;
    final notifierProvider = Provider<AuthNotifier>((ref) {
      notifier = AuthNotifier(authService, apiService, userService, secureStorageService, widgetService, ref);
      return notifier;
    });
    final container = ProviderContainer(overrides: [appConfigProvider.overrideWithValue(const AppConfig())]);
    addTearDown(container.dispose);
    container.read(notifierProvider);

    final restored = await notifier.saveAuthInfo(accessToken: token);

    expect(restored, isTrue);
    expect(notifier.state.isAuthenticated, isTrue);
    expect(notifier.state.userId, UserStub.admin.id);
    expect(Store.get(StoreKey.accessToken), token);
  });

  test('background endpoint selection restores credentials for a direct HTTP server', () async {
    final apiService = _MockApiService();
    final authRepository = _MockAuthRepository();
    await Store.put(StoreKey.serverUrl, 'http://192.0.2.10:2283/api');

    when(() => apiService.updateHeaders()).thenAnswer((_) async {});
    when(() => authRepository.getEndpointSwitchingFeature()).thenReturn(false);

    final service = AuthService(
      _MockAuthApiRepository(),
      authRepository,
      apiService,
      _MockNetworkService(),
      _MockBackgroundSyncManager(),
    );

    await service.setOpenApiServiceEndpoint();

    verify(() => apiService.updateHeaders()).called(1);
  });

  test('route validation binds stored credentials before validating the token', () async {
    const token = 'persisted-access-token';
    final apiService = _MockApiService();
    final authService = _MockAuthService();
    final authenticationApi = _MockAuthenticationApi();
    final resolver = _MockNavigationResolver();
    final router = _MockStackRouter();
    await Store.put(StoreKey.accessToken, token);

    when(() => apiService.updateHeaders()).thenAnswer((_) async {});
    when(() => apiService.authenticationApi).thenReturn(authenticationApi);
    when(
      () => authenticationApi.validateAccessToken(),
    ).thenAnswer((_) async => ValidateAccessTokenResponseDto(authStatus: true));

    AuthGuard(apiService, authService).onNavigation(resolver, router);
    await pumpEventQueue();

    verify(() => resolver.next(true)).called(1);
    verifyInOrder([() => apiService.updateHeaders(), () => authenticationApi.validateAccessToken()]);
    verifyNever(() => authService.clearLocalData());
  });

  test('route validation keeps the session when credential rebinding is temporarily unavailable', () async {
    const token = 'persisted-access-token';
    final apiService = _MockApiService();
    final authService = _MockAuthService();
    final authenticationApi = _MockAuthenticationApi();
    final resolver = _MockNavigationResolver();
    final router = _MockStackRouter();
    await Store.put(StoreKey.accessToken, token);

    when(() => apiService.updateHeaders()).thenThrow(const SocketException('offline'));
    when(() => apiService.authenticationApi).thenReturn(authenticationApi);

    AuthGuard(apiService, authService).onNavigation(resolver, router);
    await pumpEventQueue();

    verify(() => resolver.next(true)).called(1);
    verifyNever(() => authenticationApi.validateAccessToken());
    verifyNever(() => authService.clearLocalData());
    expect(Store.get(StoreKey.accessToken), token);
  });

  test('route validation does not treat a rebinding 401 as a revoked session', () async {
    const token = 'persisted-access-token';
    final apiService = _MockApiService();
    final authService = _MockAuthService();
    final authenticationApi = _MockAuthenticationApi();
    final resolver = _MockNavigationResolver();
    final router = _MockStackRouter();
    await Store.put(StoreKey.accessToken, token);

    when(() => apiService.updateHeaders()).thenThrow(ApiException(401, 'binding failed'));
    when(() => apiService.authenticationApi).thenReturn(authenticationApi);

    AuthGuard(apiService, authService).onNavigation(resolver, router);
    await pumpEventQueue();

    verifyNever(() => authenticationApi.validateAccessToken());
    verifyNever(() => authService.clearLocalData());
    expect(Store.get(StoreKey.accessToken), token);
  });

  test('confirmed unauthorized response clears the session after credential rebinding', () async {
    const token = 'revoked-access-token';
    final apiService = _MockApiService();
    final authService = _MockAuthService();
    final authenticationApi = _MockAuthenticationApi();
    final resolver = _MockNavigationResolver();
    final router = _MockStackRouter();
    await Store.put(StoreKey.accessToken, token);

    when(() => apiService.updateHeaders()).thenAnswer((_) async {});
    when(() => apiService.authenticationApi).thenReturn(authenticationApi);
    when(() => authenticationApi.validateAccessToken()).thenThrow(ApiException(401, 'revoked'));
    when(() => router.replaceAll(any())).thenAnswer((_) async {});
    when(() => authService.clearLocalData()).thenAnswer((_) async {});

    AuthGuard(apiService, authService).onNavigation(resolver, router);
    await pumpEventQueue();

    verifyInOrder([
      () => apiService.updateHeaders(),
      () => authenticationApi.validateAccessToken(),
      () => router.replaceAll(any()),
      () => authService.clearLocalData(),
    ]);
  });
}
