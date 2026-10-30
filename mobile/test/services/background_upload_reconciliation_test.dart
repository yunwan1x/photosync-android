import 'dart:convert';

import 'package:background_downloader/background_downloader.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/services/backup_progress.service.dart';
import 'package:mocktail/mocktail.dart';

import '../fixtures/asset.stub.dart';
import '../infrastructure/repository.mock.dart';
import '../repository.mocks.dart';

class MockProgressReporter extends Mock implements BackupProgressReporter {}

void main() {
  late MockUploadRepository uploads;
  late MockDriftLocalAssetRepository local;
  late MockDriftBackupRepository backup;
  late MockProgressReporter progress;
  late BackgroundUploadService service;

  UploadTask task({bool live = false}) => UploadTask(
    url: 'https://example.test/api/assets',
    filename: 'photo.jpg',
    taskId: 'stale-record',
    metaData: jsonEncode(UploadTaskMetadata(localAssetId: 'image1', isLivePhotos: live, livePhotoVideoId: '').toMap()),
  );

  setUp(() {
    uploads = MockUploadRepository();
    local = MockDriftLocalAssetRepository();
    backup = MockDriftBackupRepository();
    progress = MockProgressReporter();
    service = BackgroundUploadService(
      uploads,
      MockStorageRepository(),
      local,
      backup,
      MockAssetMediaRepository(),
      progress,
    );
    when(() => uploads.getActiveTasks(any())).thenAnswer((_) async => [task()]);
    when(() => uploads.getFailedTasks(any())).thenAnswer((_) async => []);
    when(
      () => local.getById(any()),
    ).thenAnswer((_) async => LocalAssetStub.image1.copyWith(checksum: 'known-checksum'));
    when(() => uploads.deleteTaskRecord(any())).thenAnswer((_) async {});
    when(() => progress.markSucceeded(any())).thenAnswer((_) async {});
    when(() => backup.getConfirmedUploadIds(any(), any())).thenAnswer((_) async => []);
  });

  tearDown(() => service.dispose());

  test('retires a stale running record only after user-scoped remote checksum confirmation', () async {
    when(() => backup.getConfirmedUploadIds('current-user', any())).thenAnswer((_) async => ['stale-record']);
    await service.reconcileConfirmedRegularUploads('current-user');
    final checksums = verify(() => backup.getConfirmedUploadIds('current-user', captureAny())).captured.single;
    expect(checksums, {'stale-record': 'known-checksum'});
    verify(() => uploads.deleteTaskRecord('stale-record')).called(1);
    verify(() => progress.markSucceeded('stale-record')).called(1);
  });

  test('keeps an unconfirmed upload record and its pending state', () async {
    await service.reconcileConfirmedRegularUploads('current-user');
    verifyNever(() => uploads.deleteTaskRecord(any()));
    verifyNever(() => progress.markSucceeded(any()));
  });

  test('keeps live photo records because the paired video can still be uploading', () async {
    when(() => uploads.getActiveTasks(any())).thenAnswer((_) async => [task(live: true)]);
    await service.reconcileConfirmedRegularUploads('current-user');
    verifyNever(() => local.getById(any()));
    verifyNever(() => uploads.deleteTaskRecord(any()));
    verifyNever(() => progress.markSucceeded(any()));
  });

  test('also repairs a failed callback record when the remote upload is confirmed', () async {
    when(() => uploads.getActiveTasks(any())).thenAnswer((_) async => []);
    when(() => uploads.getFailedTasks(any())).thenAnswer((_) async => [task()]);
    when(() => backup.getConfirmedUploadIds('current-user', any())).thenAnswer((_) async => ['stale-record']);
    await service.reconcileConfirmedRegularUploads('current-user');
    verify(() => uploads.deleteTaskRecord('stale-record')).called(1);
    verify(() => progress.markSucceeded('stale-record')).called(1);
  });
}
