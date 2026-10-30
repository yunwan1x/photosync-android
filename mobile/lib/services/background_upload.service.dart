import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/asset/asset_metadata.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/backup_batch_queue.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/infrastructure/repositories/backup.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/local_asset.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/storage.repository.dart';
import 'package:immich_mobile/platform/background_worker_api.g.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/storage.provider.dart';
import 'package:immich_mobile/repositories/asset_media.repository.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:immich_mobile/services/backup_progress.service.dart';
import 'package:immich_mobile/services/txt_endpoint.service.dart';
import 'package:immich_mobile/utils/debug_print.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart' as api;
import 'package:path/path.dart' as p;

enum BackgroundUploadHostMode { foreground, background }

final backgroundUploadHostModeProvider = Provider((ref) => BackgroundUploadHostMode.foreground);

final backgroundUploadServiceProvider = Provider((ref) {
  final service = BackgroundUploadService(
    ref.watch(uploadRepositoryProvider),
    ref.watch(storageRepositoryProvider),
    ref.watch(localAssetRepository),
    ref.watch(backupRepositoryProvider),
    ref.watch(assetMediaRepositoryProvider),
    null,
    ref.watch(backgroundUploadHostModeProvider),
  );

  ref.onDispose(service.dispose);
  return service;
});

enum BackupProgressEvent { none, succeeded, retrying, failed, canceled }

typedef BackupFileProgress = ({String taskId, String filename, int uploadedBytes, int totalBytes});

typedef BackupQueueReconciliation = ({Set<String> activeTaskIds, Set<String> failedTaskIds});

class ResumableEnqueueBatchResult {
  const ResumableEnqueueBatchResult({
    required this.acceptedCount,
    required this.deferredCount,
    this.failedTaskId,
    this.failedPhase,
    this.error,
  });

  final int acceptedCount;
  final int deferredCount;
  final String? failedTaskId;
  final String? failedPhase;
  final Object? error;

  bool get succeeded => error == null;
}

@visibleForTesting
Future<ResumableEnqueueBatchResult> enqueueResumableRequestsSequentially({
  required List<ResumableUploadRequest> requests,
  required Future<void> Function(List<ResumableUploadRequest>) enqueueNative,
  required Future<void> Function(String taskId) confirmProgress,
}) async {
  for (var index = 0; index < requests.length; index++) {
    final request = requests[index];
    try {
      await enqueueNative([request]);
    } catch (error) {
      return ResumableEnqueueBatchResult(
        acceptedCount: index,
        deferredCount: requests.length - index,
        failedTaskId: request.taskId,
        failedPhase: 'native',
        error: error,
      );
    }

    try {
      await confirmProgress(request.taskId);
    } catch (error) {
      return ResumableEnqueueBatchResult(
        acceptedCount: index + 1,
        deferredCount: requests.length - index - 1,
        failedTaskId: request.taskId,
        failedPhase: 'progress',
        error: error,
      );
    }
  }

  return ResumableEnqueueBatchResult(acceptedCount: requests.length, deferredCount: 0);
}

@visibleForTesting
BackupQueueReconciliation buildBackupQueueReconciliation({
  required Iterable<String> downloaderTaskIds,
  required Iterable<String> resumableTaskIds,
  required Iterable<String> failedTaskIds,
}) {
  final active = {...downloaderTaskIds.where((id) => id.isNotEmpty), ...resumableTaskIds.where((id) => id.isNotEmpty)};
  return (
    activeTaskIds: active,
    failedTaskIds: failedTaskIds.where((id) => id.isNotEmpty && !active.contains(id)).toSet(),
  );
}

typedef BackgroundQueueEventSink = Future<void> Function(String event, String? detail);

class BackgroundQueueStepTimeoutException implements Exception {
  const BackgroundQueueStepTimeoutException(this.step, this.timeout);

  final String step;
  final Duration timeout;

  @override
  String toString() => 'Background queue step "$step" timed out after ${timeout.inMilliseconds}ms';
}

class BackgroundQueueDiagnostics {
  BackgroundQueueDiagnostics({
    required this.eventSink,
    this.defaultTimeout = const Duration(seconds: 20),
    this.heartbeatInterval = const Duration(seconds: 30),
    this.eventTimeout = const Duration(seconds: 2),
  });

  final BackgroundQueueEventSink eventSink;
  final Duration defaultTimeout;
  final Duration heartbeatInterval;
  final Duration eventTimeout;

  Future<T> runStep<T>(String step, Future<T> Function() operation, {Duration? timeout, String? context}) async {
    final effectiveTimeout = timeout ?? defaultTimeout;
    final stopwatch = Stopwatch()..start();
    await _emit('queue_step_start', _detail(step, context));
    final heartbeat = Timer.periodic(heartbeatInterval, (_) {
      unawaited(_emit('queue_step_heartbeat', _detail(step, context, elapsedMs: stopwatch.elapsedMilliseconds)));
    });

    try {
      final result = await operation().timeout(effectiveTimeout);
      heartbeat.cancel();
      await _emit('queue_step_complete', _detail(step, context, elapsedMs: stopwatch.elapsedMilliseconds));
      return result;
    } on TimeoutException {
      heartbeat.cancel();
      await _emit(
        'queue_step_timeout',
        _detail(
          step,
          context,
          elapsedMs: stopwatch.elapsedMilliseconds,
          suffix: 'limitMs=${effectiveTimeout.inMilliseconds}',
        ),
      );
      throw BackgroundQueueStepTimeoutException(step, effectiveTimeout);
    } catch (error) {
      heartbeat.cancel();
      await _emit(
        'queue_step_failed',
        _detail(step, context, elapsedMs: stopwatch.elapsedMilliseconds, suffix: '${error.runtimeType}'),
      );
      rethrow;
    } finally {
      heartbeat.cancel();
      stopwatch.stop();
    }
  }

  Future<void> record(String event, String detail) => _emit(event, detail);

  Future<void> _emit(String event, String detail) async {
    try {
      await eventSink(event, detail).timeout(eventTimeout);
    } catch (_) {
      // Diagnostics must never become another reason for backup queueing to stall.
    }
  }

