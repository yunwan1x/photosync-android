import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

typedef TxtLookup = Future<List<String>> Function(String domain);

class TxtEndpointException implements Exception {
  const TxtEndpointException(this.message);

  final String message;

  @override
  String toString() => message;
}

class TxtEndpointService {
  TxtEndpointService() : _lookup = null;

  TxtEndpointService.withLookup(this._lookup);

  static const _channel = MethodChannel('app.alextran.immich/dns_txt');
  static const _lookupTimeout = Duration(seconds: 5);

  final TxtLookup? _lookup;

  static bool isTxtEndpoint(String value) => value.trimLeft().toLowerCase().startsWith('txt://');

  Future<String> resolve(String value) async {
    final candidates = await resolveCandidates(value);
    return candidates.first;
  }

  Future<List<String>> resolveCandidates(String value) async {
    final uri = Uri.tryParse(value.trim());
    if (!_isValidTxtUri(uri)) {
      throw const TxtEndpointException('Invalid txt:// server address');
    }

    final domain = uri!.host;
    List<String> records;
    try {
      records = await (_lookup ?? _lookupTxtRecords)(domain).timeout(_lookupTimeout);
    } on TxtEndpointException {
      rethrow;
    } catch (_) {
      throw const TxtEndpointException('DNS TXT lookup failed');
    }

    final candidates = records.map(_extractUrl).whereType<String>().toSet().toList(growable: false);
    if (candidates.isNotEmpty) {
      return candidates;
    }

    throw const TxtEndpointException('DNS TXT record does not contain an HTTP or HTTPS server address');
  }

  static bool _isValidTxtUri(Uri? uri) {
    if (uri == null || uri.scheme.toLowerCase() != 'txt' || uri.host.isEmpty || uri.hasPort || uri.hasQuery) {
      return false;
    }

    return uri.userInfo.isEmpty && uri.fragment.isEmpty && (uri.path.isEmpty || uri.path == '/');
  }

  static String? _extractUrl(String record) {
    var value = record.trim();
    final assignment = RegExp(r'^(?:url|server|immich)\s*=\s*(.+)$', caseSensitive: false).firstMatch(value);
    if (assignment != null) {
      value = assignment.group(1)!.trim();
    }

    final uri = Uri.tryParse(value);
    if (uri == null || uri.host.isEmpty || (uri.scheme != 'http' && uri.scheme != 'https')) {
      return null;
    }

    return value;
  }

  Future<List<String>> _lookupTxtRecords(String domain) async {
    try {
      final response = await _channel.invokeMethod<Uint8List>('queryTxt', {'domain': domain});
      if (response == null) {
        return const [];
      }
      return parseDnsTxtResponse(response);
    } on MissingPluginException {
      return _lookupTxtOverHttps(domain);
    } on PlatformException catch (error) {
      if (error.code == 'UNSUPPORTED') {
        return _lookupTxtOverHttps(domain);
      }
      throw TxtEndpointException(error.message ?? 'DNS TXT lookup failed');
    }
  }

  Future<List<String>> _lookupTxtOverHttps(String domain) async {
    final uri = Uri.https('dns.google', '/resolve', {'name': domain, 'type': 'TXT'});
    final http.Response response;
    try {
      response = await http.get(uri, headers: const {'accept': 'application/dns-json'});
    } catch (_) {
      throw const TxtEndpointException('DNS TXT lookup failed');
    }

    if (response.statusCode != 200) {
      throw const TxtEndpointException('DNS TXT lookup failed');
    }

    final Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } catch (_) {
      throw const TxtEndpointException('DNS TXT lookup returned an invalid response');
    }
    if (decoded is! Map<String, dynamic> || decoded['Status'] != 0) {
      throw const TxtEndpointException('DNS TXT lookup failed');
    }

    final answers = decoded['Answer'];
    if (answers is! List) {
      return const [];
    }

    return answers
        .whereType<Map<String, dynamic>>()
        .where((answer) => answer['type'] == 16 && answer['data'] is String)
        .map((answer) => decodeDnsTxtPresentation(answer['data'] as String))
        .toList(growable: false);
  }
}

List<String> parseDnsTxtResponse(Uint8List message) {
  if (message.length < 12) {
    throw const TxtEndpointException('DNS TXT response is incomplete');
  }

  final data = ByteData.sublistView(message);
  final questionCount = data.getUint16(4);
  final answerCount = data.getUint16(6);
  var offset = 12;

  for (var index = 0; index < questionCount; index++) {
    offset = _skipDnsName(message, offset);
    _requireBytes(message, offset, 4);
    offset += 4;
  }

  final records = <String>[];
  for (var index = 0; index < answerCount; index++) {
    offset = _skipDnsName(message, offset);
    _requireBytes(message, offset, 10);
    final type = data.getUint16(offset);
    final recordClass = data.getUint16(offset + 2);
    final length = data.getUint16(offset + 8);
    offset += 10;
    _requireBytes(message, offset, length);

    if (type == 16 && recordClass == 1) {
      final end = offset + length;
      final chunks = <int>[];
      while (offset < end) {
        final chunkLength = message[offset++];
        if (offset + chunkLength > end) {
          throw const TxtEndpointException('DNS TXT response is malformed');
        }
        chunks.addAll(message.sublist(offset, offset + chunkLength));
        offset += chunkLength;
      }
      records.add(utf8.decode(chunks, allowMalformed: true));
    } else {
      offset += length;
    }
  }

  return records;
}

String decodeDnsTxtPresentation(String value) {
  final trimmed = value.trim();
  if (!trimmed.startsWith('"')) {
    return trimmed;
  }

  final output = StringBuffer();
  var index = 0;
  while (index < trimmed.length) {
    while (index < trimmed.length && trimmed.codeUnitAt(index) <= 0x20) {
      index++;
    }
    if (index >= trimmed.length || trimmed[index] != '"') {
      return trimmed;
    }
    index++;

    while (index < trimmed.length && trimmed[index] != '"') {
      if (trimmed[index] != r'\') {
        output.write(trimmed[index++]);
        continue;
      }

      index++;
      if (index >= trimmed.length) {
        return trimmed;
      }
      final decimalEscape = index + 3 <= trimmed.length ? trimmed.substring(index, index + 3) : '';
      if (RegExp(r'^\d{3}$').hasMatch(decimalEscape)) {
        output.writeCharCode(int.parse(decimalEscape));
        index += 3;
      } else {
        output.write(trimmed[index++]);
      }
    }

    if (index >= trimmed.length) {
      return trimmed;
    }
    index++;
  }

  return output.toString();
}

int _skipDnsName(Uint8List message, int offset) {
  while (true) {
    _requireBytes(message, offset, 1);
    final length = message[offset++];
    if (length == 0) {
      return offset;
    }
    if ((length & 0xc0) == 0xc0) {
      _requireBytes(message, offset, 1);
      return offset + 1;
    }
    if ((length & 0xc0) != 0) {
      throw const TxtEndpointException('DNS TXT response is malformed');
    }
    _requireBytes(message, offset, length);
    offset += length;
  }
}

void _requireBytes(Uint8List message, int offset, int length) {
  if (offset < 0 || length < 0 || offset + length > message.length) {
    throw const TxtEndpointException('DNS TXT response is incomplete');
  }
}
