package app.alextran.immich.background

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Process
import androidx.core.content.edit

class BackgroundWorkerPreferences(private val ctx: Context) {
  companion object {
    const val SHARED_PREF_NAME = "Immich::BackgroundWorker"
    private const val SHARED_PREF_MIN_DELAY_KEY = "BackgroundWorker::minDelaySeconds"
    private const val SHARED_PREF_REQUIRE_CHARGING_KEY = "BackgroundWorker::requireCharging"
    private const val SHARED_PREF_LOCK_KEY = "BackgroundWorker::isLocked"
    private const val SHARED_PREF_NOTIF_TITLE_KEY = "BackgroundWorker::notificationTitle"
    private const val SHARED_PREF_NOTIF_MSG_KEY = "BackgroundWorker::notificationMessage"
    private const val SHARED_PREF_BACKUP_ENABLED_KEY = "BackgroundWorker::backupEnabled"
    private const val SHARED_PREF_HAS_PENDING_BACKUP_KEY = "BackgroundWorker::hasPendingBackup"
    private const val SHARED_PREF_LAST_TRIGGER_KEY = "BackgroundWorker::lastTriggerAt"
    private const val SHARED_PREF_LAST_STARTED_KEY = "BackgroundWorker::lastStartedAt"
    private const val SHARED_PREF_LAST_SUCCEEDED_KEY = "BackgroundWorker::lastSucceededAt"
    private const val SHARED_PREF_LAST_ERROR_KEY = "BackgroundWorker::lastError"
    private const val SHARED_PREF_LAST_UPLOAD_SUCCEEDED_KEY = "BackgroundWorker::lastUploadSucceededAt"
    private const val SHARED_PREF_LAST_UPLOAD_ERROR_KEY = "BackgroundWorker::lastUploadError"
    private const val SHARED_PREF_PENDING_KEY = "BackgroundWorker::pendingCount"
    private const val SHARED_PREF_RETRYING_KEY = "BackgroundWorker::retryingCount"
    private const val SHARED_PREF_COMPLETED_KEY = "BackgroundWorker::completedCount"
    private const val SHARED_PREF_FAILED_KEY = "BackgroundWorker::failedCount"
    private const val SHARED_PREF_TOTAL_KEY = "BackgroundWorker::totalCount"
    private const val SHARED_PREF_PENDING_IDS_KEY = "BackgroundWorker::pendingIds"
    private const val SHARED_PREF_RETRYING_IDS_KEY = "BackgroundWorker::retryingIds"
    private const val SHARED_PREF_COMPLETED_IDS_KEY = "BackgroundWorker::completedIds"
    private const val SHARED_PREF_FAILED_IDS_KEY = "BackgroundWorker::failedIds"
    private const val SHARED_PREF_OVERALL_TOTAL_KEY = "BackgroundWorker::overallTotal"
    private const val SHARED_PREF_OVERALL_BACKED_UP_KEY = "BackgroundWorker::overallBackedUp"
    private const val SHARED_PREF_OVERALL_REMAINING_KEY = "BackgroundWorker::overallRemaining"
    private const val SHARED_PREF_EVENT_TRACE_KEY = "BackgroundWorker::diagnosticEventTrace"
    private const val SHARED_PREF_CURRENT_RUN_ID_KEY = "BackgroundWorker::currentRunId"
    private const val SHARED_PREF_CURRENT_RUN_ATTEMPT_KEY = "BackgroundWorker::currentRunAttempt"
    private const val SHARED_PREF_LAST_STAGE_EVENT_KEY = "BackgroundWorker::lastStageEvent"
    private const val SHARED_PREF_LAST_STAGE_DETAIL_KEY = "BackgroundWorker::lastStageDetail"
    private const val SHARED_PREF_LAST_STAGE_AT_KEY = "BackgroundWorker::lastStageAt"
    private const val SHARED_PREF_LAST_STAGE_RUN_KEY = "BackgroundWorker::lastStageRun"

    private const val DEFAULT_MIN_DELAY_SECONDS = 30L
    private const val DEFAULT_REQUIRE_CHARGING = false
    private const val DEFAULT_NOTIF_TITLE = "Uploading media"
    private const val DEFAULT_NOTIF_MSG = "Checking for new assets…"
    private const val MAX_EVENT_COUNT = 240
    private const val MAX_EVENT_LENGTH = 320
    private val QUEUE_LOCK = Any()

    internal fun appendEventTrace(existing: String?, event: String): String =
      (existing.orEmpty().lineSequence().filter { it.isNotBlank() } + sequenceOf(event))
        .toList()
        .takeLast(MAX_EVENT_COUNT)
        .joinToString("\n")

    internal fun isStageSnapshotEvent(event: String): Boolean =
      event.startsWith("queue_") || event.startsWith("native_call_")
  }