  String _detail(String step, String? context, {int? elapsedMs, String? suffix}) {
    return [
      'step=$step',
      if (context != null && context.isNotEmpty) context,
      if (elapsedMs != null) 'elapsedMs=$elapsedMs',
      if (suffix != null && suffix.isNotEmpty) suffix,
    ].join(' ');
  }
}

@visibleForTesting
String anonymousBackupAssetId(String assetId) => sha256.convert(utf8.encode(assetId)).toString().substring(0, 12);

@visibleForTesting
BackupProgressEvent backupProgressEventFor(TaskStatusUpdate update) {
  switch (update.status) {
    case TaskStatus.complete:
      return isIntermediateLivePhotoTask(update.task) ? BackupProgressEvent.none : BackupProgressEvent.succeeded;
    case TaskStatus.waitingToRetry:
      return BackupProgressEvent.retrying;
    case TaskStatus.failed:
    case TaskStatus.notFound:
      return BackupProgressEvent.failed;
    case TaskStatus.canceled:
      return BackupProgressEvent.canceled;
    case TaskStatus.paused:
    case TaskStatus.enqueued:
    case TaskStatus.running:
      return BackupProgressEvent.none;
  }
}

@visibleForTesting
bool isIntermediateLivePhotoTask(Task task) {
  if (task.group != kBackupGroup || task.metaData.isEmpty) {
    return false;
  }
  try {
    return UploadTaskMetadata.fromJson(task.metaData).isLivePhotos;
  } catch (_) {
    return false;
  }
}

@visibleForTesting
BackupFileProgress? backupFileProgressFor(TaskProgressUpdate update) {
  if (update.progress < 0 || update.expectedFileSize <= 0) {
    return null;
  }
  return (
    taskId: update.task.taskId,
    filename: update.task.displayName,
    uploadedBytes: (update.expectedFileSize * update.progress.clamp(0.0, 1.0)).round(),
    totalBytes: update.expectedFileSize,
  );
}

/// Metadata for upload tasks to track live photo handling
class UploadTaskMetadata {
  final String localAssetId;
  final bool isLivePhotos;
  final String livePhotoVideoId;
  final int txtRefreshRetryCount;

  const UploadTaskMetadata({
    required this.localAssetId,
    required this.isLivePhotos,
    required this.livePhotoVideoId,
    this.txtRefreshRetryCount = 0,
  });

  UploadTaskMetadata copyWith({
    String? localAssetId,
    bool? isLivePhotos,
    String? livePhotoVideoId,
    int? txtRefreshRetryCount,
  }) {
    return UploadTaskMetadata(
      localAssetId: localAssetId ?? this.localAssetId,
      isLivePhotos: isLivePhotos ?? this.isLivePhotos,
      livePhotoVideoId: livePhotoVideoId ?? this.livePhotoVideoId,
      txtRefreshRetryCount: txtRefreshRetryCount ?? this.txtRefreshRetryCount,
    );
  }

  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'localAssetId': localAssetId,
      'isLivePhotos': isLivePhotos,
      'livePhotoVideoId': livePhotoVideoId,
      'txtRefreshRetryCount': txtRefreshRetryCount,
    };
  }

  factory UploadTaskMetadata.fromMap(Map<String, dynamic> map) {
    return UploadTaskMetadata(
      localAssetId: map['localAssetId'] as String,
      isLivePhotos: map['isLivePhotos'] as bool,
      livePhotoVideoId: map['livePhotoVideoId'] as String,
      txtRefreshRetryCount: map['txtRefreshRetryCount'] as int? ?? 0,
    );
  }

  String toJson() => json.encode(toMap());

  factory UploadTaskMetadata.fromJson(String source) =>
      UploadTaskMetadata.fromMap(json.decode(source) as Map<String, dynamic>);

  @override
  String toString() =>
      'UploadTaskMetadata(localAssetId: $localAssetId, isLivePhotos: $isLivePhotos, '
      'livePhotoVideoId: $livePhotoVideoId, txtRefreshRetryCount: $txtRefreshRetryCount)';

  @override
  bool operator ==(covariant UploadTaskMetadata other) {
    if (identical(this, other)) {
      return true;
    }

    return other.localAssetId == localAssetId &&
        other.isLivePhotos == isLivePhotos &&
        other.livePhotoVideoId == livePhotoVideoId &&
        other.txtRefreshRetryCount == txtRefreshRetryCount;
  }

  @override
  int get hashCode =>
      localAssetId.hashCode ^ isLivePhotos.hashCode ^ livePhotoVideoId.hashCode ^ txtRefreshRetryCount.hashCode;
}

/// Service for handling background uploads using iOS URLSession (background_downloader)
///
/// This service handles asynchronous background uploads that can continue
/// even when the app is suspended. Primarily used for iOS background backup.
class BackgroundUploadService {
  static const _resumableUploadThreshold = 64 * 1024 * 1024;
  static const _candidateBatchSize = 100;
  static const _queueHighWatermark = 300;
  static const _queueingBudget = Duration(minutes: 6);

  BackgroundUploadService(
    this._uploadRepository,
    this._storageRepository,
    this._localAssetRepository,
    this._backupRepository,
    this._assetMediaRepository, [
    BackupProgressReporter? progressReporter,
    this._hostMode = BackgroundUploadHostMode.foreground,
  ]) : _progressReporter = progressReporter ?? NativeBackupProgressReporter() {
    _uploadRepository.onUploadStatus = _onUploadCallback;
    _uploadRepository.onTaskProgress = _onTaskProgressCallback;
  }

  final UploadRepository _uploadRepository;
  final StorageRepository _storageRepository;
  final DriftLocalAssetRepository _localAssetRepository;
  final DriftBackupRepository _backupRepository;
  final AssetMediaRepository _assetMediaRepository;
  final BackupProgressReporter _progressReporter;
  final BackgroundUploadHostMode _hostMode;
  final Logger _logger = Logger('BackgroundUploadService');

