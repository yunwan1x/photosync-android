package app.alextran.immich.background

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

internal object ResumableUploadScheduler {
  const val TASK_ID = "taskId"
  const val TAG = "immich/resumable-upload"

  @Synchronized
  fun enqueue(context: Context, requests: List<ResumableUploadRequest>) {
    val store = ResumableUploadStore(context)
    val workManager = WorkManager.getInstance(context)
    val diagnostics = BackgroundWorkerPreferences(context)
    val notifier = UploadProgressNotifier(context)
    if (!diagnostics.isBackupEnabled()) {
      return
    }
    requests.forEach { request ->
      val workName = workName(request.taskId)
      val hasLiveWork = hasLiveWork(workManager, request.taskId)
      if (store.contains(request.taskId) && hasLiveWork) {
        return@forEach
      }

      val previous = store.get(request.taskId)
      if (
        previous != null &&
        (previous.checksum != request.checksum ||
          previous.fileSize != request.fileSize ||
          previous.filePath != request.filePath)
      ) {
        store.clearUploadId(request.taskId)
        diagnostics.recordDiagnosticEvent("upload_session_reset", "reason=local_file_changed")
      }
      store.save(request)
      try {
        workManager.enqueueUniqueWork(
          workName,
          if (hasLiveWork) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE,
          buildWork(request),
        ).result.get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      } catch (error: Exception) {
        val rolledBack = !hasLiveWork
        if (rolledBack) {
          store.remove(request.taskId)
        }
        diagnostics.recordDiagnosticEvent(
          "resumable_enqueue_failed",
          "task=${request.taskId.take(12)} requiresWifi=${request.requiresWifi} " +
            "error=${error.javaClass.simpleName} message=${diagnosticErrorMessage(error)} rollback=$rolledBack",
        )
        throw error
      }
    }
    notifier.update(diagnostics.getProgressState())
  }

