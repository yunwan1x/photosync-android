import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:http/http.dart' as http;
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/models/network/endpoint_selection_diagnostics.model.dart';
import 'package:immich_mobile/services/availability_probe_policy.dart';
import 'package:immich_mobile/services/txt_endpoint.service.dart';
import 'package:immich_mobile/utils/debug_print.dart';
import 'package:immich_mobile/utils/url_helper.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart';

typedef NetworkHeaderSetter =
    Future<void> Function(Map<String, String> headers, List<String> serverUrls, {String? token});

typedef NetworkClientProvider = http.Client Function();
typedef RequestHeadersProvider = Map<String, String> Function();
typedef ServerUrlsProvider = List<String> Function();

class ApiService {
  final ApiClient _apiClient = ApiClient(basePath: '');
  final TxtEndpointService _txtEndpointService;
  final NetworkHeaderSetter _setHeaders;
  final NetworkClientProvider _clientProvider;
  final RequestHeadersProvider _requestHeadersProvider;
  final ServerUrlsProvider _serverUrlsProvider;
  Future<String?>? _txtRefreshFuture;
  DateTime? _lastTxtRefreshAttempt;
  Future<bool>? _availabilityProbeFuture;
  final AvailabilityProbePolicy _availabilityProbePolicy = AvailabilityProbePolicy();

  static const _txtRefreshCooldown = Duration(seconds: 5);

  late UsersApi usersApi;
  late AuthenticationApi authenticationApi;
  late AuthenticationApi oAuthApi;
  late AlbumsApi albumsApi;
  late AssetsApi assetsApi;
  late SearchApi searchApi;
  late ServerApi serverInfoApi;
  late MapApi mapApi;
  late PartnersApi partnersApi;
  late PeopleApi peopleApi;
  late SharedLinksApi sharedLinksApi;
  late SyncApi syncApi;
  late SystemConfigApi systemConfigApi;
  late ActivitiesApi activitiesApi;
  late DownloadApi downloadApi;
  late TrashApi trashApi;
  late StacksApi stacksApi;
  late ViewsApi viewApi;
  late MemoriesApi memoriesApi;
  late SessionsApi sessionsApi;
  late TagsApi tagsApi;

  ApiService({
    TxtEndpointService? txtEndpointService,
    NetworkHeaderSetter? setHeaders,
    NetworkClientProvider? clientProvider,
    RequestHeadersProvider? requestHeadersProvider,
    ServerUrlsProvider? serverUrlsProvider,
  }) : _txtEndpointService = txtEndpointService ?? TxtEndpointService(),
       _setHeaders = setHeaders ?? NetworkRepository.setHeaders,
       _clientProvider = clientProvider ?? (() => NetworkRepository.client),
       _requestHeadersProvider = requestHeadersProvider ?? getRequestHeaders,
       _serverUrlsProvider = serverUrlsProvider ?? getServerUrls {
    // The below line ensures that the api clients are initialized when the service is instantiated
    // This is required to avoid late initialization errors when the clients are access before the endpoint is resolved
    setEndpoint('');
    final endpoint = Store.tryGet(StoreKey.serverEndpoint);
    if (endpoint != null && endpoint.isNotEmpty) {
      setEndpoint(endpoint);
    }
    NetworkRepository.setEndpointRefreshHandler(
      (failedEndpoint) => refreshTxtEndpoint(failedEndpoint, reason: EndpointSelectionReason.requestFailure),
    );
  }
  final _log = Logger("ApiService");

  Future<void> updateHeaders() async {
    await _setHeaders(_requestHeadersProvider(), _serverUrlsProvider(), token: Store.tryGet(StoreKey.accessToken));
    _apiClient.client = _clientProvider();
  }

  setEndpoint(String endpoint) {
    _apiClient.basePath = endpoint;
    _apiClient.client = _clientProvider();
    usersApi = UsersApi(_apiClient);
    authenticationApi = AuthenticationApi(_apiClient);
    oAuthApi = AuthenticationApi(_apiClient);
    albumsApi = AlbumsApi(_apiClient);
    assetsApi = AssetsApi(_apiClient);
    serverInfoApi = ServerApi(_apiClient);
    searchApi = SearchApi(_apiClient);
    mapApi = MapApi(_apiClient);
    partnersApi = PartnersApi(_apiClient);
    peopleApi = PeopleApi(_apiClient);
    sharedLinksApi = SharedLinksApi(_apiClient);
    syncApi = SyncApi(_apiClient);
    systemConfigApi = SystemConfigApi(_apiClient);
    activitiesApi = ActivitiesApi(_apiClient);
    downloadApi = DownloadApi(_apiClient);
    trashApi = TrashApi(_apiClient);
    stacksApi = StacksApi(_apiClient);
    viewApi = ViewsApi(_apiClient);
    memoriesApi = MemoriesApi(_apiClient);
    sessionsApi = SessionsApi(_apiClient);
    tagsApi = TagsApi(_apiClient);
  }

