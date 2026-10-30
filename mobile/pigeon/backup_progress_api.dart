import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/backup_progress_api.g.dart',
    kotlinOut: 'android/app/src/main/kotlin/app/alextran/immich/backupprogress/BackupProgress.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.backupprogress'),
    dartOptions: DartOptions(),
    dartPackageName: 'immich_mobile',
  ),
)
@HostApi()
abstract class BackupProgressHostApi {
  void reconcile(int total, int backedUp, int remaining);

  void reconcileQueue(List<String> activeTaskIds, List<String> failedTaskIds);

  void enqueue(List<String> taskIds);

  void markSucceeded(String taskId);

  void markRetrying(String taskId);

  void markFailed(String taskId);

  void markCanceled(String taskId);

  void updateFileProgress(String taskId, String filename, int uploadedBytes, int totalBytes);

  void clearQueue();
}
