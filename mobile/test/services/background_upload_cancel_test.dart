import 'dart:async';

import 'package:background_downloader/background_downloader.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/platform/background_worker_api.g.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:mocktail/mocktail.dart';

import '../infrastructure/repository.mock.dart';
import '../repository.mocks.dart';

void main() {
  setUpAll(() {
    registerFallbackValue(UploadTask(url: 'http://fallback.invalid', filename: 'fallback'));
  });

  group('backup network policy refresh', () {
    test('final failed canceled and not-found records are eligible for rebuilding', () {
      expect(isRecoverableBackupTaskStatus(TaskStatus.failed), isTrue);
      expect(isRecoverableBackupTaskStatus(TaskStatus.canceled), isTrue);
      expect(isRecoverableBackupTaskStatus(TaskStatus.notFound), isTrue);
      expect(isRecoverableBackupTaskStatus(TaskStatus.complete), isFalse);
      expect(isRecoverableBackupTaskStatus(TaskStatus.enqueued), isFalse);
      expect(isRecoverableBackupTaskStatus(TaskStatus.running), isFalse);
      expect(isRecoverableBackupTaskStatus(TaskStatus.waitingToRetry), isFalse);
      expect(isRecoverableBackupTaskStatus(TaskStatus.paused), isFalse);
    });

    test('queued tasks are rebuilt when the cellular policy changes', () {
      expect(
        backupNetworkPolicyAction(currentRequiresWifi: true, desiredRequiresWifi: false, status: TaskStatus.enqueued),
        BackupNetworkPolicyAction.reschedule,
      );
      expect(
        backupNetworkPolicyAction(
          currentRequiresWifi: false,
          desiredRequiresWifi: true,
          status: TaskStatus.waitingToRetry,
        ),
        BackupNetworkPolicyAction.reschedule,
      );
    });

    test('enabling cellular does not restart an upload already in progress', () {
      expect(
        backupNetworkPolicyAction(currentRequiresWifi: true, desiredRequiresWifi: false, status: TaskStatus.running),
        BackupNetworkPolicyAction.leaveRunning,
      );
    });

    test('disabling cellular constrains an upload already in progress', () {
      expect(
        backupNetworkPolicyAction(currentRequiresWifi: false, desiredRequiresWifi: true, status: TaskStatus.running),
        BackupNetworkPolicyAction.reschedule,
      );
    });

    test('refreshing an already matching queued task is idempotent', () {
      expect(
        backupNetworkPolicyAction(currentRequiresWifi: false, desiredRequiresWifi: false, status: TaskStatus.enqueued),
        BackupNetworkPolicyAction.unchanged,
      );
    });

    test('paused upload is rebuilt even when its wifi policy already matches', () {
      expect(
        backupNetworkPolicyAction(currentRequiresWifi: true, desiredRequiresWifi: true, status: TaskStatus.paused),
        BackupNetworkPolicyAction.reschedule,
      );
    });

    test('service rebuilds a paused wifi upload without requiring a policy change', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final uploadRepository = MockUploadRepository();
      final localAssetRepository = MockDriftLocalAssetRepository();
      final service = BackgroundUploadService(
        uploadRepository,
        MockStorageRepository(),
        localAssetRepository,
        MockDriftBackupRepository(),
        MockAssetMediaRepository(),
      );
      addTearDown(service.dispose);
      final video = _asset('video-paused', AssetType.video);
      final task = _task(video, requiresWifi: true);

      when(() => uploadRepository.getActiveTaskRecords(any())).thenAnswer((invocation) async {
        final group = invocation.positionalArguments.single as String;
        return group == kBackupGroup ? [TaskRecord(task, TaskStatus.paused, 0.25, 100)] : [];
      });
      when(() => localAssetRepository.getById(video.id)).thenAnswer((_) async => video);
      when(() => uploadRepository.rebuildInactiveBackgroundUpload(any())).thenAnswer((_) async => true);

      await service.refreshUploadNetworkPolicy(useCellularForVideos: false, useCellularForPhotos: false);

      final replacement =
          verify(() => uploadRepository.rebuildInactiveBackgroundUpload(captureAny())).captured.single as UploadTask;
      expect(replacement.taskId, video.id);
      expect(replacement.requiresWiFi, isTrue);
      verifyNever(() => uploadRepository.replaceActiveBackgroundUpload(any()));
    });

    test('service updates only the media type whose cellular policy changed', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final uploadRepository = MockUploadRepository();
      final localAssetRepository = MockDriftLocalAssetRepository();
      final service = BackgroundUploadService(
        uploadRepository,
        MockStorageRepository(),
        localAssetRepository,
        MockDriftBackupRepository(),
        MockAssetMediaRepository(),
      );
      addTearDown(service.dispose);
      final video = _asset('video-queued', AssetType.video);
      final photo = _asset('photo-queued', AssetType.image);
      final videoTask = _task(video, requiresWifi: true);
      final photoTask = _task(photo, requiresWifi: true);

      when(() => uploadRepository.getActiveTaskRecords(any())).thenAnswer((invocation) async {
        final group = invocation.positionalArguments.single as String;
        return group == kBackupGroup
            ? [TaskRecord(videoTask, TaskStatus.enqueued, 0, -1), TaskRecord(photoTask, TaskStatus.enqueued, 0, -1)]
            : [];
      });
      when(() => localAssetRepository.getById(video.id)).thenAnswer((_) async => video);
      when(() => localAssetRepository.getById(photo.id)).thenAnswer((_) async => photo);
      when(() => uploadRepository.replaceActiveBackgroundUpload(any())).thenAnswer((_) async => true);

      await service.refreshUploadNetworkPolicy(useCellularForVideos: true, useCellularForPhotos: false);

      final captured = verify(() => uploadRepository.replaceActiveBackgroundUpload(captureAny())).captured;
      expect(captured, hasLength(1));
      expect((captured.single as UploadTask).taskId, video.id);
      expect((captured.single as UploadTask).requiresWiFi, isFalse);
    });

    test('service constrains a running task when cellular backup is disabled', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final uploadRepository = MockUploadRepository();
      final localAssetRepository = MockDriftLocalAssetRepository();
      final service = BackgroundUploadService(
        uploadRepository,
        MockStorageRepository(),
        localAssetRepository,
        MockDriftBackupRepository(),
        MockAssetMediaRepository(),
      );
      addTearDown(service.dispose);
      final video = _asset('video-running', AssetType.video);
      final task = _task(video, requiresWifi: false);

      when(() => uploadRepository.getActiveTaskRecords(any())).thenAnswer((invocation) async {
        final group = invocation.positionalArguments.single as String;
        return group == kBackupGroup ? [TaskRecord(task, TaskStatus.running, 0.5, 100)] : [];
      });
      when(() => localAssetRepository.getById(video.id)).thenAnswer((_) async => video);
      when(() => uploadRepository.replaceActiveBackgroundUpload(any())).thenAnswer((_) async => true);

      await service.refreshUploadNetworkPolicy(useCellularForVideos: false, useCellularForPhotos: false);

      final replacement =
          verify(() => uploadRepository.replaceActiveBackgroundUpload(captureAny())).captured.single as UploadTask;
      expect(replacement.taskId, video.id);
      expect(replacement.requiresWiFi, isTrue);
      expect(replacement.retriesRemaining, task.retriesRemaining);
    });
  });

  test('queue diagnostics records the exact step heartbeat and timeout', () async {
    final events = <String>[];
    final diagnostics = BackgroundQueueDiagnostics(
      eventSink: (event, detail) async => events.add('$event|$detail'),
      defaultTimeout: const Duration(milliseconds: 25),
      heartbeatInterval: const Duration(milliseconds: 5),
    );

    await expectLater(
      diagnostics.runStep<void>('asset-file', () => Completer<void>().future),
      throwsA(isA<BackgroundQueueStepTimeoutException>()),
    );

    expect(events.first, contains('queue_step_start|step=asset-file'));
    expect(events, contains(predicate<String>((event) => event.startsWith('queue_step_heartbeat|step=asset-file'))));
    expect(events.last, contains('queue_step_timeout|step=asset-file'));
    expect(events, isNot(contains(predicate<String>((event) => event.startsWith('queue_step_complete')))));
  });

  test('queue diagnostics cannot block backup when its event sink hangs', () async {
    final diagnostics = BackgroundQueueDiagnostics(
      eventSink: (_, _) => Completer<void>().future,
      eventTimeout: const Duration(milliseconds: 5),
      heartbeatInterval: const Duration(seconds: 1),
    );

    final result = await diagnostics.runStep<int>(
      'candidate-query',
      () async => 42,
      timeout: const Duration(seconds: 1),
    );

    expect(result, 42);
  });

  test('diagnostic asset identifier is stable and does not expose the source identifier', () {
    const source = '/storage/emulated/0/DCIM/private-family-photo.jpg';
    final first = anonymousBackupAssetId(source);

    expect(first, hasLength(12));
    expect(first, anonymousBackupAssetId(source));
    expect(first, isNot(contains('private')));
    expect(first, isNot(contains('photo')));
    expect(first, isNot(contains('/')));
  });

  test('resumable progress is confirmed only after native work is accepted', () async {
    final progress = <String>[];
    final result = await enqueueResumableRequestsSequentially(
      requests: [_resumableRequest('video-1'), _resumableRequest('video-2')],
      enqueueNative: (_) async => throw StateError('native enqueue failed'),
      confirmProgress: (taskId) async => progress.add(taskId),
    );

    expect(result.succeeded, isFalse);
    expect(result.acceptedCount, 0);
    expect(result.deferredCount, 2);
    expect(result.failedTaskId, 'video-1');
    expect(result.failedPhase, 'native');
    expect(progress, isEmpty);
  });

  test('resumable batch stops at one failed item without losing accepted work', () async {
    final native = <String>[];
    final progress = <String>[];
    final result = await enqueueResumableRequestsSequentially(
      requests: [_resumableRequest('video-1'), _resumableRequest('video-2'), _resumableRequest('video-3')],
      enqueueNative: (requests) async {
        final taskId = requests.single.taskId;
        native.add(taskId);
        if (taskId == 'video-2') {
          throw StateError('native enqueue failed');
        }
      },
      confirmProgress: (taskId) async => progress.add(taskId),
    );

    expect(result.succeeded, isFalse);
    expect(result.acceptedCount, 1);
    expect(result.deferredCount, 2);
    expect(result.failedTaskId, 'video-2');
    expect(native, ['video-1', 'video-2']);
    expect(progress, ['video-1']);
  });

  test('resumable native work stays accepted when progress confirmation fails', () async {
    final native = <String>[];
    final result = await enqueueResumableRequestsSequentially(
      requests: [_resumableRequest('video-1'), _resumableRequest('video-2')],
      enqueueNative: (requests) async => native.add(requests.single.taskId),
      confirmProgress: (_) async => throw StateError('progress confirmation failed'),
    );

    expect(result.succeeded, isFalse);
    expect(result.acceptedCount, 1);
    expect(result.deferredCount, 1);
    expect(result.failedTaskId, 'video-1');
    expect(result.failedPhase, 'progress');
    expect(native, ['video-1']);
  });

  test('cancel stops and deletes regular and live-photo backup queues', () async {
    final uploadRepository = MockUploadRepository();
    final storageRepository = MockStorageRepository();
    final service = BackgroundUploadService(
      uploadRepository,
      storageRepository,
      MockDriftLocalAssetRepository(),
      MockDriftBackupRepository(),
      MockAssetMediaRepository(),
    );
    addTearDown(service.dispose);

    when(storageRepository.clearCache).thenAnswer((_) async {});
    when(() => uploadRepository.reset(any())).thenAnswer((_) async => 0);
    when(() => uploadRepository.deleteDatabaseRecords(any())).thenAnswer((_) async {});
    when(() => uploadRepository.getActiveTasks(any())).thenAnswer((_) async => []);

    final remaining = await service.cancel();

    expect(remaining, 0);
    verify(() => uploadRepository.reset(kBackupGroup)).called(1);
    verify(() => uploadRepository.reset(kBackupLivePhotoGroup)).called(1);
    verify(() => uploadRepository.deleteDatabaseRecords(kBackupGroup)).called(1);
    verify(() => uploadRepository.deleteDatabaseRecords(kBackupLivePhotoGroup)).called(1);
  });

  test('undelivered downloader state is resumed only once per background engine', () async {
    final uploadRepository = MockUploadRepository();
    final service = BackgroundUploadService(
      uploadRepository,
      MockStorageRepository(),
      MockDriftLocalAssetRepository(),
      MockDriftBackupRepository(),
      MockAssetMediaRepository(),
    );
    addTearDown(service.dispose);

    when(() => uploadRepository.start(doTrackTasks: false, doRescheduleKilledTasks: true)).thenAnswer((_) async {});

    await service.resumeOnce();
    await service.resumeOnce();

    verify(() => uploadRepository.start(doTrackTasks: false, doRescheduleKilledTasks: true)).called(1);
  });
}

LocalAsset _asset(String id, AssetType type) => LocalAsset(
  id: id,
  name: type == AssetType.video ? '$id.mp4' : '$id.jpg',
  type: type,
  createdAt: DateTime(2025),
  updatedAt: DateTime(2025),
  playbackStyle: type == AssetType.video ? AssetPlaybackStyle.video : AssetPlaybackStyle.image,
  isEdited: false,
);

UploadTask _task(LocalAsset asset, {required bool requiresWifi}) => UploadTask(
  taskId: asset.id,
  url: 'http://test-server.com/assets',
  filename: asset.name,
  group: kBackupGroup,
  requiresWiFi: requiresWifi,
  retries: 3,
);

ResumableUploadRequest _resumableRequest(String taskId) => ResumableUploadRequest(
  taskId: taskId,
  serverUrl: 'http://test-server.com/api',
  serverUrlSource: 'txt://photos.example.test',
  filePath: '/media/$taskId.mp4',
  filename: '$taskId.mp4',
  fileSize: 128 * 1024 * 1024,
  checksum: 'checksum-$taskId',
  headers: const {},
  fields: {'deviceAssetId': taskId},
  requiresWifi: true,
);
