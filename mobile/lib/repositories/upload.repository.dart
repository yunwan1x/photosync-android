import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:logging/logging.dart';
import 'package:http/http.dart';
import 'package:immich_mobile/utils/debug_print.dart';

final uploadRepositoryProvider = Provider((ref) => UploadRepository());

bool isRecoverableBackupTaskStatus(TaskStatus status) => switch (status) {
  TaskStatus.failed || TaskStatus.notFound || TaskStatus.canceled => true,
  _ => false,
};

class UploadRepository {
  final Logger logger = Logger('UploadRepository');
  void Function(TaskStatusUpdate)? onUploadStatus;
  void Function(TaskProgressUpdate)? onTaskProgress;

  UploadRepository() {
    FileDownloader().registerCallbacks(
      group: kBackupGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kBackupLivePhotoGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kManualUploadGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
  }

  Future<void> enqueueBackground(UploadTask task) {
    return FileDownloader().enqueue(task);
  }

  Future<bool> rebuildInactiveBackgroundUpload(UploadTask task) async {
    await FileDownloader().database.deleteRecordWithId(task.taskId);
    return FileDownloader().enqueue(task);
  }

  Future<bool> replaceFailedBackgroundUpload(UploadTask task) => rebuildInactiveBackgroundUpload(task);

  Future<List<Task>> getFailedTasks(String group) async {
    final records = await Future.wait(
      TaskStatus.values
          .where(isRecoverableBackupTaskStatus)
          .map((status) => FileDownloader().database.allRecordsWithStatus(status, group: group)),
    );
    return records.expand((records) => records).map((record) => record.task).toList(growable: false);
  }

  Future<void> deleteTaskRecord(String taskId) {
    return FileDownloader().database.deleteRecordWithId(taskId);
  }

  Future<List<bool>> enqueueBackgroundAll(List<UploadTask> tasks) {
    return FileDownloader().enqueueAll(tasks);
  }

  Future<void> deleteDatabaseRecords(String group) {
    return FileDownloader().database.deleteAllRecords(group: group);
  }

  Future<bool> cancelAll(String group) {
    return FileDownloader().cancelAll(group: group);
  }

  Future<int> reset(String group) {
    return FileDownloader().reset(group: group);
  }

  /// Get a list of tasks that are ENQUEUED or RUNNING
  Future<List<Task>> getActiveTasks(String group) async {
    final records = await getActiveTaskRecords(group);
    return records.map((record) => record.task).toList(growable: false);
  }

  Future<List<TaskRecord>> getActiveTaskRecords(String group) async {
    final records = await Future.wait([
      FileDownloader().database.allRecordsWithStatus(TaskStatus.enqueued, group: group),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.running, group: group),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.waitingToRetry, group: group),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.paused, group: group),
    ]);
    return records.expand((records) => records).toList(growable: false);
  }

  Future<bool> replaceActiveBackgroundUpload(UploadTask task) async {
    final canceled = await FileDownloader().cancelTaskWithId(task.taskId);
    if (!canceled) {
      return false;
    }

    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (DateTime.now().isBefore(deadline)) {
      final record = await FileDownloader().database.recordForId(task.taskId);
      if (record == null || !record.status.isNotFinalState) {
        await FileDownloader().database.deleteRecordWithId(task.taskId);
        return FileDownloader().enqueue(task);
      }
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }

    logger.warning('Timed out waiting for cancellation before replacing ${task.taskId}');
    return false;
  }

  Future<void> start({bool doTrackTasks = true, bool doRescheduleKilledTasks = true}) {
    return FileDownloader().start(doTrackTasks: doTrackTasks, doRescheduleKilledTasks: doRescheduleKilledTasks);
  }

  Future<void> getUploadInfo() async {
    final [enqueuedTasks, runningTasks, canceledTasks, waitingTasks, pausedTasks] = await Future.wait([
      FileDownloader().database.allRecordsWithStatus(TaskStatus.enqueued, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.running, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.canceled, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.waitingToRetry, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.paused, group: kBackupGroup),
    ]);

    dPrint(
      () =>
          """
      Upload Info:
      Enqueued: ${enqueuedTasks.length}
      Running: ${runningTasks.length}
      Canceled: ${canceledTasks.length}
      Waiting: ${waitingTasks.length}
      Paused: ${pausedTasks.length}
    """,
    );
  }

  Future<UploadResult> uploadFile({
    required File file,
    required String originalFileName,
    required Map<String, String> fields,
    required Completer<void>? cancelToken,
    void Function(int bytes, int totalBytes)? onProgress,
    required String logContext,
  }) async {
    for (var attempt = 0; attempt < 2; attempt++) {
      final String savedEndpoint = Store.get(StoreKey.serverEndpoint);
      final baseRequest = ProgressMultipartRequest(
        'POST',
        Uri.parse('$savedEndpoint/assets'),
        abortTrigger: cancelToken?.future,
        onProgress: onProgress,
      );

      try {
        final fileStream = file.openRead();
        final assetRawUploadData = MultipartFile(
          "assetData",
          fileStream,
          file.lengthSync(),
          filename: originalFileName,
        );

        baseRequest.fields.addAll(fields);
        baseRequest.files.add(assetRawUploadData);

        final response = await NetworkRepository.client.send(baseRequest);
        final responseBodyString = await response.stream.bytesToString();

        if (![200, 201].contains(response.statusCode)) {
          if (attempt == 0 && _isRetryableStatus(response.statusCode)) {
            final change = await NetworkRepository.refreshEndpoint(savedEndpoint);
            if (change != null) {
              logger.info('Retrying $logContext after TXT endpoint refresh');
              continue;
            }
          }

          String? errorMessage;
          if (response.statusCode == 413) {
            errorMessage = 'Error(413) File is too large to upload';
            return UploadResult.error(statusCode: response.statusCode, errorMessage: errorMessage);
          }

          try {
            final error = jsonDecode(responseBodyString);
            errorMessage = error['message'] ?? error['error'];
          } catch (_) {
            errorMessage = responseBodyString.isNotEmpty
                ? responseBodyString
                : 'Upload failed with status ${response.statusCode}';
          }

          return UploadResult.error(statusCode: response.statusCode, errorMessage: errorMessage);
        }

        try {
          final responseBody = jsonDecode(responseBodyString);
          return UploadResult.success(remoteAssetId: responseBody['id'] as String);
        } catch (_) {
          return UploadResult.error(errorMessage: 'Failed to parse server response');
        }
      } on RequestAbortedException {
        logger.warning("Upload $logContext was cancelled");
        return UploadResult.cancelled();
      } catch (error, stackTrace) {
        if (attempt == 0 && _isRetryableError(error)) {
          final change = await NetworkRepository.refreshEndpoint(savedEndpoint);
          if (change != null) {
            logger.info('Retrying $logContext after TXT endpoint refresh');
            continue;
          }
        }
        logger.warning("Error uploading $logContext: ${error.toString()}: $stackTrace");
        return UploadResult.error(errorMessage: error.toString());
      }
    }

    return UploadResult.error(errorMessage: 'Upload failed after endpoint refresh');
  }

  bool _isRetryableStatus(int statusCode) => const {502, 503, 504}.contains(statusCode);

  bool _isRetryableError(Object error) {
    return error is SocketException || error is TimeoutException || error is ClientException;
  }
}

