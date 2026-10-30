package app.alextran.immich.background

import android.content.Context
import app.alextran.immich.backupprogress.BackupProgressHostApi

class BackupProgressApiImpl(context: Context) : BackupProgressHostApi {
  private val preferences = BackgroundWorkerPreferences(context.applicationContext)
  private val notifier = UploadProgressNotifier(context.applicationContext)

  override fun reconcile(total: Long, backedUp: Long, remaining: Long) {
    val state = preferences.reconcileOverall(
      total = total.toSafeInt(),
      backedUp = backedUp.toSafeInt(),
      remaining = remaining.toSafeInt(),
    )
    if (state.queue.remaining > 0) {
      notifier.update(state)
    }
  }

  override fun reconcileQueue(activeTaskIds: List<String>, failedTaskIds: List<String>) {
    notifier.update(preferences.reconcileUploadQueue(activeTaskIds, failedTaskIds))
  }

  override fun enqueue(taskIds: List<String>) {
    notifier.update(preferences.enqueueUploads(taskIds))
  }

  override fun markSucceeded(taskId: String) {
    preferences.markUploadSucceeded(taskId)?.let(notifier::update)
  }

  override fun markRetrying(taskId: String) {
    preferences.markUploadRetrying(taskId)?.let(notifier::update)
  }

  override fun markFailed(taskId: String) {
    preferences.markUploadFailed(taskId)?.let(notifier::update)
  }

  override fun markCanceled(taskId: String) {
    preferences.markUploadCanceled(taskId)?.let(notifier::update)
  }

  override fun updateFileProgress(
    taskId: String,
    filename: String,
    uploadedBytes: Long,
    totalBytes: Long,
  ) {
    preferences.markUploadStarted(taskId, wasRetry = true)?.let {
      notifier.update(
        it,
        filename = filename,
        uploadedBytes = uploadedBytes.coerceAtLeast(0),
        totalBytes = totalBytes.coerceAtLeast(0),
      )
    }
  }

  override fun clearQueue() {
    preferences.clearUploadQueue()
    notifier.cancel()
  }

  private fun Long.toSafeInt(): Int = coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
}