  private val sp: SharedPreferences by lazy {
    ctx.getSharedPreferences(SHARED_PREF_NAME, Context.MODE_PRIVATE)
  }

  fun updateSettings(settings: BackgroundWorkerSettings) {
    sp.edit {
      putLong(SHARED_PREF_MIN_DELAY_KEY, settings.minimumDelaySeconds)
      putBoolean(SHARED_PREF_REQUIRE_CHARGING_KEY, settings.requiresCharging)
    }
  }

  fun getSettings(): BackgroundWorkerSettings {
    val delaySeconds = sp.getLong(SHARED_PREF_MIN_DELAY_KEY, DEFAULT_MIN_DELAY_SECONDS)

    return BackgroundWorkerSettings(
      minimumDelaySeconds = if (delaySeconds >= 1000) delaySeconds / 1000 else delaySeconds,
      requiresCharging = sp.getBoolean(
        SHARED_PREF_REQUIRE_CHARGING_KEY,
        DEFAULT_REQUIRE_CHARGING
      ),
    )
  }

  fun updateNotificationConfig(title: String, message: String) {
    sp.edit {
      putString(SHARED_PREF_NOTIF_TITLE_KEY, title)
      putString(SHARED_PREF_NOTIF_MSG_KEY, message)
    }
  }

  fun getNotificationConfig(): Pair<String, String> {
    val title =
      sp.getString(SHARED_PREF_NOTIF_TITLE_KEY, DEFAULT_NOTIF_TITLE) ?: DEFAULT_NOTIF_TITLE
    val message = sp.getString(SHARED_PREF_NOTIF_MSG_KEY, DEFAULT_NOTIF_MSG) ?: DEFAULT_NOTIF_MSG
    return Pair(title, message)
  }

  fun setLocked(paused: Boolean) {
    sp.edit {
      putBoolean(SHARED_PREF_LOCK_KEY, paused)
    }
  }

  fun isLocked(): Boolean {
    return sp.getBoolean(SHARED_PREF_LOCK_KEY, true)
  }

  fun setBackupEnabled(enabled: Boolean) {
    sp.edit(commit = true) { putBoolean(SHARED_PREF_BACKUP_ENABLED_KEY, enabled) }
  }

  fun isBackupEnabled(): Boolean = sp.getBoolean(SHARED_PREF_BACKUP_ENABLED_KEY, true)

  fun setHasPendingBackup(hasPending: Boolean) {
    sp.edit(commit = true) { putBoolean(SHARED_PREF_HAS_PENDING_BACKUP_KEY, hasPending) }
  }

  fun hasPendingBackup(): Boolean = sp.getBoolean(SHARED_PREF_HAS_PENDING_BACKUP_KEY, true)

  fun recordTrigger() = putTimestamp(SHARED_PREF_LAST_TRIGGER_KEY)

  fun recordStarted() = putTimestamp(SHARED_PREF_LAST_STARTED_KEY)

  fun beginRun(runId: String, attempt: Int) {
    sp.edit(commit = true) {
      putString(SHARED_PREF_CURRENT_RUN_ID_KEY, runId)
      putInt(SHARED_PREF_CURRENT_RUN_ATTEMPT_KEY, attempt)
    }
    recordEvent("worker_start", "id=$runId attempt=$attempt")
  }

  fun endRun(result: String) {
    recordEvent("worker_complete", result)
    sp.edit(commit = true) {
      remove(SHARED_PREF_CURRENT_RUN_ID_KEY)
      remove(SHARED_PREF_CURRENT_RUN_ATTEMPT_KEY)
    }
  }

  fun recordSucceeded() {
    sp.edit {
      putLong(SHARED_PREF_LAST_SUCCEEDED_KEY, System.currentTimeMillis())
      remove(SHARED_PREF_LAST_ERROR_KEY)
    }
  }

  fun recordError(error: String) {
    sp.edit { putString(SHARED_PREF_LAST_ERROR_KEY, error.take(500)) }
    recordEvent("error", error)
  }

  fun recordUploadSucceeded() {
    sp.edit {
      putLong(SHARED_PREF_LAST_UPLOAD_SUCCEEDED_KEY, System.currentTimeMillis())
    }
  }