class ProgressMultipartRequest extends MultipartRequest with Abortable {
  ProgressMultipartRequest(super.method, super.url, {this.abortTrigger, this.onProgress});

  @override
  final Future<void>? abortTrigger;

  final void Function(int bytes, int totalBytes)? onProgress;

  @override
  ByteStream finalize() {
    final byteStream = super.finalize();
    if (onProgress == null) {
      return byteStream;
    }

    final total = contentLength;
    var bytes = 0;
    final stream = byteStream.transform(
      StreamTransformer.fromHandlers(
        handleData: (List<int> data, EventSink<List<int>> sink) {
          bytes += data.length;
          onProgress!(bytes, total);
          sink.add(data);
        },
      ),
    );
    return ByteStream(stream);
  }
}

class UploadResult {
  final bool isSuccess;
  final bool isCancelled;
  final String? remoteAssetId;
  final String? errorMessage;
  final int? statusCode;

  const UploadResult({
    required this.isSuccess,
    required this.isCancelled,
    this.remoteAssetId,
    this.errorMessage,
    this.statusCode,
  });

  factory UploadResult.success({required String remoteAssetId}) {
    return UploadResult(isSuccess: true, isCancelled: false, remoteAssetId: remoteAssetId);
  }

  factory UploadResult.error({String? errorMessage, int? statusCode}) {
    return UploadResult(isSuccess: false, isCancelled: false, errorMessage: errorMessage, statusCode: statusCode);
  }

  factory UploadResult.cancelled() {
    return const UploadResult(isSuccess: false, isCancelled: true);
  }
}