  final StreamController<TaskStatusUpdate> _taskStatusController = StreamController<TaskStatusUpdate>.broadcast();
  final StreamController<TaskProgressUpdate> _taskProgressController = StreamController<TaskProgressUpdate>.broadcast();

  Stream<TaskStatusUpdate> get taskStatusStream => _taskStatusController.stream;
  Stream<TaskProgressUpdate> get taskProgressStream => _taskProgressController.stream;

  bool shouldAbortQueuingTasks = false;
  bool _downloaderResumeAttempted = false;
  final Map<String, DateTime> _networkPolicyReplacementTimes = {};
  Future<void> _networkPolicyRefresh = Future<void>.value();

  void abortQueuing() {
    shouldAbortQueuingTasks = true;
  }

  void _onTaskProgressCallback(TaskProgressUpdate update) {
    if (!_taskProgressController.isClosed) {
      _taskProgressController.add(update);
    }
    final progress = backupFileProgressFor(update);
    if (_isBackupTask(update.task) && progress != null) {
      unawaited(
        _progressReporter.updateFileProgress(
          taskId: progress.taskId,
          filename: progress.filename,
          uploadedBytes: progress.uploadedBytes,
          totalBytes: progress.totalBytes,
        ),
      );
    }
  }

  void _onUploadCallback(TaskStatusUpdate update) {
    unawaited(_processUploadStatus(update));
  }

  Future<void> _processUploadStatus(TaskStatusUpdate update) async {
    if (shouldAbortQueuingTasks && _isBackupTask(update.task)) {
      return;
    }
    if (await _retryAfterTxtRefresh(update)) {
      if (_isBackupTask(update.task)) {
        await _progressReporter.markRetrying(update.task.taskId);
      }
      return;
    }
    if (!_taskStatusController.isClosed) {
      _taskStatusController.add(update);
    }
    _handleTaskStatusUpdate(update);
    if (_isBackupTask(update.task)) {
      await _updateProgressForStatus(update);
    }
  }

  Future<void> _updateProgressForStatus(TaskStatusUpdate update) async {
    final replacementTime = _networkPolicyReplacementTimes[update.task.taskId];
    if (update.status == TaskStatus.canceled &&
        replacementTime != null &&
        update.task.creationTime != replacementTime) {
      _logger.fine('Ignoring the canceled callback for replaced task ${update.task.taskId}');
      return;
    }
    switch (backupProgressEventFor(update)) {
      case BackupProgressEvent.succeeded:
        await _progressReporter.markSucceeded(update.task.taskId);
        _networkPolicyReplacementTimes.remove(update.task.taskId);
        break;
      case BackupProgressEvent.retrying:
        await _progressReporter.markRetrying(update.task.taskId);
        break;
      case BackupProgressEvent.failed:
        await _progressReporter.markFailed(update.task.taskId);
        _networkPolicyReplacementTimes.remove(update.task.taskId);
        break;
      case BackupProgressEvent.canceled:
        await _progressReporter.markCanceled(update.task.taskId);
        _networkPolicyReplacementTimes.remove(update.task.taskId);
        break;
      case BackupProgressEvent.none:
        break;
    }
  }

  Future<bool> _retryAfterTxtRefresh(TaskStatusUpdate update) async {
    if (shouldAbortQueuingTasks) {
      return false;
    }
    if (update.status != TaskStatus.failed || update.task is! UploadTask || !_isRetryableFailure(update)) {
      return false;
    }
    final source = Store.tryGet(StoreKey.serverUrl);
    if (source == null || !TxtEndpointService.isTxtEndpoint(source)) {
      return false;
    }

    final task = update.task as UploadTask;
    UploadTaskMetadata metadata;
    try {
      metadata = task.metaData.isEmpty
          ? UploadTaskMetadata(localAssetId: task.taskId, isLivePhotos: false, livePhotoVideoId: '')
          : UploadTaskMetadata.fromJson(task.metaData);
    } catch (_) {
      return false;
    }
    if (metadata.txtRefreshRetryCount >= 1) {
      return false;
    }

    final failedEndpoint = _endpointFromUploadUrl(task.url);
    final change = await NetworkRepository.refreshEndpoint(failedEndpoint);
    if (change == null) {
      return false;
    }

    final retry = task.copyWith(
      url: '${change.currentEndpoint}/assets',
      metaData: metadata.copyWith(txtRefreshRetryCount: metadata.txtRefreshRetryCount + 1).toJson(),
      retries: 3,
      retriesRemaining: 3,
      creationTime: DateTime.now(),
    );
    final enqueued = await _uploadRepository.replaceFailedBackgroundUpload(retry);
    if (enqueued) {
      _logger.info('Re-enqueued ${task.taskId} after TXT endpoint refresh');
    }
    return enqueued;
  }

  bool _isRetryableFailure(TaskStatusUpdate update) {
    final exception = update.exception;
    return exception is TaskConnectionException ||
        (exception is TaskHttpException && const {502, 503, 504}.contains(exception.httpResponseCode)) ||
        const {502, 503, 504}.contains(update.responseStatusCode);
  }

  bool _isBackupTask(Task task) => const {kBackupGroup, kBackupLivePhotoGroup}.contains(task.group);

  String _endpointFromUploadUrl(String value) {
    final uri = Uri.parse(value);
    final assetIndex = uri.path.lastIndexOf('/assets');
    final endpointPath = assetIndex < 0 ? uri.path : uri.path.substring(0, assetIndex);
    return uri.replace(path: endpointPath, query: null, fragment: null).toString().replaceFirst(RegExp(r'/+$'), '');
  }

  void dispose() {
    _taskStatusController.close();
    _taskProgressController.close();
  }

  /// Enqueue tasks to the background upload queue
  Future<List<bool>> enqueueTasks(List<UploadTask> tasks) {
    return _uploadRepository.enqueueBackgroundAll(tasks);
  }

  /// Get a list of tasks that are ENQUEUED or RUNNING
  Future<List<Task>> getActiveTasks(String group) {
    return _uploadRepository.getActiveTasks(group);
  }

