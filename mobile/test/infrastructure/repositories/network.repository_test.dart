import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';

void main() {
  const oldEndpoint = 'https://old.example.com/api';
  const newEndpoint = 'https://new.example.com/api';

  test('refreshes TXT endpoint and retries once after a gateway failure', () async {
    var requestCount = 0;
    var refreshCount = 0;
    final inner = MockClient((request) async {
      requestCount++;
      if (requestCount == 1) {
        expect(request.url, Uri.parse('$oldEndpoint/server/ping'));
        return http.Response('temporarily unavailable', 503);
      }

      expect(request.url, Uri.parse('$newEndpoint/server/ping'));
      return http.Response('pong', 200);
    });
    final client = EndpointRefreshingClient(inner, (failedEndpoint) async {
      refreshCount++;
      expect(failedEndpoint, oldEndpoint);
      return const EndpointChange(previousEndpoint: oldEndpoint, currentEndpoint: newEndpoint);
    }, () => oldEndpoint);
    addTearDown(client.close);

    final response = await client.get(Uri.parse('$oldEndpoint/server/ping'));

    expect(response.statusCode, 200);
    expect(response.body, 'pong');
    expect(requestCount, 2);
    expect(refreshCount, 1);
  });

  test('replays the request body after a connection failure', () async {
    var requestCount = 0;
    final inner = MockClient((request) async {
      requestCount++;
      expect(request.method, 'POST');
      expect(request.body, '{"name":"photo"}');
      if (requestCount == 1) {
        throw http.ClientException('connection reset', request.url);
      }

      expect(request.url, Uri.parse('$newEndpoint/albums'));
      return http.Response('{}', 200);
    });
    final client = EndpointRefreshingClient(
      inner,
      (_) async => const EndpointChange(previousEndpoint: oldEndpoint, currentEndpoint: newEndpoint),
      () => oldEndpoint,
    );
    addTearDown(client.close);

    final response = await client.post(
      Uri.parse('$oldEndpoint/albums'),
      headers: const {'content-type': 'application/json'},
      body: '{"name":"photo"}',
    );

    expect(response.statusCode, 200);
    expect(requestCount, 2);
  });

  test('does not refresh or retry authentication and business failures', () async {
    var requestCount = 0;
    var refreshCount = 0;
    final inner = MockClient((request) async {
      requestCount++;
      return http.Response('unauthorized', 401);
    });
    final client = EndpointRefreshingClient(inner, (_) async {
      refreshCount++;
      return const EndpointChange(previousEndpoint: oldEndpoint, currentEndpoint: newEndpoint);
    }, () => oldEndpoint);
    addTearDown(client.close);

    final response = await client.get(Uri.parse('$oldEndpoint/users/me'));

    expect(response.statusCode, 401);
    expect(requestCount, 1);
    expect(refreshCount, 0);
  });

  test('returns the original failure when TXT refresh finds no endpoint', () async {
    var requestCount = 0;
    var refreshCount = 0;
    final inner = MockClient((request) async {
      requestCount++;
      return http.Response('bad gateway', 502);
    });
    final client = EndpointRefreshingClient(inner, (_) async {
      refreshCount++;
      return null;
    }, () => oldEndpoint);
    addTearDown(client.close);

    final response = await client.get(Uri.parse('$oldEndpoint/assets'));

    expect(response.statusCode, 502);
    expect(requestCount, 1);
    expect(refreshCount, 1);
  });
}
