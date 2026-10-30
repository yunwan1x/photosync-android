import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/settings_key.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/utils/background_sync.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:immich_mobile/models/auth/auxilary_endpoint.model.dart';
import 'package:immich_mobile/models/auth/login_response.model.dart';
import 'package:immich_mobile/models/network/endpoint_selection_diagnostics.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/repositories/auth.repository.dart';
import 'package:immich_mobile/repositories/auth_api.repository.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:immich_mobile/services/network.service.dart';
import 'package:immich_mobile/services/txt_endpoint.service.dart';
import 'package:immich_mobile/utils/url_helper.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart';

final authServiceProvider = Provider(
  (ref) => AuthService(
    ref.watch(authApiRepositoryProvider),
    ref.watch(authRepositoryProvider),
    ref.watch(apiServiceProvider),
    ref.watch(networkServiceProvider),
    ref.watch(backgroundSyncProvider),
  ),
);

class AuthService {
  final AuthApiRepository _authApiRepository;
  final AuthRepository _authRepository;
  final ApiService _apiService;
  final NetworkService _networkService;
  final BackgroundSyncManager _backgroundSyncManager;
  final _log = Logger("AuthService");
  Future<String?>? _endpointSelectionFuture;

  AuthService(
    this._authApiRepository,
    this._authRepository,
    this._apiService,
    this._networkService,
    this._backgroundSyncManager,
  );

  /// Validates the provided server URL by resolving and setting the endpoint.
  /// Also sets the device info header and stores the valid URL.
  ///
  /// [url] - The server URL to be validated.
  ///
  /// Returns the validated and resolved server URL as a [String].
  ///
  /// Throws an exception if the URL cannot be resolved or set.
  Future<String> validateServerUrl(String url) async {
    final validUrl = await _apiService.resolveAndSetEndpoint(url);
    await _apiService.setDeviceInfoHeader();
    final serverSource = TxtEndpointService.isTxtEndpoint(url) ? punycodeEncodeUrl(url.trim()) : validUrl;
    await Store.put(StoreKey.serverUrl, serverSource);

    return validUrl;
  }

  Future<bool> validateAuxilaryServerUrl(String url) async {
    bool isValid = false;

    try {
      final urls = ApiService.getServerUrls();
      urls.add(url);
      await NetworkRepository.setHeaders(ApiService.getRequestHeaders(), urls);
      final uri = Uri.parse('$url/users/me');
      final response = await NetworkRepository.client.get(uri);
      if (response.statusCode == 200) {
        isValid = true;
      }
    } catch (error) {
      _log.severe("Error validating auxiliary endpoint", error);
    }

    return isValid;
  }

  Future<LoginResponse> login(String email, String password) {
    return _authApiRepository.login(email, password);
  }

  /// Performs user logout operation by making a server request and clearing local data.
  ///
  /// This method attempts to log out the user through the authentication API repository.
  /// If the server request fails, the error is logged but local data is still cleared.
  /// The local data cleanup is guaranteed to execute regardless of the server request outcome.
  ///
  /// Throws any unhandled exceptions from the API request or local data clearing operations.
  Future<void> logout() async {
    try {
      await _authApiRepository.logout();
    } catch (error, stackTrace) {
      _log.severe("Error logging out", error, stackTrace);
    } finally {
      await clearLocalData().catchError((error, stackTrace) {
        _log.severe("Error clearing local data", error, stackTrace);
      });

      await SettingsRepository.instance.write(SettingsKey.backupEnabled, false);
    }
  }

  /// Clears all local authentication-related data.
  ///
  /// This method performs a concurrent deletion of:
  /// - Authentication repository data
  /// - Current user information
  /// - Access token
  /// - Server-specific endpoint configuration
  ///
  /// All deletions are executed in parallel using [Future.wait].
  Future<void> clearLocalData() async {
    // Cancel any ongoing background sync operations before clearing data
    await _backgroundSyncManager.cancel();
    await Future.wait([
      _authRepository.clearLocalData(),
      Store.delete(StoreKey.currentUser),
      Store.delete(StoreKey.accessToken),
      SettingsRepository.instance.clear(const [
        .networkAutoEndpointSwitching,
        .networkPreferredWifiName,
        .networkLocalEndpoint,
        .networkExternalEndpointList,
      ]),
    ]);
  }

  Future<void> changePassword(String newPassword) {
    try {
      return _authApiRepository.changePassword(newPassword);
    } catch (error, stackTrace) {
      _log.severe("Error changing password", error, stackTrace);
      rethrow;
    }
  }

