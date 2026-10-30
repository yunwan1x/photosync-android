import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:cupertino_http/cupertino_http.dart';
import 'package:http/http.dart' as http;
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/providers/infrastructure/platform.provider.dart';
import 'package:ok_http/ok_http.dart';
import 'package:web_socket/web_socket.dart';

typedef EndpointRefreshHandler = Future<EndpointChange?> Function(String failedEndpoint);

class EndpointChange {
  const EndpointChange({required this.previousEndpoint, required this.currentEndpoint});

  final String previousEndpoint;
  final String currentEndpoint;
}

class NetworkRepository {
  static http.Client? _client;
  static http.Client? _rawClient;
  static Pointer<Void>? _clientPointer;
  static EndpointRefreshHandler? _endpointRefreshHandler;

  static Future<void> init() async {
    final clientPointer = Pointer<Void>.fromAddress(await networkApi.getClientPointer());
    if (clientPointer == _clientPointer) {
      return;
    }
    _clientPointer = clientPointer;
    _client?.close();
    if (Platform.isIOS) {
      final session = URLSession.fromRawPointer(clientPointer.cast());
      _rawClient = CupertinoClient.fromSharedSession(session);
    } else {
      _rawClient = OkHttpClient.fromJniGlobalRef(
        clientPointer,
        configuration: const OkHttpClientConfiguration(
          connectTimeout: Duration(seconds: 30),
          readTimeout: Duration(seconds: 60),
          writeTimeout: Duration(seconds: 60),
        ),
      );
    }
    _client = EndpointRefreshingClient(_rawClient!, refreshEndpoint, () => Store.tryGet(StoreKey.serverEndpoint));
  }

  static void setEndpointRefreshHandler(EndpointRefreshHandler handler) {
    _endpointRefreshHandler = handler;
  }

  static Future<EndpointChange?> refreshEndpoint(String failedEndpoint) {
    final handler = _endpointRefreshHandler;
    return handler == null ? Future.value() : handler(failedEndpoint);
  }

  static Future<void> setHeaders(Map<String, String> headers, List<String> serverUrls, {String? token}) async {
    await networkApi.setRequestHeaders(headers, serverUrls, token);
    if (Platform.isIOS) {
      await init();
    }
  }

  // ignore: avoid-unused-parameters
  static Future<WebSocket> createWebSocket(Uri uri, {Map<String, String>? headers, Iterable<String>? protocols}) {
    if (Platform.isIOS) {
      final session = URLSession.fromRawPointer(_clientPointer!.cast());
      return CupertinoWebSocket.connectWithSession(session, uri, protocols: protocols);
    } else {
      return OkHttpWebSocket.connectFromJniGlobalRef(_clientPointer!, uri, protocols: protocols);
    }
  }

  const NetworkRepository();

  /// Returns a shared HTTP client that uses native SSL configuration.
  ///
  /// On iOS: Uses SharedURLSessionManager's URLSession.
  /// On Android: Uses SharedHttpClientManager's OkHttpClient.
  ///
  /// Must call [init] before using this method.
  static http.Client get client => _client!;

  /// Native HTTP client without endpoint refresh interception. Used to probe
  /// newly resolved endpoints without recursively triggering another refresh.
  static http.Client get rawClient => _rawClient!;
}

class EndpointRefreshingClient extends http.BaseClient {
  EndpointRefreshingClient(this._inner, this._refreshEndpoint, this._endpointProvider);

  static const _retryableStatusCodes = {502, 503, 504};

  final http.Client _inner;
  final EndpointRefreshHandler _refreshEndpoint;
  final String? Function() _endpointProvider;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final failedEndpoint = _endpointProvider();
    final snapshot = request is http.Request ? _RequestSnapshot.fromRequest(request) : null;

    try {
      final response = await _inner.send(request);
      if (snapshot == null || failedEndpoint == null || !_retryableStatusCodes.contains(response.statusCode)) {
        return response;
      }

      final change = await _tryRefresh(failedEndpoint);
      if (change == null) {
        return response;
      }

      await response.stream.drain<void>();
      return _inner.send(snapshot.createRetry(change));
    } catch (error, stackTrace) {
      if (snapshot == null || failedEndpoint == null || !_isRetryableError(error)) {
        Error.throwWithStackTrace(error, stackTrace);
      }

      final change = await _tryRefresh(failedEndpoint);
      if (change == null) {
        Error.throwWithStackTrace(error, stackTrace);
      }
      return _inner.send(snapshot.createRetry(change));
    }
  }

  Future<EndpointChange?> _tryRefresh(String failedEndpoint) async {
    try {
      return await _refreshEndpoint(failedEndpoint);
    } catch (_) {
      return null;
    }
  }

  bool _isRetryableError(Object error) {
    return error is! http.RequestAbortedException &&
        (error is SocketException || error is TimeoutException || error is http.ClientException);
  }

  @override
  void close() => _inner.close();
}

class _RequestSnapshot {
  _RequestSnapshot.fromRequest(http.Request request)
    : method = request.method,
      url = request.url,
      headers = Map.of(request.headers),
      bodyBytes = List.of(request.bodyBytes),
      encoding = request.encoding,
      followRedirects = request.followRedirects,
      maxRedirects = request.maxRedirects,
      persistentConnection = request.persistentConnection,
      abortTrigger = request is http.Abortable ? (request as http.Abortable).abortTrigger : null;

  final String method;
  final Uri url;
  final Map<String, String> headers;
  final List<int> bodyBytes;
  final Encoding encoding;
  final bool followRedirects;
  final int maxRedirects;
  final bool persistentConnection;
  final Future<void>? abortTrigger;

  http.Request createRetry(EndpointChange change) {
    final retryUrl = _replaceEndpoint(url, change);
    final request = abortTrigger == null
        ? http.Request(method, retryUrl)
        : http.AbortableRequest(method, retryUrl, abortTrigger: abortTrigger);
    request
      ..headers.addAll(headers)
      ..encoding = encoding
      ..bodyBytes = bodyBytes
      ..followRedirects = followRedirects
      ..maxRedirects = maxRedirects
      ..persistentConnection = persistentConnection;
    return request;
  }

  Uri _replaceEndpoint(Uri original, EndpointChange change) {
    final previous = Uri.parse(change.previousEndpoint);
    final current = Uri.parse(change.currentEndpoint);
    if (original.scheme != previous.scheme || original.host != previous.host || original.port != previous.port) {
      return original;
    }

    final previousPath = previous.path.replaceFirst(RegExp(r'/+$'), '');
    if (!original.path.startsWith(previousPath)) {
      return original;
    }
    final suffix = original.path.substring(previousPath.length);
    final currentPath = current.path.replaceFirst(RegExp(r'/+$'), '');

    return Uri(
      scheme: current.scheme,
      userInfo: current.userInfo,
      host: current.host,
      port: current.hasPort ? current.port : null,
      path: '$currentPath$suffix',
      query: original.hasQuery ? original.query : null,
      fragment: original.hasFragment ? original.fragment : null,
    );
  }
}