  fun clearUploadError() {
    sp.edit { remove(SHARED_PREF_LAST_UPLOAD_ERROR_KEY) }
  }

  fun recordUploadError(error: String) {
    sp.edit { putString(SHARED_PREF_LAST_UPLOAD_ERROR_KEY, error.take(500)) }
    recordEvent("upload_error", error)
  }

  fun recordDiagnosticEvent(event: String, detail: String? = null) {
    if (isStageSnapshotEvent(event)) {
      val safeDetail = sanitizeDetail(detail)
      sp.edit(commit = true) {
        putString(SHARED_PREF_LAST_STAGE_EVENT_KEY, event)
        putString(SHARED_PREF_LAST_STAGE_DETAIL_KEY, safeDetail)
        putLong(SHARED_PREF_LAST_STAGE_AT_KEY, System.currentTimeMillis())
        putString(
          SHARED_PREF_LAST_STAGE_RUN_KEY,
          sp.getString(SHARED_PREF_CURRENT_RUN_ID_KEY, null),
        )
      }
    }
    recordEvent(event, detail)
  }

  @Synchronized
  fun recordEvent(event: String, detail: String? = null) {
    val runId = sp.getString(SHARED_PREF_CURRENT_RUN_ID_KEY, null)
    val attempt = sp.getInt(SHARED_PREF_CURRENT_RUN_ATTEMPT_KEY, -1)
    val safeDetail = sanitizeDetail(
      listOfNotNull(
        runId?.let { "run=$it" },
        attempt.takeIf { it >= 0 }?.let { "attempt=$it" },
        detail,
      ).joinToString(" ").takeIf { it.isNotBlank() },
    )
    val line = buildString {
      append(System.currentTimeMillis())
      append('|')
      append(Process.myPid())
      append('|')
      append(event)
      if (!safeDetail.isNullOrBlank()) {
        append('|')
        append(safeDetail)
      }
    }
    val updated = appendEventTrace(sp.getString(SHARED_PREF_EVENT_TRACE_KEY, null), line)
    sp.edit { putString(SHARED_PREF_EVENT_TRACE_KEY, updated) }
  }

  private fun sanitizeDetail(detail: String?): String? =
    detail
      ?.replace('\n', ' ')
      ?.replace('\r', ' ')
      ?.take(MAX_EVENT_LENGTH)

  fun getEventTrace(): String = sp.getString(SHARED_PREF_EVENT_TRACE_KEY, "").orEmpty()

  internal fun reconcileOverall(total: Int, backedUp: Int, remaining: Int): BackupProgressState =
    synchronized(QUEUE_LOCK) {
      val incoming = OverallBackupState(total, backedUp, remaining).normalized()
      val current = getOverallStateLocked()
      val queue = getQueueLedgerLocked()
      val overall = if (
        queue.pendingIds.isNotEmpty() &&
        incoming.total == current.total &&
        incoming.backedUp < current.backedUp
      ) {
        current
      } else {
        incoming
      }
      saveOverallStateLocked(overall)
      BackupProgressState(overall, queue.state)
    }

  internal fun enqueueUploads(taskIds: Collection<String>): BackupProgressState = synchronized(QUEUE_LOCK) {
    if (taskIds.isEmpty()) return@synchronized getProgressStateLocked()
    val updated = getQueueLedgerLocked().enqueue(taskIds)
    saveQueueLedgerLocked(updated)
    BackupProgressState(getOverallStateLocked(), updated.state)
  }

  internal fun reconcileUploadQueue(
    activeTaskIds: Collection<String>,
    failedTaskIds: Collection<String>,
  ): BackupProgressState = synchronized(QUEUE_LOCK) {
    val updated = getQueueLedgerLocked().reconcile(activeTaskIds, failedTaskIds)
    saveQueueLedgerLocked(updated)
    BackupProgressState(getOverallStateLocked(), updated.state)
  }

  internal fun markUploadStarted(taskId: String, wasRetry: Boolean): BackupProgressState? =
    updateEnabledProgressState { ledger ->
      ledger.markStarted(taskId, wasRetry)
    }

  internal fun markUploadSucceeded(taskId: String): BackupProgressState? = synchronized(QUEUE_LOCK) {
    if (!isBackupEnabled()) return@synchronized null
    val current = getQueueLedgerLocked()
    val updated = current.markSucceeded(taskId)
    if (updated == current) return@synchronized BackupProgressState(getOverallStateLocked(), current.state)
    saveQueueLedgerLocked(updated)
    val overall = getOverallStateLocked().markSucceeded()
    saveOverallStateLocked(overall)
    BackupProgressState(overall, updated.state)
  }