  Future<String?> setOpenApiServiceEndpoint({EndpointSelectionReason reason = EndpointSelectionReason.manual}) {
    final inFlight = _endpointSelectionFuture;
    if (inFlight != null) {
      return inFlight;
    }

    final selection = _selectOpenApiServiceEndpoint(reason);
    _endpointSelectionFuture = selection;
    return selection.whenComplete(() {
      if (identical(_endpointSelectionFuture, selection)) {
        _endpointSelectionFuture = null;
      }
    });
  }

  Future<String?> _selectOpenApiServiceEndpoint(EndpointSelectionReason reason) async {
    try {
      // Background workers and cold starts do not necessarily pass through
      // AuthNotifier before making requests. Rehydrate the host-scoped auth
      // cookies from the persisted token for the currently saved endpoint.
      await _apiService.updateHeaders();
    } catch (error, stackTrace) {
      _log.warning("Unable to restore request credentials before endpoint selection", error, stackTrace);
    }

    final serverSource = Store.tryGet(StoreKey.serverUrl);
    final currentEndpoint = Store.tryGet(StoreKey.serverEndpoint);
    if (serverSource != null &&
        TxtEndpointService.isTxtEndpoint(serverSource) &&
        currentEndpoint != null &&
        currentEndpoint.isNotEmpty) {
      final change = await _apiService.refreshTxtEndpoint(currentEndpoint, reason: reason);
      if (change != null) {
        return change.currentEndpoint;
      }
    }

    final enable = _authRepository.getEndpointSwitchingFeature();
    if (!enable) {
      if (currentEndpoint != null &&
          currentEndpoint.isNotEmpty &&
          (serverSource == null || !TxtEndpointService.isTxtEndpoint(serverSource))) {
        await EndpointSelectionDiagnosticsStore.record(
          source: EndpointSelectionSource.direct,
          reason: reason,
          status: EndpointValidationStatus.unchanged,
          detail: 'Automatic endpoint switching is disabled',
        );
      }
      return null;
    }

    final wifiName = await _networkService.getWifiName();
    final savedWifiName = _authRepository.getPreferredWifiName();
    _SelectedEndpoint? selected;

    if (wifiName == savedWifiName) {
      final endpoint = await _setLocalConnection();
      if (endpoint != null) {
        selected = _SelectedEndpoint(endpoint: endpoint, source: EndpointSelectionSource.local);
      }
    }

    selected ??= await _setRemoteConnection();

    if (selected == null) {
      await EndpointSelectionDiagnosticsStore.record(
        source: EndpointSelectionSource.unknown,
        reason: reason,
        status: EndpointValidationStatus.failed,
        detail: 'No configured endpoint passed validation',
      );
      return null;
    }

    await _apiService.updateHeaders();
    await EndpointSelectionDiagnosticsStore.record(
      source: selected.source,
      reason: reason,
      status: EndpointValidationStatus.success,
      candidateIndex: selected.candidateIndex,
      detail: selected.source == EndpointSelectionSource.local
          ? 'Preferred Wi-Fi matched'
          : 'External endpoint passed validation',
    );
    return selected.endpoint;
  }

  Future<String?> _setLocalConnection() async {
    try {
      final localEndpoint = _authRepository.getLocalEndpoint();
      if (localEndpoint != null) {
        return await _apiService.resolveAndSetEndpoint(localEndpoint);
      }
    } catch (error, stackTrace) {
      _log.severe("Cannot set local endpoint", error, stackTrace);
    }

    return null;
  }

  Future<_SelectedEndpoint?> _setRemoteConnection() async {
    List<AuxilaryEndpoint> endpointList;

    try {
      endpointList = _authRepository.getExternalEndpointList();
    } catch (error, stackTrace) {
      _log.severe("Cannot get external endpoint", error, stackTrace);
      return null;
    }

    for (final (index, endpoint) in endpointList.indexed) {
      try {
        return _SelectedEndpoint(
          endpoint: await _apiService.resolveAndSetEndpoint(endpoint.url),
          source: EndpointSelectionSource.external,
          candidateIndex: index + 1,
        );
      } on ApiException catch (error) {
        _log.severe("Cannot resolve endpoint", error);
        continue;
      } catch (_) {
        _log.severe("Auxiliary server is not valid");
        continue;
      }
    }

    return null;
  }

  Future<bool> unlockPinCode(String pinCode) {
    return _authApiRepository.unlockPinCode(pinCode);
  }

  Future<void> lockPinCode() {
    return _authApiRepository.lockPinCode();
  }

  Future<void> setupPinCode(String pinCode) {
    return _authApiRepository.setupPinCode(pinCode);
  }
}

class _SelectedEndpoint {
  const _SelectedEndpoint({required this.endpoint, required this.source, this.candidateIndex});

  final String endpoint;
  final EndpointSelectionSource source;
  final int? candidateIndex;
}
