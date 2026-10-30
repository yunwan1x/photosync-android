import 'dart:convert';

import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';

enum EndpointSelectionSource { local, external, txt, direct, unknown }

enum EndpointSelectionReason {
  coldStart,
  appResume,
  backgroundWorker,
  networkChange,
  requestFailure,
  availabilityProbe,
  manual,
}

enum EndpointValidationStatus { success, failed, cooldown, unchanged }

class EndpointSelectionDiagnostics {
  const EndpointSelectionDiagnostics({
    required this.source,
    required this.reason,
    required this.status,
    required this.checkedAt,
    this.candidateIndex,
    this.detail,
  });

  final EndpointSelectionSource source;
  final EndpointSelectionReason reason;
  final EndpointValidationStatus status;
  final DateTime checkedAt;
  final int? candidateIndex;
  final String? detail;

  Map<String, Object?> toJson() => {
    'source': source.name,
    'reason': reason.name,
    'status': status.name,
    'checkedAt': checkedAt.millisecondsSinceEpoch,
    'candidateIndex': candidateIndex,
    'detail': detail,
  };

  static EndpointSelectionDiagnostics? fromJson(String? value) {
    if (value == null || value.isEmpty) {
      return null;
    }

    try {
      final json = jsonDecode(value) as Map<String, dynamic>;
      return EndpointSelectionDiagnostics(
        source: EndpointSelectionSource.values.byName(json['source'] as String),
        reason: EndpointSelectionReason.values.byName(json['reason'] as String),
        status: EndpointValidationStatus.values.byName(json['status'] as String),
        checkedAt: DateTime.fromMillisecondsSinceEpoch(json['checkedAt'] as int),
        candidateIndex: json['candidateIndex'] as int?,
        detail: json['detail'] as String?,
      );
    } catch (_) {
      return null;
    }
  }
}

class EndpointSelectionDiagnosticsStore {
  const EndpointSelectionDiagnosticsStore._();

  static EndpointSelectionDiagnostics? read() =>
      EndpointSelectionDiagnostics.fromJson(Store.tryGet(StoreKey.endpointSelectionDiagnostics));

  static Future<void> record({
    required EndpointSelectionSource source,
    required EndpointSelectionReason reason,
    required EndpointValidationStatus status,
    int? candidateIndex,
    String? detail,
    DateTime? checkedAt,
  }) {
    final diagnostics = EndpointSelectionDiagnostics(
      source: source,
      reason: reason,
      status: status,
      checkedAt: checkedAt ?? DateTime.now(),
      candidateIndex: candidateIndex,
      detail: detail,
    );
    return Store.put(StoreKey.endpointSelectionDiagnostics, jsonEncode(diagnostics.toJson()));
  }
}