  internal fun markUploadRetrying(taskId: String): BackupProgressState? =
    updateEnabledProgressState { ledger ->
      ledger.markRetrying(taskId)
    }

  internal fun markUploadFailed(taskId: String): BackupProgressState? =
    updateEnabledProgressState { ledger ->
      ledger.markFailed(taskId)
    }

  internal fun markUploadCanceled(taskId: String): BackupProgressState? =
    updateEnabledProgressState { ledger ->
      ledger.markCanceled(taskId)
    }

  internal fun getProgressState(): BackupProgressState = synchronized(QUEUE_LOCK) { getProgressStateLocked() }

  internal fun getQueueState(): UploadQueueState = synchronized(QUEUE_LOCK) { getQueueLedgerLocked().state }

  internal fun clearUploadQueue() {
    synchronized(QUEUE_LOCK) { saveQueueLedgerLocked(UploadQueueLedger()) }
  }

  fun getDiagnostics(systemState: String? = null): BackgroundWorkerDiagnostics {
    val queue = getQueueState()
    return BackgroundWorkerDiagnostics(
      lastTriggerAt = getTimestamp(SHARED_PREF_LAST_TRIGGER_KEY),
      lastStartedAt = getTimestamp(SHARED_PREF_LAST_STARTED_KEY),
      lastSucceededAt = getTimestamp(SHARED_PREF_LAST_SUCCEEDED_KEY),
      pendingCount = queue.pending.toLong(),
      retryingCount = queue.retrying.toLong(),
      failedCount = queue.failed.toLong(),
      lastError = buildString {
        append("Device: ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})")
        if (!systemState.isNullOrBlank()) {
          append("\n")
          append(systemState)
        }
        sp.getString(SHARED_PREF_LAST_ERROR_KEY, null)?.let {
          append("\nLast worker error: ")
          append(it)
        }
        getTimestamp(SHARED_PREF_LAST_UPLOAD_SUCCEEDED_KEY)?.let {
          append("\nLast upload success: ")
          append(it)
        }
        sp.getString(SHARED_PREF_LAST_UPLOAD_ERROR_KEY, null)?.let {
          append("\nLast upload error: ")
          append(it)
        }
        sp.getString(SHARED_PREF_LAST_STAGE_EVENT_KEY, null)?.let { event ->
          append("\nLast queue stage: ")
          append(event)
          sp.getString(SHARED_PREF_LAST_STAGE_RUN_KEY, null)?.let {
            append(" run=")
            append(it)
          }
          val stageAt = sp.getLong(SHARED_PREF_LAST_STAGE_AT_KEY, 0)
          if (stageAt > 0) {
            append(" at=")
            append(stageAt)
          }
          sp.getString(SHARED_PREF_LAST_STAGE_DETAIL_KEY, null)?.takeIf { it.isNotBlank() }?.let {
            append("\nLast queue detail: ")
            append(it)
          }
        }
        val trace = getEventTrace()
        if (trace.isNotBlank()) {
          append("\nEvent trace (epochMs|pid|event|detail):\n")
          append(trace)
        }
      },
    )
  }

  private fun putTimestamp(key: String) {
    sp.edit { putLong(key, System.currentTimeMillis()) }
  }

  private fun getTimestamp(key: String): Long? {
    val value = sp.getLong(key, 0)
    return value.takeIf { it > 0 }
  }

  private fun updateEnabledProgressState(
    update: (UploadQueueLedger) -> UploadQueueLedger,
  ): BackupProgressState? =
    synchronized(QUEUE_LOCK) {
      if (!isBackupEnabled()) return@synchronized null
      val updated = update(getQueueLedgerLocked())
      saveQueueLedgerLocked(updated)
      BackupProgressState(getOverallStateLocked(), updated.state)
    }

  private fun getProgressStateLocked() = BackupProgressState(
    overall = getOverallStateLocked(),
    queue = getQueueLedgerLocked().state,
  )

  private fun getOverallStateLocked() = OverallBackupState(
    total = sp.getInt(SHARED_PREF_OVERALL_TOTAL_KEY, 0),
    backedUp = sp.getInt(SHARED_PREF_OVERALL_BACKED_UP_KEY, 0),
    remaining = sp.getInt(SHARED_PREF_OVERALL_REMAINING_KEY, 0),
  ).normalized()