  @Synchronized
  fun refreshNetworkPolicy(context: Context, requiresWifi: Boolean): Int {
    val store = ResumableUploadStore(context)
    val workManager = WorkManager.getInstance(context)
    val diagnostics = BackgroundWorkerPreferences(context)
    var replaced = 0
    store.taskIds().forEach { taskId ->
      val original = store.get(taskId) ?: return@forEach
      if (original.requiresWifi == requiresWifi) {
        return@forEach
      }

      val currentWork = workManager.getWorkInfosForUniqueWork(workName(taskId))
        .get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .lastOrNull { !it.state.isFinished }
      val updated = withNetworkPolicy(original, requiresWifi)
      if (
        shouldDeferRunningPolicyReplacement(
          currentWork?.state == androidx.work.WorkInfo.State.RUNNING,
          requiresWifi,
        )
      ) {
        // Do not interrupt a chunk that is already uploading. The worker reads
        // the latest stored request when it schedules its continuation.
        store.save(updated)
        replaced++
        diagnostics.recordDiagnosticEvent(
          "resumable_policy_replace_deferred",
          "task=${taskId.take(12)} requiresWifi=false reason=running",
        )
        return@forEach
      }

      diagnostics.recordDiagnosticEvent(
        "resumable_policy_replace_start",
        "task=${taskId.take(12)} requiresWifi=$requiresWifi",
      )
      workManager.cancelUniqueWork(workName(taskId)).result.get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      val current = store.get(taskId) ?: return@forEach
      val replacement = withNetworkPolicy(current, requiresWifi)
      store.save(replacement)
      try {
        workManager.enqueueUniqueWork(
          workName(taskId),
          ExistingWorkPolicy.REPLACE,
          buildWork(replacement),
        ).result.get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        replaced++
        diagnostics.recordDiagnosticEvent(
          "resumable_policy_replace_complete",
          "task=${taskId.take(12)} requiresWifi=$requiresWifi",
        )
      } catch (error: Exception) {
        store.save(current)
        runCatching {
          workManager.enqueueUniqueWork(
            workName(taskId),
            ExistingWorkPolicy.REPLACE,
            buildWork(current),
          ).result.get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
        diagnostics.recordDiagnosticEvent(
          "resumable_policy_replace_failed",
          "task=${taskId.take(12)} error=${error.javaClass.simpleName}",
        )
        throw error
      }
    }
    return replaced
  }

  @Synchronized
  fun claimedTaskIds(context: Context): List<String> {
    val store = ResumableUploadStore(context)
    recoverMissingWork(context)
    return store.claimedTaskIds()
  }

  @Synchronized
  fun recoverMissingWork(context: Context): Int {
    val store = ResumableUploadStore(context)
    val workManager = WorkManager.getInstance(context)
    val diagnostics = BackgroundWorkerPreferences(context)
    var recovered = 0
    store.taskIds().forEach { taskId ->
      val request = store.get(taskId)
      if (request == null) {
        store.remove(taskId)
        diagnostics.recordDiagnosticEvent(
          "resumable_recovery_dropped",
          "task=${taskId.take(12)} reason=invalid_request",
        )
        return@forEach
      }
      val hasLiveWork = try {
        hasLiveWork(workManager, taskId)
      } catch (error: Exception) {
        diagnostics.recordDiagnosticEvent(
          "resumable_recovery_deferred",
          "task=${taskId.take(12)} reason=${error.javaClass.simpleName}",
        )
        return@forEach
      }
      if (!shouldRecoverStoredWork(hasLiveWork)) {
        return@forEach
      }
      workManager.enqueueUniqueWork(
        workName(taskId),
        ExistingWorkPolicy.REPLACE,
        buildWork(request),
      ).result.get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      recovered++
      diagnostics.recordDiagnosticEvent(
        "resumable_recovery_complete",
        "task=${taskId.take(12)} uploadSession=${store.getUploadId(taskId) != null} requiresWifi=${request.requiresWifi}",
      )
    }
    return recovered
  }

  fun diagnosticSummary(context: Context): String {
    val store = ResumableUploadStore(context)
    val workManager = WorkManager.getInstance(context)
    val lines = store.taskIds().take(MAX_DIAGNOSTIC_TASKS).map { taskId ->
      val request = store.get(taskId)
      val states = runCatching {
        workManager.getWorkInfosForUniqueWork(workName(taskId))
          .get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
          .takeLast(3)
          .joinToString(",") { "${it.state}:attempt=${it.runAttemptCount}" }
      }.getOrElse { "query-failed:${it.javaClass.simpleName}" }
      "Resumable[${taskId.take(12)}]: ${states.ifEmpty { "none" }} " +
        "requiresWifi=${request?.requiresWifi} uploadSession=${store.getUploadId(taskId) != null}"
    }
    return if (lines.isEmpty()) "Resumable: none" else lines.joinToString("\n")
  }

  @Synchronized
  fun enqueueContinuation(context: Context, request: ResumableUploadRequest) {
    val operation = WorkManager.getInstance(context)
      .beginUniqueWork(workName(request.taskId), ExistingWorkPolicy.APPEND_OR_REPLACE, buildWork(request))
      .enqueue()
    operation.result.get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
  }

  @Synchronized
  fun cancelAll(context: Context) {
    WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
    ResumableUploadStore(context).clear()
    BackgroundWorkerPreferences(context).clearUploadQueue()
    UploadProgressNotifier(context).cancel()
  }

  internal fun buildWork(request: ResumableUploadRequest): OneTimeWorkRequest {
    val constraints = Constraints.Builder()
      .setRequiredNetworkType(requiredNetworkType(request.requiresWifi))
      .setRequiresBatteryNotLow(true)
      .build()
    return OneTimeWorkRequestBuilder<ResumableUploadWorker>()
      .setInputData(Data.Builder().putString(TASK_ID, request.taskId).build())
      .setConstraints(constraints)
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .addTag(TAG)
      .addTag(workName(request.taskId))
      .build()
  }

  internal fun diagnosticErrorMessage(error: Throwable): String =
    error.message.orEmpty().replace(Regex("[\\r\\n]+"), " ").take(MAX_DIAGNOSTIC_MESSAGE_LENGTH)

  private fun hasLiveWork(workManager: WorkManager, taskId: String): Boolean {
    return workManager.getWorkInfosForUniqueWork(workName(taskId))
      .get(WORK_INFO_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      .any { !it.state.isFinished }
  }

  private fun workName(taskId: String) = "$TAG/$taskId"

  internal fun requiredNetworkType(requiresWifi: Boolean): NetworkType =
    if (requiresWifi) NetworkType.UNMETERED else NetworkType.CONNECTED

  internal fun shouldDeferRunningPolicyReplacement(
    isRunning: Boolean,
    desiredRequiresWifi: Boolean,
  ): Boolean = isRunning && !desiredRequiresWifi

  internal fun shouldRecoverStoredWork(hasLiveWork: Boolean): Boolean = !hasLiveWork

  internal fun withNetworkPolicy(
    request: ResumableUploadRequest,
    requiresWifi: Boolean,
  ): ResumableUploadRequest = ResumableUploadRequest(
    taskId = request.taskId,
    serverUrl = request.serverUrl,
    serverUrlSource = request.serverUrlSource,
    filePath = request.filePath,
    filename = request.filename,
    fileSize = request.fileSize,
    checksum = request.checksum,
    headers = request.headers,
    fields = request.fields,
    requiresWifi = requiresWifi,
  )

  private const val WORK_INFO_TIMEOUT_SECONDS = 5L
  private const val MAX_DIAGNOSTIC_TASKS = 20
  private const val MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240
}