  /// Start background upload using iOS URLSession
  ///
  /// Finds backup candidates, builds upload tasks, and enqueues them
  /// for background processing.
  Future<void> uploadBackupCandidates(
    String userId, {
    Future<bool> Function()? availabilityProbe,
    BackgroundQueueDiagnostics? diagnostics,
  }) async {
    final startedAt = DateTime.now();
    await _runQueueStep(
      diagnostics,
      'cache-clear',
      _storageRepository.clearCache,
      timeout: _queueStepTimeout(startedAt, const Duration(seconds: 10)),
    );
    if (!SettingsRepository.instance.appConfig.backup.enabled) {
      _logger.info('Backup is disabled, skipping background upload queueing');
      await _runQueueStep(
        diagnostics,
        'pending-state',
        () => _setPersistentPendingState(false),
        timeout: const Duration(seconds: 5),
        context: 'pending=false',
      );
      return;
    }
    shouldAbortQueuingTasks = false;
    final counts = await _runQueueStep(
      diagnostics,
      'backup-counts',
      () => _backupRepository.getAllCounts(userId),
      timeout: _queueStepTimeout(startedAt, const Duration(seconds: 15)),
    );
    await _runQueueStep(
      diagnostics,
      'progress-reconcile',
      () => reconcileProgress(
        total: counts.total,
        backedUp: counts.total - counts.remainder,
        remaining: counts.remainder,
      ),
      timeout: _queueStepTimeout(startedAt, const Duration(seconds: 10)),
      context: 'total=${counts.total} remaining=${counts.remainder}',
    );
    await _runQueueStep(
      diagnostics,
      'network-policy-refresh',
      () => refreshUploadNetworkPolicy(diagnostics: diagnostics),
      timeout: _queueStepTimeout(startedAt, const Duration(seconds: 30)),
    );
    final activeTaskGroups = await _runQueueStep(
      diagnostics,
      'active-task-query',
      () => Future.wait([getActiveTasks(kBackupGroup), getActiveTasks(kBackupLivePhotoGroup)]),
      timeout: _queueStepTimeout(startedAt, const Duration(seconds: 15)),
    );
    final failedTaskIds = await _runQueueStep(diagnostics, 'failed-task-query', () async {
      final groups = await Future.wait([
        _uploadRepository.getFailedTasks(kBackupGroup),
        _uploadRepository.getFailedTasks(kBackupLivePhotoGroup),
      ]);
      return groups.expand((tasks) => tasks).map((task) => task.taskId).toSet();
    }, timeout: _queueStepTimeout(startedAt, const Duration(seconds: 15)));
    final downloaderTaskIds = activeTaskGroups.expand((tasks) => tasks).map((task) => task.taskId).toSet();
    var resumableTaskIds = const <String>[];
    if (CurrentPlatform.isAndroid) {
      resumableTaskIds = await _runQueueStep(
        diagnostics,
        'resumable-task-query',
        _getPendingResumableUploadIds,
        timeout: _queueStepTimeout(startedAt, const Duration(seconds: 10)),
      );
    }
    final queueReconciliation = buildBackupQueueReconciliation(
      downloaderTaskIds: downloaderTaskIds,
      resumableTaskIds: resumableTaskIds,
      failedTaskIds: failedTaskIds,
    );
    final queuedIds = queueReconciliation.activeTaskIds;
    await _runQueueStep(
      diagnostics,
      'queue-progress-reconcile',
      () =>
          _progressReporter.reconcileQueue(activeTaskIds: queuedIds, failedTaskIds: queueReconciliation.failedTaskIds),
      timeout: _queueStepTimeout(startedAt, const Duration(seconds: 10)),
      context: 'active=${queuedIds.length} failed=${queueReconciliation.failedTaskIds.length}',
    );
    final planner = BackupBatchPlanner(
      initialQueuedIds: queuedIds,
      batchSize: _candidateBatchSize,
      queueHighWatermark: _queueHighWatermark,
    );

    var queuedThisRun = 0;
    var deferredThisRun = 0;

    while (!shouldAbortQueuingTasks && SettingsRepository.instance.appConfig.backup.enabled) {
      if (DateTime.now().difference(startedAt) >= _queueingBudget) {
        _logger.info('Stopping backup queue fill at the background runtime budget');
        break;
      }

      final batchLimit = planner.nextBatchLimit;
      if (batchLimit <= 0) {
        _logger.info('Stopping backup queue fill at the $_queueHighWatermark task high watermark');
        break;
      }

      if (availabilityProbe != null &&
          !await _runQueueStep(
            diagnostics,
            'availability-probe',
            availabilityProbe,
            timeout: _queueStepTimeout(startedAt, const Duration(seconds: 15)),
            context: 'batch=${planner.batchCount + 1}',
          )) {
        _logger.info('Server became unavailable while filling backup batches');
        break;
      }

      final batchNumber = planner.batchCount + 1;
      final candidates = await _runQueueStep(
        diagnostics,
        'candidate-query',
        () => _backupRepository.getCandidates(userId, excludeIds: planner.queuedIds, limit: batchLimit),
        timeout: _queueStepTimeout(startedAt, const Duration(seconds: 20)),
        context: 'batch=$batchNumber limit=$batchLimit excluded=${planner.queuedIds.length}',
      );
      planner.recordPage(candidates.map((asset) => asset.id), requestedLimit: batchLimit);
      if (candidates.isEmpty) {
        break;
      }

      _logger.info('Preparing ${candidates.length} backup candidates in the next batch');
      final tasks = <UploadTask>[];
      final resumableTasks = <ResumableUploadRequest>[];

      for (final asset in candidates) {
        if (shouldAbortQueuingTasks) {
          break;
        }
        final remaining = _queueStepTimeout(startedAt, const Duration(seconds: 15));
        if (remaining <= Duration.zero) {
          break;
        }
        final assetContext =
            'batch=$batchNumber item=${anonymousBackupAssetId(asset.id)} type=${asset.isVideo ? 'video' : 'photo'}';
        try {
          if (failedTaskIds.remove(asset.id)) {
            await _runQueueStep(
              diagnostics,
              'failed-task-delete',
              () => _uploadRepository.deleteTaskRecord(asset.id),
              timeout: _queueStepTimeout(startedAt, const Duration(seconds: 10)),
              context: assetContext,
            );
          }
          final task = await getUploadTask(
            asset,
            diagnostics: diagnostics,
            diagnosticContext: assetContext,
            timeout: remaining,
          );
          if (task == null) {
            deferredThisRun++;
            continue;
          }
          final filePath = await _runQueueStep(
            diagnostics,
            'asset-task-path',
            task.filePath,
            timeout: _queueStepTimeout(startedAt, const Duration(seconds: 10)),
            context: assetContext,
          );
          final fileSize = await _runQueueStep(
            diagnostics,
            'asset-file-size',
            () => File(filePath).length(),
            timeout: _queueStepTimeout(startedAt, const Duration(seconds: 10)),
            context: assetContext,
          );
          if (CurrentPlatform.isAndroid &&
              asset.isVideo &&
              fileSize >= _resumableUploadThreshold &&
              asset.checksum != null) {
            resumableTasks.add(
              ResumableUploadRequest(
                taskId: asset.id,
                serverUrl: Store.get(StoreKey.serverEndpoint),
                serverUrlSource: Store.get(StoreKey.serverUrl, Store.get(StoreKey.serverEndpoint)),
                filePath: filePath,
                filename: task.fields['filename'] ?? task.displayName,
                fileSize: fileSize,
                checksum: asset.checksum!,
                headers: task.headers,
                fields: task.fields,
                requiresWifi: task.requiresWiFi,
              ),
            );
          } else {
            tasks.add(task);
          }
        } catch (error) {
          deferredThisRun++;
          await diagnostics?.record(
            error is BackgroundQueueStepTimeoutException ? 'queue_asset_deferred' : 'queue_asset_failed',
            '$assetContext reason=${error.runtimeType}',
          );
          _logger.warning('Deferring backup candidate ${anonymousBackupAssetId(asset.id)} after ${error.runtimeType}');
        }
      }

      if (tasks.isNotEmpty && !shouldAbortQueuingTasks) {
        _logger.info('Enqueuing ${tasks.length} background upload tasks');
        await _runQueueStep(
          diagnostics,
          'regular-progress-enqueue',
          () => _progressReporter.enqueue(tasks.map((task) => task.taskId)),
          timeout: _queueStepTimeout(startedAt, const Duration(seconds: 10)),
          context: 'batch=$batchNumber count=${tasks.length}',
        );
        final results = await _runQueueStep(
          diagnostics,
          'regular-native-enqueue',
          () => enqueueTasks(tasks),
          timeout: _queueStepTimeout(startedAt, const Duration(seconds: 20)),
          context: 'batch=$batchNumber count=${tasks.length}',
        );
        if (results.any((enqueued) => !enqueued)) {
          for (var index = 0; index < results.length; index++) {
            if (!results[index]) {
              await _progressReporter.markCanceled(tasks[index].taskId);
            }
          }
          throw StateError('One or more background upload tasks could not be persisted');
        }
        queuedThisRun += tasks.length;
      }

      if (resumableTasks.isNotEmpty && !shouldAbortQueuingTasks) {
        _logger.info('Enqueuing ${resumableTasks.length} resumable Android uploads');
        final result = await _runQueueStep(
          diagnostics,
          'resumable-sequential-enqueue',
          () => enqueueResumableRequestsSequentially(
            requests: resumableTasks,
            enqueueNative: _enqueueResumableUploads,
            confirmProgress: (taskId) => _progressReporter.enqueue([taskId]),
          ),
          timeout: _queueStepTimeout(startedAt, Duration(seconds: 20 * resumableTasks.length)),
          context: 'batch=$batchNumber count=${resumableTasks.length}',
        );
        queuedThisRun += result.acceptedCount;
        if (!result.succeeded) {
          deferredThisRun += result.deferredCount;
          await diagnostics?.record(
            'resumable_enqueue_deferred',
            'batch=$batchNumber item=${anonymousBackupAssetId(result.failedTaskId ?? '')} '
                'phase=${result.failedPhase} accepted=${result.acceptedCount} deferred=${result.deferredCount} '
                'reason=${result.error.runtimeType}',
          );
          _logger.warning(
            'Stopping this queue pass after resumable ${result.failedPhase} enqueue failed; '
            '${result.deferredCount} candidates remain deferred',
          );
          break;
        }
      }

      if (!planner.hasMoreCandidates) {
        break;
      }
    }

    final hasQueuedWork = planner.queuedIds.isNotEmpty;
    await _runQueueStep(
      diagnostics,
      'pending-state',
      () => _setPersistentPendingState(planner.hasMoreCandidates || hasQueuedWork || deferredThisRun > 0),
      timeout: const Duration(seconds: 5),
      context:
          'pending=${planner.hasMoreCandidates || hasQueuedWork || deferredThisRun > 0} '
          'queued=$queuedThisRun deferred=$deferredThisRun',
    );
    await diagnostics?.record(
      'queue_pass_summary',
      'batches=${planner.batchCount} queued=$queuedThisRun deferred=$deferredThisRun existing=${queuedIds.length}',
    );
    _logger.info('Queued $queuedThisRun backup assets across consecutive batches');
  }