  private fun saveOverallStateLocked(state: OverallBackupState) {
    sp.edit(commit = true) {
      putInt(SHARED_PREF_OVERALL_TOTAL_KEY, state.total)
      putInt(SHARED_PREF_OVERALL_BACKED_UP_KEY, state.backedUp)
      putInt(SHARED_PREF_OVERALL_REMAINING_KEY, state.remaining)
    }
  }

  private fun getQueueLedgerLocked(): UploadQueueLedger {
    if (!sp.contains(SHARED_PREF_PENDING_IDS_KEY) &&
      !sp.contains(SHARED_PREF_COMPLETED_IDS_KEY) &&
      !sp.contains(SHARED_PREF_FAILED_IDS_KEY)
    ) {
      return UploadQueueLedger()
    }
    return UploadQueueLedger(
      pendingIds = sp.getStringSet(SHARED_PREF_PENDING_IDS_KEY, emptySet()).orEmpty().toSet(),
      retryingIds = sp.getStringSet(SHARED_PREF_RETRYING_IDS_KEY, emptySet()).orEmpty().toSet(),
      completedIds = sp.getStringSet(SHARED_PREF_COMPLETED_IDS_KEY, emptySet()).orEmpty().toSet(),
      failedIds = sp.getStringSet(SHARED_PREF_FAILED_IDS_KEY, emptySet()).orEmpty().toSet(),
    )
  }

  private fun saveQueueLedgerLocked(ledger: UploadQueueLedger) {
    val state = ledger.state
    sp.edit(commit = true) {
      putStringSet(SHARED_PREF_PENDING_IDS_KEY, ledger.pendingIds)
      putStringSet(SHARED_PREF_RETRYING_IDS_KEY, ledger.retryingIds)
      putStringSet(SHARED_PREF_COMPLETED_IDS_KEY, ledger.completedIds)
      putStringSet(SHARED_PREF_FAILED_IDS_KEY, ledger.failedIds)
      putInt(SHARED_PREF_TOTAL_KEY, state.total)
      putInt(SHARED_PREF_PENDING_KEY, state.pending)
      putInt(SHARED_PREF_RETRYING_KEY, state.retrying)
      putInt(SHARED_PREF_COMPLETED_KEY, state.completed)
      putInt(SHARED_PREF_FAILED_KEY, state.failed)
    }
  }

}

internal enum class RunNowAction {
  DEFER,
  KEEP,
  REPLACE,
}

internal data class OverallBackupState(
  val total: Int = 0,
  val backedUp: Int = 0,
  val remaining: Int = 0,
) {
  fun normalized(): OverallBackupState {
    val safeTotal = total.coerceAtLeast(0)
    val safeRemaining = remaining.coerceIn(0, safeTotal)
    return OverallBackupState(
      total = safeTotal,
      backedUp = safeTotal - safeRemaining,
      remaining = safeRemaining,
    )
  }

  fun markSucceeded(): OverallBackupState {
    val current = normalized()
    if (current.remaining == 0) return current
    return current.copy(backedUp = current.backedUp + 1, remaining = current.remaining - 1)
  }
}

internal data class BackupProgressState(
  val overall: OverallBackupState = OverallBackupState(),
  val queue: UploadQueueState = UploadQueueState(),
) {
  val isFinished: Boolean
    get() {
      val displayRemaining = if (overall.total > 0) overall.remaining else queue.remaining
      return displayRemaining == 0 && queue.remaining == 0 && (overall.total > 0 || queue.total > 0)
    }

  val shouldAutoDismissNotification: Boolean
    get() = isFinished && queue.failed == 0
}