  Future<String> resolveAndSetEndpoint(String serverUrl) async {
    final endpoint = await resolveEndpoint(serverUrl);
    setEndpoint(endpoint);

    // Save in local database for next startup
    await Store.put(StoreKey.serverEndpoint, endpoint);
    if (TxtEndpointService.isTxtEndpoint(serverUrl)) {
      await EndpointSelectionDiagnosticsStore.record(
        source: EndpointSelectionSource.txt,
        reason: EndpointSelectionReason.manual,
        status: EndpointValidationStatus.success,
        detail: 'TXT endpoint resolved and passed validation',
      );
    }
    return endpoint;
  }

  /// Takes a server URL and attempts to resolve the API endpoint.
  ///
  /// Input: [schema://]host[:port][/path] or txt://domain
  ///  schema - optional (default: https), or txt for a DNS TXT lookup
  ///  host   - required
  ///  port   - optional (default: based on schema)
  ///  path   - optional
  Future<String> resolveEndpoint(String serverUrl) async {
    var input = serverUrl.trim();
    if (TxtEndpointService.isTxtEndpoint(input)) {
      final encodedTxtUrl = punycodeEncodeUrl(input);
      if (encodedTxtUrl.isEmpty) {
        throw const TxtEndpointException('Invalid txt:// server address');
      }
      final candidates = await _txtEndpointService.resolveCandidates(encodedTxtUrl);
      for (final candidate in candidates) {
        final endpoint = await _resolveHttpEndpoint(candidate);
        if (endpoint != null) {
          return endpoint;
        }
      }
      throw ApiException(503, 'Server is not reachable');
    }

    final endpoint = await _resolveHttpEndpoint(input);
    if (endpoint == null) {
      throw ApiException(503, 'Server is not reachable');
    }
    return endpoint;
  }

  Future<EndpointChange?> refreshTxtEndpoint(
    String failedEndpoint, {
    EndpointSelectionReason reason = EndpointSelectionReason.requestFailure,
  }) async {
    final currentEndpoint = Store.tryGet(StoreKey.serverEndpoint);
    if (currentEndpoint != null && currentEndpoint.isNotEmpty && currentEndpoint != failedEndpoint) {
      await EndpointSelectionDiagnosticsStore.record(
        source: EndpointSelectionSource.txt,
        reason: reason,
        status: EndpointValidationStatus.success,
        detail: 'A newer TXT endpoint was already selected',
      );
      return EndpointChange(previousEndpoint: failedEndpoint, currentEndpoint: currentEndpoint);
    }

    final source = Store.tryGet(StoreKey.serverUrl);
    if (source == null || !TxtEndpointService.isTxtEndpoint(source)) {
      return null;
    }

    final inFlight = _txtRefreshFuture;
    if (inFlight != null) {
      final endpoint = await inFlight;
      return endpoint == null ? null : EndpointChange(previousEndpoint: failedEndpoint, currentEndpoint: endpoint);
    }

    final now = DateTime.now();
    final lastAttempt = _lastTxtRefreshAttempt;
    if (lastAttempt != null && now.difference(lastAttempt) < _txtRefreshCooldown) {
      await EndpointSelectionDiagnosticsStore.record(
        source: EndpointSelectionSource.txt,
        reason: reason,
        status: EndpointValidationStatus.cooldown,
        detail: 'TXT refresh is waiting for the retry cooldown',
      );
      return null;
    }
    _lastTxtRefreshAttempt = now;

    final refresh = _refreshTxtEndpoint(source, failedEndpoint, reason);
    _txtRefreshFuture = refresh;
    try {
      final endpoint = await refresh;
      return endpoint == null ? null : EndpointChange(previousEndpoint: failedEndpoint, currentEndpoint: endpoint);
    } finally {
      _txtRefreshFuture = null;
    }
  }

