import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/services/txt_endpoint.service.dart';

void main() {
  group('TxtEndpointService', () {
    test('resolves a direct HTTPS address', () async {
      String? lookedUpDomain;
      final service = TxtEndpointService.withLookup((domain) async {
        lookedUpDomain = domain;
        return const ['https://photos.example.com:2283'];
      });

      final result = await service.resolve('txt://connect.example.com');

      expect(lookedUpDomain, 'connect.example.com');
      expect(result, 'https://photos.example.com:2283');
    });

    test('accepts url and immich assignments', () async {
      final urlService = TxtEndpointService.withLookup((_) async => const ['url=http://10.0.0.2:2283']);
      final immichService = TxtEndpointService.withLookup((_) async => const ['immich=https://photos.example.com/api']);

      expect(await urlService.resolve('txt://connect.example.com'), 'http://10.0.0.2:2283');
      expect(await immichService.resolve('txt://connect.example.com'), 'https://photos.example.com/api');
    });

    test('skips unrelated TXT records', () async {
      final service = TxtEndpointService.withLookup(
        (_) async => const ['v=spf1 -all', 'verification=123', 'https://photos.example.com'],
      );

      expect(await service.resolve('txt://connect.example.com'), 'https://photos.example.com');
    });

    test('returns all unique HTTP candidates in DNS order', () async {
      final service = TxtEndpointService.withLookup(
        (_) async => const [
          'v=spf1 -all',
          'url=https://primary.example.com',
          'https://secondary.example.com:2283',
          'server=https://primary.example.com',
        ],
      );

      expect(await service.resolveCandidates('txt://connect.example.com'), const [
        'https://primary.example.com',
        'https://secondary.example.com:2283',
      ]);
    });

    test('uses the latest TXT value on each lookup', () async {
      var value = 'http://10.0.0.2:2283';
      final service = TxtEndpointService.withLookup((_) async => [value]);

      expect(await service.resolve('txt://connect.example.com'), 'http://10.0.0.2:2283');
      value = 'http://10.0.0.3:2283';
      expect(await service.resolve('txt://connect.example.com'), 'http://10.0.0.3:2283');
    });

    test('does not classify direct HTTP or HTTPS addresses as TXT sources', () {
      expect(TxtEndpointService.isTxtEndpoint('http://10.0.0.2:2283'), isFalse);
      expect(TxtEndpointService.isTxtEndpoint('https://photos.example.com'), isFalse);
    });

    test('rejects invalid txt addresses', () async {
      final service = TxtEndpointService.withLookup((_) async => const ['https://photos.example.com']);

      for (final value in [
        'txt://',
        'txt://user@example.com',
        'txt://example.com:53',
        'txt://example.com/path',
        'txt://example.com?key=value',
      ]) {
        await expectLater(service.resolve(value), throwsA(isA<TxtEndpointException>()));
      }
    });

    test('rejects records without an HTTP or HTTPS address', () async {
      final service = TxtEndpointService.withLookup((_) async => const ['v=spf1 -all', 'ftp://example.com']);

      await expectLater(service.resolve('txt://connect.example.com'), throwsA(isA<TxtEndpointException>()));
    });
  });

  group('DNS TXT decoding', () {
    test('decodes TXT chunks from a raw DNS response', () {
      final response = _buildDnsTxtResponse(['https://photos.', 'example.com:2283']);

      expect(parseDnsTxtResponse(response), const ['https://photos.example.com:2283']);
    });

    test('decodes quoted DNS-over-HTTPS TXT presentation', () {
      expect(decodeDnsTxtPresentation(r'"https://photos." "example.com:2283"'), 'https://photos.example.com:2283');
      expect(decodeDnsTxtPresentation(r'"url=https://example.com/a\032b"'), 'url=https://example.com/a b');
    });

    test('rejects truncated raw DNS responses', () {
      expect(() => parseDnsTxtResponse(Uint8List(4)), throwsA(isA<TxtEndpointException>()));
    });
  });
}

Uint8List _buildDnsTxtResponse(List<String> chunks) {
  final question = <int>[
    7,
    ...ascii.encode('connect'),
    7,
    ...ascii.encode('example'),
    3,
    ...ascii.encode('com'),
    0,
    0,
    16,
    0,
    1,
  ];
  final record = <int>[];
  for (final chunk in chunks) {
    final bytes = utf8.encode(chunk);
    record
      ..add(bytes.length)
      ..addAll(bytes);
  }

  return Uint8List.fromList([
    0x12,
    0x34,
    0x81,
    0x80,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    0,
    ...question,
    0xc0,
    0x0c,
    0,
    16,
    0,
    1,
    0,
    0,
    0,
    60,
    record.length >> 8,
    record.length & 0xff,
    ...record,
  ]);
}
