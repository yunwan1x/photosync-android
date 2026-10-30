package app.alextran.immich.background

import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundWorkerApiImplTest {
  @Test
  fun `resumable network policy switches between wifi and cellular constraints`() {
    assertEquals(NetworkType.UNMETERED, ResumableUploadScheduler.requiredNetworkType(requiresWifi = true))
    assertEquals(NetworkType.CONNECTED, ResumableUploadScheduler.requiredNetworkType(requiresWifi = false))
  }

  @Test
  fun `resumable video work keeps wifi and battery constraints without illegal expedited mode`() {
    val request = ResumableUploadRequest(
      taskId = "large-video",
      serverUrl = "http://server/api",
      serverUrlSource = "txt://photos.example.test",
      filePath = "/media/large-video.mp4",
      filename = "large-video.mp4",
      fileSize = 128L * 1024 * 1024,
      checksum = "checksum",
      headers = mapOf("authorization" to "token"),
      fields = mapOf("deviceAssetId" to "large-video"),
      requiresWifi = true,
    )
    val work = ResumableUploadScheduler.buildWork(request)

    assertEquals(NetworkType.UNMETERED, work.workSpec.constraints.requiredNetworkType)
    assertTrue(work.workSpec.constraints.requiresBatteryNotLow())
    assertFalse(work.workSpec.expedited)
    assertEquals(BackoffPolicy.EXPONENTIAL, work.workSpec.backoffPolicy)
    assertEquals(30_000L, work.workSpec.backoffDelayDuration)
  }

  @Test
  fun `resumable enqueue diagnostic keeps the useful exception message on one line`() {
    val message = ResumableUploadScheduler.diagnosticErrorMessage(
      IllegalArgumentException("Expedited jobs only support network\nand storage constraints"),
    )

    assertEquals("Expedited jobs only support network and storage constraints", message)
  }

  @Test
  fun `network recovery waits for an unmetered wifi network`() {
    val request = BackgroundWorkerApiImpl.buildNetworkRecoveryWorkRequest()

    assertEquals(NetworkType.UNMETERED, request.workSpec.constraints.requiredNetworkType)
  }

  @Test
  fun `pending work arms recovery only while unmetered network is unavailable`() {
    assertTrue(
      BackgroundWorkerApiImpl.shouldArmNetworkRecovery(
        backupEnabled = true,
        hasPending = true,
        isUnmetered = false,
      ),
    )
    assertFalse(
      BackgroundWorkerApiImpl.shouldArmNetworkRecovery(
        backupEnabled = true,
        hasPending = true,
        isUnmetered = true,
      ),
    )
    assertFalse(
      BackgroundWorkerApiImpl.shouldArmNetworkRecovery(
        backupEnabled = false,
        hasPending = true,
        isUnmetered = false,
      ),
    )
  }

  @Test
  fun `stored resumable request is rebuilt when its workmanager entity is gone`() {
    assertTrue(ResumableUploadScheduler.shouldRecoverStoredWork(hasLiveWork = false))
    assertFalse(ResumableUploadScheduler.shouldRecoverStoredWork(hasLiveWork = true))
  }

  @Test
  fun `enabling cellular does not interrupt a running resumable chunk`() {
    assertTrue(
      ResumableUploadScheduler.shouldDeferRunningPolicyReplacement(
        isRunning = true,
        desiredRequiresWifi = false,
      ),
    )
    assertFalse(
      ResumableUploadScheduler.shouldDeferRunningPolicyReplacement(
        isRunning = true,
        desiredRequiresWifi = true,
      ),
    )
    assertFalse(
      ResumableUploadScheduler.shouldDeferRunningPolicyReplacement(
        isRunning = false,
        desiredRequiresWifi = false,
      ),
    )
  }

  @Test
  fun `resumable policy replacement preserves the upload request identity`() {
    val original = ResumableUploadRequest(
      taskId = "video-1",
      serverUrl = "http://server/api",
      serverUrlSource = "txt://photos.example.test",
      filePath = "/media/video.mp4",
      filename = "video.mp4",
      fileSize = 123456L,
      checksum = "checksum",
      headers = mapOf("authorization" to "token"),
      fields = mapOf("deviceAssetId" to "video-1"),
      requiresWifi = true,
    )

    val updated = ResumableUploadScheduler.withNetworkPolicy(original, requiresWifi = false)

    assertEquals(original.taskId, updated.taskId)
    assertEquals(original.serverUrl, updated.serverUrl)
    assertEquals(original.serverUrlSource, updated.serverUrlSource)
    assertEquals(original.filePath, updated.filePath)
    assertEquals(original.fileSize, updated.fileSize)
    assertEquals(original.checksum, updated.checksum)
    assertEquals(original.headers, updated.headers)
    assertEquals(original.fields, updated.fields)
    assertFalse(updated.requiresWifi)
  }

  @Test
  fun `run-now scheduling keeps a running background worker`() {
    assertFalse(BackgroundWorkerApiImpl.shouldReplaceForRunNow(isWorkerRunning = true))
    assertEquals(
      RunNowAction.KEEP,
      BackgroundWorkerApiImpl.selectRunNowAction(isLocked = false, isWorkerRunning = true),
    )
    assertEquals(
      ExistingWorkPolicy.KEEP,
      BackgroundWorkerApiImpl.backgroundWorkPolicy(replaceExisting = false),
    )
  }

  @Test
  fun `run-now scheduling replaces queued retry when no worker engine is running`() {
    assertTrue(BackgroundWorkerApiImpl.shouldReplaceForRunNow(isWorkerRunning = false))
    assertEquals(
      RunNowAction.REPLACE,
      BackgroundWorkerApiImpl.selectRunNowAction(isLocked = false, isWorkerRunning = false),
    )
    assertEquals(
      ExistingWorkPolicy.REPLACE,
      BackgroundWorkerApiImpl.backgroundWorkPolicy(replaceExisting = true),
    )
  }

  @Test
  fun `foreground run-now is deferred instead of unlocking a background engine`() {
    assertEquals(
      RunNowAction.DEFER,
      BackgroundWorkerApiImpl.selectRunNowAction(isLocked = true, isWorkerRunning = false),
    )
    assertEquals(
      RunNowAction.DEFER,
      BackgroundWorkerApiImpl.selectRunNowAction(isLocked = true, isWorkerRunning = true),
    )
  }

  @Test
  fun `worker completion guard accepts only the first completion`() {
    val guard = WorkerCompletionGuard()

    assertFalse(guard.isComplete)
    assertTrue(guard.tryComplete())
    assertTrue(guard.isComplete)
    assertFalse(guard.tryComplete())
  }

  @Test
  fun `observer scheduling keeps an already running background worker`() {
    assertEquals(
      ExistingWorkPolicy.KEEP,
      BackgroundWorkerApiImpl.backgroundWorkPolicy(replaceExisting = false),
    )
  }

  @Test
  fun `disabled backup cannot schedule native work`() {
    assertFalse(BackgroundWorkerApiImpl.shouldScheduleBackupWork(backupEnabled = false))
    assertTrue(BackgroundWorkerApiImpl.shouldScheduleBackupWork(backupEnabled = true))
  }

  @Test
  fun `expedited background request can be built`() {
    assertNotNull(BackgroundWorkerApiImpl.buildBackgroundWorkRequest())
  }

  @Test
  fun `periodic probe only runs for enabled backup with persistent pending work`() {
    assertTrue(PeriodicWorker.shouldRunAvailabilityProbe(backupEnabled = true, hasPending = true))
    assertFalse(PeriodicWorker.shouldRunAvailabilityProbe(backupEnabled = true, hasPending = false))
    assertFalse(PeriodicWorker.shouldRunAvailabilityProbe(backupEnabled = false, hasPending = true))
  }

  @Test
  fun `diagnostic event trace keeps newest two hundred forty events`() {
    var trace: String? = null
    repeat(260) { index ->
      trace = BackgroundWorkerPreferences.appendEventTrace(trace, "event-$index")
    }

    val events = trace!!.lines()
    assertEquals(240, events.size)
    assertFalse(events.contains("event-19"))
    assertTrue(events.contains("event-20"))
    assertTrue(events.contains("event-259"))
  }

  @Test
  fun `queue and native call events update the persistent stage snapshot`() {
    assertTrue(BackgroundWorkerPreferences.isStageSnapshotEvent("queue_step_start"))
    assertTrue(BackgroundWorkerPreferences.isStageSnapshotEvent("queue_asset_deferred"))
    assertTrue(BackgroundWorkerPreferences.isStageSnapshotEvent("native_call_start"))
    assertFalse(BackgroundWorkerPreferences.isStageSnapshotEvent("work_enqueue"))
  }

  @Test
  fun `legacy pending queue migrates waiting retries into remaining count`() {
    val state = UploadQueueState.fromStored(
      total = null,
      pending = 46,
      retrying = 3,
      completed = 0,
      failed = 0,
    )

    assertEquals(49, state.total)
    assertEquals(49, state.remaining)
    assertEquals(3, state.retrying)
    assertEquals(0, state.processed)
  }

  @Test
  fun `queue progress includes completed and failed items`() {
    val state = UploadQueueState(
      total = 98,
      pending = 46,
      retrying = 1,
      completed = 51,
      failed = 1,
    ).normalized()

    assertEquals(98, state.total)
    assertEquals(46, state.remaining)
    assertEquals(52, state.processed)
    assertFalse(state.isFinished)
  }

  @Test
  fun `queue is finished when no pending items remain`() {
    val state = UploadQueueState(total = 5, completed = 4, failed = 1).normalized()

    assertEquals(5, state.processed)
    assertTrue(state.isFinished)
  }

  @Test
  fun `overall snapshot always satisfies backed plus remaining equals total`() {
    val state = OverallBackupState(total = 1779, backedUp = 9999, remaining = 1231).normalized()

    assertEquals(1779, state.total)
    assertEquals(548, state.backedUp)
    assertEquals(1231, state.remaining)
    assertEquals(state.total, state.backedUp + state.remaining)
  }

  @Test
  fun `mixed upload queue is task-id idempotent`() {
    val ledger = UploadQueueLedger()
      .enqueue(listOf("photo-1", "video-small", "video-large"))
      .enqueue(listOf("photo-1", "video-large"))

    assertEquals(3, ledger.state.total)
    assertEquals(3, ledger.state.pending)
    assertEquals(0, ledger.state.processed)
  }

  @Test
  fun `retry is a pending subset and does not change queue total`() {
    val ledger = UploadQueueLedger()
      .enqueue(listOf("photo-1", "video-large"))
      .markRetrying("video-large")
      .markRetrying("video-large")

    assertEquals(2, ledger.state.total)
    assertEquals(2, ledger.state.pending)
    assertEquals(1, ledger.state.retrying)

    val resumed = ledger.markStarted("video-large", wasRetry = true)
    assertEquals(0, resumed.state.retrying)
    assertEquals(2, resumed.state.pending)
  }

  @Test
  fun `success and failure callbacks are idempotent and preserve queue invariant`() {
    val ledger = UploadQueueLedger()
      .enqueue(listOf("photo-1", "video-large", "photo-2"))
      .markSucceeded("photo-1")
      .markSucceeded("photo-1")
      .markFailed("video-large")
      .markFailed("video-large")

    assertEquals(3, ledger.state.total)
    assertEquals(1, ledger.state.completed)
    assertEquals(1, ledger.state.failed)
    assertEquals(1, ledger.state.pending)
    assertEquals(
      ledger.state.total,
      ledger.state.completed + ledger.state.failed + ledger.state.pending,
    )
  }

  @Test
  fun `persisted task sets reconstruct the same queue after process restart`() {
    val before = UploadQueueLedger()
      .enqueue((1..350).map { "asset-$it" })
      .markSucceeded("asset-1")
      .markRetrying("asset-2")
      .markFailed("asset-3")
    val after = UploadQueueLedger(
      pendingIds = before.pendingIds.toSet(),
      retryingIds = before.retryingIds.toSet(),
      completedIds = before.completedIds.toSet(),
      failedIds = before.failedIds.toSet(),
    )

    assertEquals(before.state, after.state)
    assertEquals(350, after.state.total)
    assertEquals(348, after.state.pending)
    assertEquals(1, after.state.retrying)
  }

  @Test
  fun `cancel removes task from current queue without changing completed work`() {
    val ledger = UploadQueueLedger()
      .enqueue(listOf("photo-1", "photo-2"))
      .markSucceeded("photo-1")
      .markCanceled("photo-2")

    assertEquals(1, ledger.state.total)
    assertEquals(1, ledger.state.completed)
    assertEquals(0, ledger.state.pending)
  }

  @Test
  fun `new queue starts cleanly after previous queue finishes`() {
    val previous = UploadQueueLedger()
      .enqueue(listOf("photo-1"))
      .markSucceeded("photo-1")
    val next = previous.enqueue(listOf("photo-2", "video-2"))

    assertEquals(2, next.state.total)
    assertEquals(2, next.state.pending)
    assertEquals(0, next.state.completed)
  }

  @Test
  fun `failed task can reenter pending and later complete`() {
    val failed = UploadQueueLedger()
      .enqueue(listOf("photo-1", "video-1"))
      .markFailed("video-1")

    val retried = failed.enqueue(listOf("video-1"))
    assertEquals(setOf("photo-1", "video-1"), retried.pendingIds)
    assertEquals(emptySet<String>(), retried.failedIds)

    val completed = retried.markSucceeded("video-1")
    assertEquals(setOf("photo-1"), completed.pendingIds)
    assertEquals(setOf("video-1"), completed.completedIds)
    assertEquals(0, completed.state.failed)
  }

  @Test
  fun `late success callback moves a failed task to completed`() {
    val ledger = UploadQueueLedger()
      .enqueue(listOf("photo-1", "video-1"))
      .markFailed("video-1")
      .markSucceeded("video-1")

    assertEquals(setOf("video-1"), ledger.completedIds)
    assertEquals(emptySet<String>(), ledger.failedIds)
    assertEquals(1, ledger.state.pending)
  }

  @Test
  fun `authoritative reconciliation removes stale pending tasks after callbacks are lost`() {
    val ledger = UploadQueueLedger()
      .enqueue((1..1334).map { "asset-$it" })
      .let { queued -> (1..1170).fold(queued) { state, index -> state.markSucceeded("asset-$index") } }
      .reconcile(activeTaskIds = emptySet(), failedTaskIds = emptySet())

    assertEquals(1170, ledger.state.total)
    assertEquals(1170, ledger.state.completed)
    assertEquals(0, ledger.state.pending)
    assertTrue(ledger.state.isFinished)
  }

  @Test
  fun `authoritative reconciliation preserves real work and failures while pruning stale ids`() {
    val ledger = UploadQueueLedger()
      .enqueue(listOf("active", "stale", "failed"))
      .markRetrying("active")
      .reconcile(
        activeTaskIds = setOf("active", "new-resumable"),
        failedTaskIds = setOf("failed"),
      )

    assertEquals(setOf("active", "new-resumable"), ledger.pendingIds)
    assertEquals(setOf("active"), ledger.retryingIds)
    assertEquals(setOf("failed"), ledger.failedIds)
    assertEquals(2, ledger.state.pending)
    assertEquals(1, ledger.state.failed)
  }

  @Test
  fun `stale queue snapshot cannot revive an upload confirmed successful`() {
    val ledger = UploadQueueLedger()
      .enqueue(listOf("video", "photo"))
      .markSucceeded("video")
      .reconcile(activeTaskIds = setOf("video", "photo"), failedTaskIds = setOf("video"))

    assertEquals(setOf("video"), ledger.completedIds)
    assertEquals(setOf("photo"), ledger.pendingIds)
    assertEquals(emptySet<String>(), ledger.failedIds)
  }

  @Test
  fun `successful completion is auto dismissible but failed completion is not`() {
    val overall = OverallBackupState(total = 10, backedUp = 10, remaining = 0)
    val completed = BackupProgressState(
      overall = overall,
      queue = UploadQueueState(total = 10, completed = 10),
    )
    val failed = BackupProgressState(
      overall = overall,
      queue = UploadQueueState(total = 10, completed = 9, failed = 1),
    )

    assertTrue(completed.shouldAutoDismissNotification)
    assertFalse(failed.shouldAutoDismissNotification)
    assertTrue(failed.isFinished)
  }
}