  Future<T> _runQueueStep<T>(
    BackgroundQueueDiagnostics? diagnostics,
    String step,
    Future<T> Function() operation, {
    required Duration timeout,
    String? context,
  }) {
    if (diagnostics == null) {
      return operation();
    }
    return diagnostics.runStep(step, operation, timeout: timeout, context: context);
  }

  Duration _queueStepTimeout(DateTime startedAt, Duration preferred) {
    final remaining = _queueingBudget - DateTime.now().difference(startedAt);
    if (remaining <= Duration.zero) {
      return Duration.zero;
    }
    return remaining < preferred ? remaining : preferred;
  }

  Future<void> _setPersistentPendingState(bool hasPending) async {
    if (CurrentPlatform.isAndroid) {
      if (_hostMode == BackgroundUploadHostMode.foreground) {
        await BackgroundWorkerFgHostApi().setBackupPendingState(hasPending);
      } else {
        await BackgroundWorkerBgHostApi().setBackupPendingState(hasPending);
      }
    }
  }

  Future<List<String>> _getPendingResumableUploadIds() async {
    if (_hostMode == BackgroundUploadHostMode.foreground) {
      return BackgroundWorkerFgHostApi().getPendingResumableUploadIds();
    }
    return BackgroundWorkerBgHostApi().getPendingResumableUploadIds();
  }

