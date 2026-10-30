import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/models/network/endpoint_selection_diagnostics.model.dart';

void main() {
  test('round-trips endpoint selection diagnostics without credentials', () {
    final checkedAt = DateTime.fromMillisecondsSinceEpoch(123456789);
    final original = EndpointSelectionDiagnostics(
      source: EndpointSelectionSource.external,
      reason: EndpointSelectionReason.networkChange,
      status: EndpointValidationStatus.success,
      checkedAt: checkedAt,
      candidateIndex: 2,
      detail: 'External endpoint passed validation',
    );

    final restored = EndpointSelectionDiagnostics.fromJson(jsonEncode(original.toJson()));

    expect(restored?.source, EndpointSelectionSource.external);
    expect(restored?.reason, EndpointSelectionReason.networkChange);
    expect(restored?.status, EndpointValidationStatus.success);
    expect(restored?.checkedAt, checkedAt);
    expect(restored?.candidateIndex, 2);
    expect(jsonEncode(original.toJson()), isNot(contains('token')));
  });

  test('ignores malformed persisted diagnostics', () {
    expect(EndpointSelectionDiagnostics.fromJson('{not-json'), isNull);
    expect(EndpointSelectionDiagnostics.fromJson(null), isNull);
  });
}