  /// Checks whether the configured server can accept backup work without
  /// consuming retries on individual media files. TXT sources are resolved
  /// again after the cooldown so NAT endpoints can change while the app is
  /// suspended. Direct HTTP(S) sources only ping their saved API endpoint.
  Future<bool> probeServerAvailability() async {
    final inFlight = _availabilityProbeFuture;
    if (inFlight != null) {
      return inFlight;
    }

    final now = DateTime.now();
    final cached = _availabilityProbePolicy.cachedResult(now);
    if (cached != null) {
      return cached;
    }

    final probe = _probeConfiguredServer();
    _availabilityProbeFuture = probe;
    try {
      final result = await probe;
      _availabilityProbePolicy.record(now, result);
      return result;
    } finally {
      _availabilityProbeFuture = null;
    }
  }

  Future<bool> _probeConfiguredServer() async {
    final source = Store.tryGet(StoreKey.serverUrl);
    final savedEndpoint = Store.tryGet(StoreKey.serverEndpoint);

    if (source != null && TxtEndpointService.isTxtEndpoint(source)) {
      try {
        final candidates = await _txtEndpointService.resolveCandidates(punycodeEncodeUrl(source));
        for (final candidate in candidates) {
          final endpoint = await _resolveHttpEndpoint(candidate);
          if (endpoint == null) {
            continue;
          }
          if (endpoint != savedEndpoint) {
            await Store.put(StoreKey.serverEndpoint, endpoint);
            setEndpoint(endpoint);
            await updateHeaders();
            _log.info('Availability probe switched TXT endpoint to $endpoint');
          }
          await EndpointSelectionDiagnosticsStore.record(
            source: EndpointSelectionSource.txt,
            reason: EndpointSelectionReason.availabilityProbe,
            status: endpoint == savedEndpoint ? EndpointValidationStatus.unchanged : EndpointValidationStatus.success,
            detail: endpoint == savedEndpoint
                ? 'The saved TXT endpoint remains reachable'
                : 'Availability probe selected a new TXT endpoint',
          );
          return true;
        }
      } catch (error, stackTrace) {
        _log.fine('TXT availability lookup failed; checking the last resolved endpoint', error, stackTrace);
      }

      final reachable = savedEndpoint != null && savedEndpoint.isNotEmpty && await _isEndpointAvailable(savedEndpoint);
      await EndpointSelectionDiagnosticsStore.record(
        source: EndpointSelectionSource.txt,
        reason: EndpointSelectionReason.availabilityProbe,
        status: reachable ? EndpointValidationStatus.unchanged : EndpointValidationStatus.failed,
        detail: reachable
            ? 'TXT lookup failed but the saved endpoint remains reachable'
            : 'TXT lookup and saved endpoint validation failed',
      );
      return reachable;
    }

    if (savedEndpoint != null && savedEndpoint.isNotEmpty) {
      return _isEndpointAvailable(savedEndpoint);
    }

    if (source == null || source.isEmpty) {
      return false;
    }

    return await _resolveHttpEndpoint(source) != null;
  }

  Future<String?> _refreshTxtEndpoint(String source, String failedEndpoint, EndpointSelectionReason reason) async {
    try {
      final encodedSource = punycodeEncodeUrl(source);
      final candidates = await _txtEndpointService.resolveCandidates(encodedSource);
      final orderedCandidates = candidates.toList()
        ..sort((a, b) {
          final aFailed = _likelyApiEndpoint(a) == failedEndpoint;
          final bFailed = _likelyApiEndpoint(b) == failedEndpoint;
          return aFailed == bFailed ? 0 : (aFailed ? 1 : -1);
        });
      for (final candidate in orderedCandidates) {
        final endpoint = await _resolveHttpEndpoint(candidate);
        if (endpoint != null) {
          await Store.put(StoreKey.serverEndpoint, endpoint);
          setEndpoint(endpoint);
          await updateHeaders();
          _log.info('Refreshed TXT server endpoint: $endpoint');
          await EndpointSelectionDiagnosticsStore.record(
            source: EndpointSelectionSource.txt,
            reason: reason,
            status: endpoint == failedEndpoint ? EndpointValidationStatus.unchanged : EndpointValidationStatus.success,
            detail: endpoint == failedEndpoint
                ? 'The TXT endpoint is unchanged and reachable'
                : 'TXT resolved to a new reachable endpoint',
          );
          return endpoint;
        }
      }
      await EndpointSelectionDiagnosticsStore.record(
        source: EndpointSelectionSource.txt,
        reason: reason,
        status: EndpointValidationStatus.failed,
        detail: 'No TXT candidate passed validation',
      );
      return null;
    } catch (error, stackTrace) {
      _log.warning('Could not refresh TXT server endpoint', error, stackTrace);
      await EndpointSelectionDiagnosticsStore.record(
        source: EndpointSelectionSource.txt,
        reason: reason,
        status: EndpointValidationStatus.failed,
        detail: 'TXT lookup or endpoint validation failed',
      );
      return null;
    }
  }