  Future<void> _enqueueResumableUploads(List<ResumableUploadRequest> requests) async {
    if (_hostMode == BackgroundUploadHostMode.foreground) {
      await BackgroundWorkerFgHostApi().enqueueResumableUploads(requests);
    } else {
      await BackgroundWorkerBgHostApi().enqueueResumableUploads(requests);
    }
  }

  Future<void> refreshUploadNetworkPolicy({
    BackgroundQueueDiagnostics? diagnostics,
    bool? useCellularForVideos,
    bool? useCellularForPhotos,
  }) async {
    final refresh = _networkPolicyRefresh.then(
      (_) => _refreshUploadNetworkPolicy(
        diagnostics,
        useCellularForVideos: useCellularForVideos,
        useCellularForPhotos: useCellularForPhotos,
      ),
    );
    _networkPolicyRefresh = refresh.then<void>((_) {}, onError: (_, _) {});
    return refresh;
  }

  Future<void> _refreshUploadNetworkPolicy(
    BackgroundQueueDiagnostics? diagnostics, {
    bool? useCellularForVideos,
    bool? useCellularForPhotos,
  }) async {
    final desiredVideoWifi =
        !(useCellularForVideos ?? SettingsRepository.instance.appConfig.backup.useCellularForVideos);
    final desiredPhotoWifi =
        !(useCellularForPhotos ?? SettingsRepository.instance.appConfig.backup.useCellularForPhotos);
    var checked = 0;
    var rescheduled = 0;
    var unchanged = 0;
    var runningKept = 0;
    var missingAssets = 0;

    final groups = await Future.wait([
      _uploadRepository.getActiveTaskRecords(kBackupGroup),
      _uploadRepository.getActiveTaskRecords(kBackupLivePhotoGroup),
    ]);
    for (final record in groups.expand((records) => records)) {
      final task = record.task;
      if (task is! UploadTask) {
        continue;
      }
      checked++;
      final asset = await _localAssetRepository.getById(task.taskId);
      if (asset == null) {
        missingAssets++;
        continue;
      }
      final desiredRequiresWifi = asset.isVideo ? desiredVideoWifi : desiredPhotoWifi;
      final action = backupNetworkPolicyAction(
        currentRequiresWifi: task.requiresWiFi,
        desiredRequiresWifi: desiredRequiresWifi,
        status: record.status,
      );
      switch (action) {
        case BackupNetworkPolicyAction.unchanged:
          unchanged++;
          continue;
        case BackupNetworkPolicyAction.leaveRunning:
          runningKept++;
          continue;
        case BackupNetworkPolicyAction.reschedule:
          final replacement = task.copyWith(requiresWiFi: desiredRequiresWifi, creationTime: DateTime.now());
          _networkPolicyReplacementTimes[task.taskId] = replacement.creationTime;
          final replaced = record.status == TaskStatus.paused
              ? await _uploadRepository.rebuildInactiveBackgroundUpload(replacement)
              : await _uploadRepository.replaceActiveBackgroundUpload(replacement);
          if (!replaced) {
            _networkPolicyReplacementTimes.remove(task.taskId);
            throw StateError('Could not replace upload task ${task.taskId} with its latest network policy');
          }
          if (record.status == TaskStatus.paused) {
            await diagnostics?.record(
              'regular_task_recovered',
              'task=${anonymousBackupAssetId(task.taskId)} previous=paused requiresWifi=$desiredRequiresWifi',
            );
          }
          await _progressReporter.enqueue([task.taskId]);
          rescheduled++;
      }
    }

    var resumableRescheduled = 0;
    if (CurrentPlatform.isAndroid) {
      resumableRescheduled = await _refreshResumableUploadNetworkPolicy(desiredVideoWifi);
    }
    final detail =
        'regularChecked=$checked regularRescheduled=$rescheduled unchanged=$unchanged '
        'runningKept=$runningKept missingAssets=$missingAssets resumableRescheduled=$resumableRescheduled '
        'photoWifi=$desiredPhotoWifi videoWifi=$desiredVideoWifi';
    _logger.info('Backup network policy refresh: $detail');
    await diagnostics?.record('network_policy_refresh', detail);
  }

  Future<int> _refreshResumableUploadNetworkPolicy(bool requiresWifi) async {
    if (_hostMode == BackgroundUploadHostMode.foreground) {
      return BackgroundWorkerFgHostApi().refreshResumableUploadNetworkPolicy(requiresWifi);
    }
    return BackgroundWorkerBgHostApi().refreshResumableUploadNetworkPolicy(requiresWifi);
  }

  @visibleForTesting
  Future<void> reconcileConfirmedRegularUploads(String userId) async {
    // A terminal callback can be lost when the background Flutter engine stops.
    // Only retire records whose content is confirmed in this user's remote assets.
    final groups = await Future.wait([
      _uploadRepository.getActiveTasks(kBackupGroup),
      _uploadRepository.getFailedTasks(kBackupGroup),
    ]);
    final checksums = <String, String>{};
    for (final task in groups.expand((tasks) => tasks)) {
      if (task.metaData.isEmpty) {
        continue;
      }
      UploadTaskMetadata? metadata;
      try {
        metadata = UploadTaskMetadata.fromJson(task.metaData);
      } on FormatException {
        continue;
      } on TypeError {
        continue;
      }
      if (metadata.isLivePhotos) {
        continue;
      }
      final asset = await _localAssetRepository.getById(metadata.localAssetId);
      final checksum = asset?.checksum;
      if (checksum != null && checksum.isNotEmpty) {
        checksums[task.taskId] = checksum;
      }
    }
    final confirmed = await _backupRepository.getConfirmedUploadIds(userId, checksums);
    for (final taskId in confirmed) {
      await _uploadRepository.deleteTaskRecord(taskId);
      await _progressReporter.markSucceeded(taskId);
    }
  }

