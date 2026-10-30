import 'dart:convert';

import 'package:flutter_udid/flutter_udid.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/models/auth/auth_state.model.dart';
import 'package:immich_mobile/models/auth/login_response.model.dart';
import 'package:immich_mobile/models/network/endpoint_selection_diagnostics.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:immich_mobile/services/auth.service.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:immich_mobile/services/widget.service.dart';
import 'package:immich_mobile/utils/debug_print.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart';

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(
    ref.watch(authServiceProvider),
    ref.watch(apiServiceProvider),
    ref.watch(userServiceProvider),
    ref.watch(secureStorageServiceProvider),
    ref.watch(widgetServiceProvider),
    ref,
  );
});

class AuthNotifier extends StateNotifier<AuthState> {
  final AuthService _authService;
  final ApiService _apiService;
  final UserService _userService;

  final SecureStorageService _secureStorageService;
  final WidgetService _widgetService;
  final Ref _ref;
  final _log = Logger("AuthenticationNotifier");

  static const Duration _timeoutDuration = Duration(seconds: 7);

  AuthNotifier(
    this._authService,
    this._apiService,
    this._userService,

    this._secureStorageService,
    this._widgetService,
    this._ref,
  ) : super(
        const AuthState(
          deviceId: "",
          userId: "",
          userEmail: "",
          name: '',
          profileImagePath: '',
          isAdmin: false,
          isAuthenticated: false,
        ),
      );

  Future<String> validateServerUrl(String url) {
    return _authService.validateServerUrl(url);
  }

  /// Validating the url is the alternative connecting server url without
  /// saving the information to the local database
  Future<bool> validateAuxilaryServerUrl(String url) async {
    try {
      final validEndpoint = await _apiService.resolveEndpoint(url);
      return await _authService.validateAuxilaryServerUrl(validEndpoint);
    } catch (_) {
      return false;
    }
  }

  Future<LoginResponse> login(String email, String password) async {
    final response = await _authService.login(email, password);
    await saveAuthInfo(accessToken: response.accessToken);
    return response;
  }

  Future<void> logout() async {
    try {
      await _secureStorageService.delete(kSecuredPinCode);
      await _widgetService.clearCredentials();

      await _authService.logout();
      await _ref.read(backgroundUploadServiceProvider).cancel();
      _ref.read(foregroundUploadServiceProvider).cancel();
    } finally {
      await _cleanUp();
    }
  }

  Future<void> _cleanUp() async {
    state = const AuthState(
      deviceId: "",
      userId: "",
      userEmail: "",
      name: '',
      profileImagePath: '',
      isAdmin: false,
      isAuthenticated: false,
    );
  }

  void updateUserProfileImagePath(String path) {
    state = state.copyWith(profileImagePath: path);
  }

  Future<bool> changePassword(String newPassword) async {
    try {
      await _authService.changePassword(newPassword);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<bool> saveAuthInfo({required String accessToken}) async {
    UserDto? user = _userService.tryGetMyUser();
    String deviceId = Store.tryGet(StoreKey.deviceId) ?? '';

    try {
      await Store.put(StoreKey.accessToken, accessToken);
    } catch (error, stackTrace) {
      _log.severe("Unable to persist access token", error, stackTrace);
      if (Store.tryGet(StoreKey.accessToken) != accessToken) {
        return false;
      }
    }

    if (deviceId.isEmpty) {
      try {
        deviceId = await FlutterUdid.consistentUdid;
        await Store.put(StoreKey.deviceId, deviceId);
      } catch (error, stackTrace) {
        _log.warning("Unable to restore device identifier", error, stackTrace);
      }
    }

    // Restore the cached identity before touching the network. This keeps an
    // established session locally authenticated while the configured server
    // is offline and allows background work to remain scheduled.
    if (user != null) {
      _setAuthenticatedUser(user, deviceId);
    }

    try {
      await _apiService.updateHeaders();
    } catch (error, stackTrace) {
      _log.warning("Unable to bind stored credentials to the current endpoint", error, stackTrace);
    }

    try {
      final serverEndpoint = Store.tryGet(StoreKey.serverEndpoint);
      if (serverEndpoint != null) {
        final headerMap = _ref.read(appConfigProvider).network.customHeaders;
        final customHeaders = headerMap.isEmpty ? null : jsonEncode(headerMap);
        await _widgetService.writeCredentials(serverEndpoint, accessToken, customHeaders);
      }
    } catch (error, stackTrace) {
      _log.warning("Unable to refresh widget credentials", error, stackTrace);
    }

    try {
      final serverUser = await _userService.refreshMyUser().timeout(_timeoutDuration);
      if (serverUser == null) {
        _log.severe("Unable to get user information from the server.");
      } else {
        user = serverUser;
      }
    } on ApiException catch (error, stackTrace) {
      if (error.code == 401) {
        _log.severe("Unauthorized access, token likely expired. Logging out.");
        return false;
      }
      _log.severe("Error getting user information from the server [API EXCEPTION]", stackTrace);
    } catch (error, stackTrace) {
      _log.severe("Error getting user information from the server [CATCH ALL]", error, stackTrace);
      dPrint(() => "Error getting user information from the server [CATCH ALL] $error $stackTrace");
    }

    // If the user is null, the login was not successful
    // and we don't have a local copy of the user from a prior successful login
    if (user == null) {
      return false;
    }

    _setAuthenticatedUser(user, deviceId);
    return true;
  }

  void _setAuthenticatedUser(UserDto user, String deviceId) {
    state = state.copyWith(
      deviceId: deviceId,
      userId: user.id,
      userEmail: user.email,
      isAuthenticated: true,
      name: user.name,
      isAdmin: user.isAdmin,
    );
  }

  Future<void> saveWifiName(String wifiName) async {
    await _ref.read(settingsProvider).write(.networkPreferredWifiName, wifiName);
  }

  Future<void> saveLocalEndpoint(String url) async {
    await _ref.read(settingsProvider).write(.networkLocalEndpoint, url);
    await _apiService.updateHeaders();
  }

  String? getSavedWifiName() {
    return _ref.read(appConfigProvider).network.preferredWifiName;
  }

  String? getSavedLocalEndpoint() {
    return _ref.read(appConfigProvider).network.localEndpoint;
  }

  /// Returns the current server endpoint (with /api) URL from the store
  String? getServerEndpoint() {
    return Store.tryGet(StoreKey.serverEndpoint);
  }

  Future<String?> setOpenApiServiceEndpoint({EndpointSelectionReason reason = EndpointSelectionReason.manual}) {
    return _authService.setOpenApiServiceEndpoint(reason: reason);
  }

  Future<bool> unlockPinCode(String pinCode) {
    return _authService.unlockPinCode(pinCode);
  }

  Future<void> lockPinCode() {
    return _authService.lockPinCode();
  }

  Future<void> setupPinCode(String pinCode) {
    return _authService.setupPinCode(pinCode);
  }
}