internal data class UploadQueueLedger(
  val pendingIds: Set<String> = emptySet(),
  val retryingIds: Set<String> = emptySet(),
  val completedIds: Set<String> = emptySet(),
  val failedIds: Set<String> = emptySet(),
) {
  val state: UploadQueueState
    get() = UploadQueueState(
      total = pendingIds.size + completedIds.size + failedIds.size,
      pending = pendingIds.size,
      retrying = retryingIds.intersect(pendingIds).size,
      completed = completedIds.size,
      failed = failedIds.size,
    )

  fun enqueue(taskIds: Collection<String>): UploadQueueLedger {
    val base = if (state.isFinished) UploadQueueLedger() else this
    val requested = taskIds.asSequence().filter(String::isNotBlank).toSet()
    val retryingFailures = requested.intersect(base.failedIds)
    val additions = requested - base.pendingIds - base.completedIds
    return base.copy(
      pendingIds = base.pendingIds + additions,
      retryingIds = base.retryingIds - retryingFailures,
      failedIds = base.failedIds - retryingFailures,
    ).normalized()
  }

  fun markStarted(taskId: String, wasRetry: Boolean): UploadQueueLedger {
    val withPending = ensurePending(taskId)
    return if (wasRetry) withPending.copy(retryingIds = withPending.retryingIds - taskId) else withPending
  }

  fun markSucceeded(taskId: String): UploadQueueLedger {
    if (taskId in completedIds) return this
    val withPending = if (taskId in failedIds) {
      copy(failedIds = failedIds - taskId, pendingIds = pendingIds + taskId)
    } else {
      ensurePending(taskId)
    }
    return withPending.copy(
      pendingIds = withPending.pendingIds - taskId,
      retryingIds = withPending.retryingIds - taskId,
      completedIds = withPending.completedIds + taskId,
    ).normalized()
  }

  fun markRetrying(taskId: String): UploadQueueLedger {
    val withPending = ensurePending(taskId)
    return withPending.copy(retryingIds = withPending.retryingIds + taskId).normalized()
  }

  fun markFailed(taskId: String): UploadQueueLedger {
    if (taskId in completedIds || taskId in failedIds) return this
    val withPending = ensurePending(taskId)
    return withPending.copy(
      pendingIds = withPending.pendingIds - taskId,
      retryingIds = withPending.retryingIds - taskId,
      failedIds = withPending.failedIds + taskId,
    ).normalized()
  }

  fun markCanceled(taskId: String): UploadQueueLedger = copy(
    pendingIds = pendingIds - taskId,
    retryingIds = retryingIds - taskId,
    completedIds = completedIds - taskId,
    failedIds = failedIds - taskId,
  ).normalized()

  fun reconcile(
    activeTaskIds: Collection<String>,
    failedTaskIds: Collection<String>,
  ): UploadQueueLedger {
    // A queue snapshot may predate a successful upload callback.
    val active = activeTaskIds.asSequence().filter(String::isNotBlank).toSet() - completedIds
    val failed = failedTaskIds.asSequence().filter(String::isNotBlank).toSet() - active - completedIds
    return copy(
      pendingIds = active,
      retryingIds = retryingIds.intersect(active),
      completedIds = completedIds - active - failed,
      failedIds = failed,
    ).normalized()
  }

  private fun ensurePending(taskId: String): UploadQueueLedger {
    if (taskId.isBlank() || taskId in pendingIds || taskId in completedIds || taskId in failedIds) return this
    return copy(pendingIds = pendingIds + taskId)
  }

  private fun normalized(): UploadQueueLedger = copy(
    retryingIds = retryingIds.intersect(pendingIds),
    completedIds = completedIds - pendingIds - failedIds,
    failedIds = failedIds - pendingIds,
  )
}

internal data class UploadQueueState(
  val total: Int = 0,
  val pending: Int = 0,
  val retrying: Int = 0,
  val completed: Int = 0,
  val failed: Int = 0,
) {
  val remaining: Int
    get() = pending

  val processed: Int
    get() = completed + failed

  val isFinished: Boolean
    get() = total > 0 && remaining == 0

  fun normalized(): UploadQueueState {
    val normalized = copy(
      pending = pending.coerceAtLeast(0),
      retrying = retrying.coerceIn(0, pending.coerceAtLeast(0)),
      completed = completed.coerceAtLeast(0),
      failed = failed.coerceAtLeast(0),
    )
    val observedTotal = normalized.pending + normalized.completed + normalized.failed
    return normalized.copy(total = maxOf(normalized.total, observedTotal))
  }

  companion object {
    internal fun fromStored(
      total: Int?,
      pending: Int,
      retrying: Int,
      completed: Int,
      failed: Int,
    ): UploadQueueState {
      if (total == null) {
        val legacyPending = pending.coerceAtLeast(0)
        val legacyRetrying = retrying.coerceAtLeast(0)
        val legacyFailed = failed.coerceAtLeast(0)
        return UploadQueueState(
          total = legacyPending + legacyRetrying + legacyFailed,
          pending = legacyPending + legacyRetrying,
          retrying = legacyRetrying,
          failed = legacyFailed,
        ).normalized()
      }
      return UploadQueueState(total, pending, retrying, completed, failed).normalized()
    }
  }
}
