import 'package:background_downloader/background_downloader.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/services/background_upload.service.dart';

void main() {
  UploadTask task({
    String id = 'asset-1',
    String group = kBackupGroup,
    String metadata = '',
    String displayName = 'photo.jpg',
  }) {
    return UploadTask(
      taskId: id,
      url: 'http://example.test/assets',
      filename: displayName,
      displayName: displayName,
      group: group,
      metaData: metadata,
    );
  }

  test('regular upload completion advances overall progress', () {
    final update = TaskStatusUpdate(task(), TaskStatus.complete);

    expect(backupProgressEventFor(update), BackupProgressEvent.succeeded);
  });

  test('live photo hidden-video completion does not advance overall progress', () {
    final metadata = const UploadTaskMetadata(
      localAssetId: 'asset-1',
      isLivePhotos: true,
      livePhotoVideoId: '',
    ).toJson();
    final update = TaskStatusUpdate(task(metadata: metadata), TaskStatus.complete);

    expect(isIntermediateLivePhotoTask(update.task), isTrue);
    expect(backupProgressEventFor(update), BackupProgressEvent.none);
  });

  test('live photo final image completion advances overall progress', () {
    final update = TaskStatusUpdate(task(group: kBackupLivePhotoGroup), TaskStatus.complete);

    expect(isIntermediateLivePhotoTask(update.task), isFalse);
    expect(backupProgressEventFor(update), BackupProgressEvent.succeeded);
  });

  test('retry failure and cancel statuses map without double counting', () {
    final upload = task();

    expect(backupProgressEventFor(TaskStatusUpdate(upload, TaskStatus.waitingToRetry)), BackupProgressEvent.retrying);
    expect(backupProgressEventFor(TaskStatusUpdate(upload, TaskStatus.failed)), BackupProgressEvent.failed);
    expect(backupProgressEventFor(TaskStatusUpdate(upload, TaskStatus.notFound)), BackupProgressEvent.failed);
    expect(backupProgressEventFor(TaskStatusUpdate(upload, TaskStatus.canceled)), BackupProgressEvent.canceled);
  });

  test('ordinary upload byte progress is normalized for the shared notification', () {
    final progress = backupFileProgressFor(TaskProgressUpdate(task(displayName: 'video.mp4'), 0.25, 4000));

    expect(progress, isNotNull);
    expect(progress!.taskId, 'asset-1');
    expect(progress.filename, 'video.mp4');
    expect(progress.uploadedBytes, 1000);
    expect(progress.totalBytes, 4000);
    expect(backupFileProgressFor(TaskProgressUpdate(task(), progressWaitingToRetry, 4000)), isNull);
  });

  test('queue reconciliation combines downloader and resumable work and excludes stale ids', () {
    final reconciliation = buildBackupQueueReconciliation(
      downloaderTaskIds: const ['photo-active', 'shared-active'],
      resumableTaskIds: const ['video-active', 'shared-active'],
      failedTaskIds: const ['failed', 'shared-active'],
    );

    expect(reconciliation.activeTaskIds, {'photo-active', 'video-active', 'shared-active'});
    expect(reconciliation.failedTaskIds, {'failed'});
    expect(reconciliation.activeTaskIds, isNot(contains('stale-ledger-id')));
  });
}
