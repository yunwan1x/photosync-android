import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/background_worker_api.g.dart',
    swiftOut: 'ios/Runner/Background/BackgroundWorker.g.swift',
    swiftOptions: SwiftOptions(includeErrorClass: false),
    kotlinOut: 'android/app/src/main/kotlin/app/alextran/immich/background/BackgroundWorker.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.background'),
    dartOptions: DartOptions(),
    dartPackageName: 'immich_mobile',
  ),
)
class BackgroundWorkerSettings {
  final bool requiresCharging;
  final int minimumDelaySeconds;

  const BackgroundWorkerSettings({required this.requiresCharging, required this.minimumDelaySeconds});
}

class ResumableUploadRequest {
  final String taskId;
  final String serverUrl;
  final String serverUrlSource;
  final String filePath;
  final String filename;
  final int fileSize;
  final String checksum;
  final Map<String, String> headers;
  final Map<String, String> fields;
  final bool requiresWifi;

  const ResumableUploadRequest({
    required this.taskId,
    required this.serverUrl,
    required this.serverUrlSource,
    required this.filePath,
    required this.filename,
    required this.fileSize,
    required this.checksum,
    required this.headers,
    required this.fields,
    required this.requiresWifi,
  });
}

class BackgroundWorkerDiagnostics {
  final int? lastTriggerAt;
  final int? lastStartedAt;
  final int? lastSucceededAt;
  final int pendingCount;
  final int retryingCount;
  final int failedCount;
  final String? lastError;

  const BackgroundWorkerDiagnostics({
    required this.lastTriggerAt,
    required this.lastStartedAt,
    required this.lastSucceededAt,
    required this.pendingCount,
    required this.retryingCount,
    required this.failedCount,
    required this.lastError,
  });
}

@HostApi()
abstract class BackgroundWorkerFgHostApi {
  void enable();

  void saveNotificationMessage(String title, String body);

  void configure(BackgroundWorkerSettings settings);

  BackgroundWorkerDiagnostics getDiagnostics();

  void enqueueResumableUploads(List<ResumableUploadRequest> requests);

  int refreshResumableUploadNetworkPolicy(bool requiresWifi);

  List<String> getPendingResumableUploadIds();

  Map<String, String> getCompletedResumableUploads();

  void clearCompletedResumableUploads(List<String> taskIds);

  void setBackupPendingState(bool hasPending);

  /// Marks a foreground-to-background lifecycle handoff and atomically unlocks
  /// and schedules the Android worker. iOS treats this like [runNow].
  void handoffToBackground();

  /// Requests work without overriding the foreground database lock.
  void runNow();

  void disable();
}

@HostApi()
abstract class BackgroundWorkerBgHostApi {
  // Called from the background flutter engine when it has bootstrapped and established the
  // required platform channels to notify the native side to start the background upload
  void onInitialized();

  // Called from the background flutter engine to request the native side to cleanup
  void close();

  void enqueueResumableUploads(List<ResumableUploadRequest> requests);

  int refreshResumableUploadNetworkPolicy(bool requiresWifi);

  List<String> getPendingResumableUploadIds();

  Map<String, String> getCompletedResumableUploads();

  void clearCompletedResumableUploads(List<String> taskIds);

  void setBackupPendingState(bool hasPending);

  void recordWorkerEvent(String event, String? detail);
}

@FlutterApi()
abstract class BackgroundWorkerFlutterApi {
  // iOS Only: Called when the iOS background upload is triggered
  @async
  void onIosUpload(bool isRefresh, int? maxSeconds);

  // Android Only: Called when the Android background upload is triggered
  @async
  void onAndroidUpload(int? maxMinutes);

  @async
  void cancel();
}