  Future<void> reconcileCompletedResumableUploads(String userId) async {
    if (!CurrentPlatform.isAndroid) {
      return;
    }
    await reconcileConfirmedRegularUploads(userId);
    final Map<String, String> completed;
    if (_hostMode == BackgroundUploadHostMode.foreground) {
      completed = await BackgroundWorkerFgHostApi().getCompletedResumableUploads();
    } else {
      completed = await BackgroundWorkerBgHostApi().getCompletedResumableUploads();
    }
    final confirmed = await _backupRepository.getConfirmedUploadIds(userId, completed);
    if (confirmed.isEmpty) {
      return;
    }
    if (_hostMode == BackgroundUploadHostMode.foreground) {
      await BackgroundWorkerFgHostApi().clearCompletedResumableUploads(confirmed);
    } else {
      await BackgroundWorkerBgHostApi().clearCompletedResumableUploads(confirmed);
    }
  }

  Future<void> reconcileProgress({required int total, required int backedUp, required int remaining}) {
    return _progressReporter.reconcile(total: total, backedUp: backedUp, remaining: remaining);
  }

  /// Cancel all ongoing background uploads and reset the upload queue
  ///
  /// Returns the number of tasks left in the queue
  Future<int> cancel() async {
    shouldAbortQueuingTasks = true;

    await _storageRepository.clearCache();
    for (final group in const [kBackupGroup, kBackupLivePhotoGroup]) {
      await _uploadRepository.reset(group);
      await _uploadRepository.deleteDatabaseRecords(group);
    }
    await _progressReporter.clearQueue();

    final activeTasks = await Future.wait<List<Task>>([
      _uploadRepository.getActiveTasks(kBackupGroup),
      _uploadRepository.getActiveTasks(kBackupLivePhotoGroup),
    ]);
    return activeTasks.fold<int>(0, (count, tasks) => count + tasks.length);
  }

  /// Resume background backup processing
  Future<void> resumeOnce() {
    if (_downloaderResumeAttempted) {
      return Future.value();
    }
    _downloaderResumeAttempted = true;
    return _uploadRepository.start(doTrackTasks: false, doRescheduleKilledTasks: true);
  }

  void _handleTaskStatusUpdate(TaskStatusUpdate update) async {
    switch (update.status) {
      case TaskStatus.complete:
        unawaited(_handleLivePhoto(update));

        if (CurrentPlatform.isIOS) {
          try {
            final path = await update.task.filePath();
            await File(path).delete();
          } catch (e) {
            _logger.severe('Error deleting file path for iOS: $e');
          }
        }

        break;

      default:
        break;
    }
  }

  Future<void> _handleLivePhoto(TaskStatusUpdate update) async {
    if (shouldAbortQueuingTasks) {
      return;
    }
    try {
      if (update.task.metaData.isEmpty || update.task.metaData == '') {
        return;
      }

      final metadata = UploadTaskMetadata.fromJson(update.task.metaData);
      if (!metadata.isLivePhotos) {
        return;
      }

      if (update.responseBody == null || update.responseBody!.isEmpty) {
        return;
      }
      final response = jsonDecode(update.responseBody!);

      final localAsset = await _localAssetRepository.getById(metadata.localAssetId);
      if (localAsset == null) {
        return;
      }

      final uploadTask = await getLivePhotoUploadTask(localAsset, response['id'] as String);

      if (uploadTask == null) {
        return;
      }

      if (!shouldAbortQueuingTasks) {
        await _progressReporter.enqueue([uploadTask.taskId]);
        await enqueueTasks([uploadTask]);
      }
    } catch (error, stackTrace) {
      dPrint(() => "Error handling live photo upload task: $error $stackTrace");
    }
  }

