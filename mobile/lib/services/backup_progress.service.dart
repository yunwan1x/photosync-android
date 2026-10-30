import 'dart:io';

import 'package:immich_mobile/platform/backup_progress_api.g.dart';

abstract interface class BackupProgressReporter {
  Future<void> reconcile({required int total, required int backedUp, required int remaining});

  Future<void> reconcileQueue({required Iterable<String> activeTaskIds, required Iterable<String> failedTaskIds});

  Future<void> enqueue(Iterable<String> taskIds);

  Future<void> markSucceeded(String taskId);

  Future<void> markRetrying(String taskId);

  Future<void> markFailed(String taskId);

  Future<void> markCanceled(String taskId);

  Future<void> updateFileProgress({
    required String taskId,
    required String filename,
    required int uploadedBytes,
    required int totalBytes,
  });

  Future<void> clearQueue();
}

class NativeBackupProgressReporter implements BackupProgressReporter {
  NativeBackupProgressReporter({BackupProgressHostApi? api}) : _api = api ?? BackupProgressHostApi();

  final BackupProgressHostApi _api;

  bool get _supported => Platform.isAndroid;

  @override
  Future<void> reconcile({required int total, required int backedUp, required int remaining}) async {
    if (_supported) {
      await _api.reconcile(total, backedUp, remaining);
    }
  }

  @override
  Future<void> reconcileQueue({
    required Iterable<String> activeTaskIds,
    required Iterable<String> failedTaskIds,
  }) async {
    if (!_supported) {
      return;
    }
    await _api.reconcileQueue(
      activeTaskIds.where((id) => id.isNotEmpty).toSet().toList(growable: false),
      failedTaskIds.where((id) => id.isNotEmpty).toSet().toList(growable: false),
    );
  }

  @override
  Future<void> enqueue(Iterable<String> taskIds) async {
    if (!_supported) {
      return;
    }
    final ids = taskIds.where((id) => id.isNotEmpty).toSet().toList(growable: false);
    if (ids.isNotEmpty) {
      await _api.enqueue(ids);
    }
  }

  @override
  Future<void> markSucceeded(String taskId) async {
    if (_supported) {
      await _api.markSucceeded(taskId);
    }
  }

  @override
  Future<void> markRetrying(String taskId) async {
    if (_supported) {
      await _api.markRetrying(taskId);
    }
  }

  @override
  Future<void> markFailed(String taskId) async {
    if (_supported) {
      await _api.markFailed(taskId);
    }
  }

  @override
  Future<void> markCanceled(String taskId) async {
    if (_supported) {
      await _api.markCanceled(taskId);
    }
  }

  @override
  Future<void> updateFileProgress({
    required String taskId,
    required String filename,
    required int uploadedBytes,
    required int totalBytes,
  }) async {
    if (_supported) {
      await _api.updateFileProgress(taskId, filename, uploadedBytes, totalBytes);
    }
  }

  @override
  Future<void> clearQueue() async {
    if (_supported) {
      await _api.clearQueue();
    }
  }
}