  Future<String?> _resolveHttpEndpoint(String input) async {
    final encodedUrl = punycodeEncodeUrl(sanitizeUrl(input));
    if (encodedUrl.isEmpty) {
      throw ApiException(400, 'Invalid server URL');
    }
    String url = encodedUrl;

    // Check for /.well-known/immich
    final wellKnownEndpoint = await _getWellKnownEndpoint(url);
    if (wellKnownEndpoint.isNotEmpty) {
      url = sanitizeUrl(wellKnownEndpoint);
    }

    final apiEndpoint = url.endsWith('/api') ? url : '$url/api';
    if (!await _isEndpointAvailable(apiEndpoint)) {
      return null;
    }

    return apiEndpoint;
  }

  String _likelyApiEndpoint(String input) {
    final url = punycodeEncodeUrl(sanitizeUrl(input));
    return url.endsWith('/api') ? url : '$url/api';
  }

  Future<bool> _isEndpointAvailable(String serverUrl) async {
    try {
      final response = await NetworkRepository.rawClient
          .get(Uri.parse('$serverUrl/server/ping'), headers: getRequestHeaders())
          .timeout(const Duration(seconds: 5));
      return response.statusCode == 200;
    } on TimeoutException catch (_) {
      return false;
    } on SocketException catch (_) {
      return false;
    } catch (error, stackTrace) {
      _log.severe("Error while checking server availability", error, stackTrace);
      return false;
    }
  }

  Future<String> _getWellKnownEndpoint(String baseUrl) async {
    try {
      final res = await NetworkRepository.rawClient
          .get(Uri.parse("$baseUrl/.well-known/immich"), headers: getRequestHeaders())
          .timeout(const Duration(seconds: 5));

      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        final endpoint = data['api']['endpoint'].toString();

        if (endpoint.startsWith('/')) {
          // Full URL is relative to base
          return "$baseUrl$endpoint";
        }
        return endpoint;
      }
    } catch (e) {
      dPrint(() => "Could not locate /.well-known/immich at $baseUrl");
    }

    return "";
  }

  Future<void> setDeviceInfoHeader() async {
    DeviceInfoPlugin deviceInfoPlugin = DeviceInfoPlugin();

    if (Platform.isIOS) {
      final iosInfo = await deviceInfoPlugin.iosInfo;
      authenticationApi.apiClient.addDefaultHeader('deviceModel', iosInfo.utsname.machine);
      authenticationApi.apiClient.addDefaultHeader('deviceType', 'iOS');
    } else if (Platform.isAndroid) {
      final androidInfo = await deviceInfoPlugin.androidInfo;
      authenticationApi.apiClient.addDefaultHeader('deviceModel', androidInfo.model);
      authenticationApi.apiClient.addDefaultHeader('deviceType', 'Android');
    } else {
      authenticationApi.apiClient.addDefaultHeader('deviceModel', 'Unknown');
      authenticationApi.apiClient.addDefaultHeader('deviceType', 'Unknown');
    }
  }

  static List<String> getServerUrls() {
    final urls = <String>[];
    final serverEndpoint = Store.tryGet(StoreKey.serverEndpoint);
    if (serverEndpoint != null && serverEndpoint.isNotEmpty) {
      urls.add(serverEndpoint);
    }
    final network = SettingsRepository.instance.appConfig.network;
    final localEndpoint = network.localEndpoint;
    if (localEndpoint != null && localEndpoint.isNotEmpty) {
      urls.add(localEndpoint);
    }
    for (final url in network.externalEndpointList) {
      if (url.isNotEmpty) {
        urls.add(url);
      }
    }
    return urls;
  }

  static Map<String, String> getRequestHeaders() {
    return SettingsRepository.instance.appConfig.network.customHeaders;
  }

  ApiClient get apiClient => _apiClient;
}