  @visibleForTesting
  Future<UploadTask?> getUploadTask(
    LocalAsset asset, {
    String group = kBackupGroup,
    int? priority,
    BackgroundQueueDiagnostics? diagnostics,
    String? diagnosticContext,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final entity = await _runQueueStep(
      diagnostics,
      'asset-entity',
      () => _storageRepository.getAssetEntityForAsset(asset),
      timeout: timeout,
      context: diagnosticContext,
    );
    if (entity == null) {
      _logger.warning("Asset entity not found for ${anonymousBackupAssetId(asset.id)}");
      return null;
    }

    File? file;

    /// iOS LivePhoto has two files: a photo and a video.
    /// They are uploaded separately, with video file being upload first, then returned with the assetId
    /// The assetId is then used as a metadata for the photo file upload task.
    ///
    /// We implement two separate upload groups for this, the normal one for the video file
    /// and the higher priority group for the photo file because the video file is already uploaded.
    ///
    /// The cancel operation will only cancel the video group (normal group), the photo group will not
    /// be touched, as the video file is already uploaded.

    file = await _runQueueStep(
      diagnostics,
      'asset-file',
      () => entity.isLivePhoto
          ? _storageRepository.getMotionFileForAsset(asset)
          : _storageRepository.getFileForAsset(asset.id),
      timeout: timeout,
      context: diagnosticContext,
    );

    if (file == null) {
      _logger.warning("Failed to get file for asset ${anonymousBackupAssetId(asset.id)}");
      return null;
    }

    String fileName =
        await _runQueueStep(
          diagnostics,
          'asset-metadata',
          () => _assetMediaRepository.getOriginalFilename(asset.id),
          timeout: timeout,
          context: diagnosticContext,
        ) ??
        asset.name;
    final hasExtension = p.extension(fileName).isNotEmpty;
    if (!hasExtension) {
      fileName = p.setExtension(fileName, p.extension(asset.name));
    }

    final originalFileName = entity.isLivePhoto ? p.setExtension(fileName, p.extension(file.path)) : fileName;

    String metadata = UploadTaskMetadata(
      localAssetId: asset.id,
      isLivePhotos: entity.isLivePhoto,
      livePhotoVideoId: '',
    ).toJson();

    final requiresWiFi = _shouldRequireWiFi(asset);

    return _runQueueStep(
      diagnostics,
      'asset-task-build',
      () => buildUploadTask(
        file!,
        createdAt: asset.createdAt,
        modifiedAt: asset.updatedAt,
        originalFileName: originalFileName,
        deviceAssetId: asset.id,
        metadata: metadata,
        group: group,
        priority: priority,
        isFavorite: asset.isFavorite,
        requiresWiFi: requiresWiFi,
        // Visibility hidden on upload to prevent the server from running regular jobs on the live photo asset
        fields: entity.isLivePhoto ? {'visibility': api.AssetVisibility.hidden.value} : null,
        cloudId: entity.isLivePhoto ? null : asset.cloudId,
        adjustmentTime: entity.isLivePhoto ? null : asset.adjustmentTime?.toIso8601String(),
        latitude: entity.isLivePhoto ? null : asset.latitude?.toString(),
        longitude: entity.isLivePhoto ? null : asset.longitude?.toString(),
      ),
      timeout: timeout,
      context: diagnosticContext,
    );
  }

  @visibleForTesting
  Future<UploadTask?> getLivePhotoUploadTask(LocalAsset asset, String livePhotoVideoId) async {
    final entity = await _storageRepository.getAssetEntityForAsset(asset);
    if (entity == null) {
      return null;
    }

    final file = await _storageRepository.getFileForAsset(asset.id);
    if (file == null) {
      return null;
    }

    final fields = {'livePhotoVideoId': livePhotoVideoId};

    final requiresWiFi = _shouldRequireWiFi(asset);
    final originalFileName = await _assetMediaRepository.getOriginalFilename(asset.id) ?? asset.name;

    return buildUploadTask(
      file,
      createdAt: asset.createdAt,
      modifiedAt: asset.updatedAt,
      originalFileName: originalFileName,
      deviceAssetId: asset.id,
      fields: fields,
      group: kBackupLivePhotoGroup,
      priority: 0, // Highest priority to get upload immediately
      isFavorite: asset.isFavorite,
      requiresWiFi: requiresWiFi,
      cloudId: asset.cloudId,
      adjustmentTime: asset.adjustmentTime?.toIso8601String(),
      latitude: asset.latitude?.toString(),
      longitude: asset.longitude?.toString(),
    );
  }

  bool _shouldRequireWiFi(LocalAsset asset) {
    final backup = SettingsRepository.instance.appConfig.backup;
    if (asset.isVideo && backup.useCellularForVideos) {
      return false;
    }
    if (!asset.isVideo && backup.useCellularForPhotos) {
      return false;
    }
    return true;
  }

  Future<UploadTask> buildUploadTask(
    File file, {
    required String group,
    required DateTime createdAt,
    required DateTime modifiedAt,
    Map<String, String>? fields,
    String? originalFileName,
    String? deviceAssetId,
    String? metadata,
    int? priority,
    bool? isFavorite,
    bool requiresWiFi = true,
    String? cloudId,
    String? adjustmentTime,
    String? latitude,
    String? longitude,
  }) async {
    final serverEndpoint = Store.get(StoreKey.serverEndpoint);
    final url = Uri.parse('$serverEndpoint/assets').toString();
    final headers = ApiService.getRequestHeaders();
    final deviceId = Store.get(StoreKey.deviceId);
    final (baseDirectory, directory, filename) = await Task.split(filePath: file.path);
    final fieldsMap = {
      'filename': originalFileName ?? filename,
      // deviceAssetId/deviceId required by server v2.7.5 and below (drop in v4.0 per #27818).
      'deviceAssetId': deviceAssetId ?? '',
      'deviceId': deviceId,
      'fileCreatedAt': createdAt.toUtc().toIso8601String(),
      'fileModifiedAt': modifiedAt.toUtc().toIso8601String(),
      'isFavorite': isFavorite?.toString() ?? 'false',
      'duration': '0',
      if (fields != null) ...fields,
      if (CurrentPlatform.isIOS && cloudId != null)
        'metadata': jsonEncode([
          RemoteAssetMetadataItem(
            key: RemoteAssetMetadataKey.mobileApp,
            value: RemoteAssetMobileAppMetadata(
              cloudId: cloudId,
              createdAt: createdAt.toIso8601String(),
              adjustmentTime: adjustmentTime,
              latitude: latitude,
              longitude: longitude,
            ),
          ),
        ]),
    };

    return UploadTask(
      taskId: deviceAssetId,
      displayName: originalFileName ?? filename,
      httpRequestMethod: 'POST',
      url: url,
      headers: headers,
      filename: filename,
      fields: fieldsMap,
      baseDirectory: baseDirectory,
      directory: directory,
      fileField: 'assetData',
      metaData: metadata ?? '',
      group: group,
      requiresWiFi: requiresWiFi,
      priority: priority ?? 5,
      updates: Updates.statusAndProgress,
      retries: 3,
    );
  }
}

enum BackupNetworkPolicyAction { unchanged, leaveRunning, reschedule }

@visibleForTesting
BackupNetworkPolicyAction backupNetworkPolicyAction({
  required bool currentRequiresWifi,
  required bool desiredRequiresWifi,
  required TaskStatus status,
}) {
  // UploadTask is a POST request and background_downloader cannot resume it
  // from TaskStatus.paused. Rebuild it even when the network policy already
  // matches, otherwise it remains excluded from candidates forever.
  if (status == TaskStatus.paused) {
    return BackupNetworkPolicyAction.reschedule;
  }
  if (currentRequiresWifi == desiredRequiresWifi) {
    return BackupNetworkPolicyAction.unchanged;
  }
  if (status == TaskStatus.running && !desiredRequiresWifi) {
    return BackupNetworkPolicyAction.leaveRunning;
  }
  return BackupNetworkPolicyAction.reschedule;
}
