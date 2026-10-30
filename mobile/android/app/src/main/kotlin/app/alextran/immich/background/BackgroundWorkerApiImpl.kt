package app.alextran.immich.background

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.app.ActivityManager
import android.app.NotificationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import android.provider.MediaStore
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.common.util.concurrent.MoreExecutors
import io.flutter.embedding.engine.FlutterEngineCache
import java.util.concurrent.TimeUnit

private const val TAG = "BackgroundWorkerApiImpl"

class BackgroundWorkerApiImpl(context: Context) : BackgroundWorkerFgHostApi {
  private val ctx: Context = context.applicationContext

  override fun enable() {
    val preferences = BackgroundWorkerPreferences(ctx).apply {
      setBackupEnabled(true)
      setHasPendingBackup(true)
      recordEvent("backup_enabled")
    }
    enqueueMediaObserver(ctx)
    enqueuePeriodicWorker(ctx)
    updateNetworkRecoveryWork(ctx, preferences)
  }

  override fun saveNotificationMessage(title: String, body: String) {
    BackgroundWorkerPreferences(ctx).updateNotificationConfig(title, body)
  }

  override fun configure(settings: BackgroundWorkerSettings) {
    val preferences = BackgroundWorkerPreferences(ctx)
    preferences.updateSettings(settings)
    if (shouldScheduleBackupWork(preferences.isBackupEnabled())) {
      enqueueMediaObserver(ctx)
      enqueuePeriodicWorker(ctx)
    }
  }

  override fun getDiagnostics(): BackgroundWorkerDiagnostics {
    val preferences = BackgroundWorkerPreferences(ctx)
    return preferences.getDiagnostics(buildSystemState(ctx))
  }

  override fun enqueueResumableUploads(requests: List<ResumableUploadRequest>) {
    ResumableUploadScheduler.enqueue(ctx, requests)
  }

  override fun refreshResumableUploadNetworkPolicy(requiresWifi: Boolean): Long {
    return ResumableUploadScheduler.refreshNetworkPolicy(ctx, requiresWifi).toLong()
  }

  override fun getPendingResumableUploadIds(): List<String> {
    return ResumableUploadScheduler.claimedTaskIds(ctx)
  }

  override fun getCompletedResumableUploads(): Map<String, String> {
    return ResumableUploadStore(ctx).completedChecksums()
  }

  override fun clearCompletedResumableUploads(taskIds: List<String>) {
    ResumableUploadStore(ctx).clearCompleted(taskIds)
  }

  override fun setBackupPendingState(hasPending: Boolean) {
    val preferences = BackgroundWorkerPreferences(ctx)
    preferences.setHasPendingBackup(hasPending)
    updateNetworkRecoveryWork(ctx, preferences)
  }

  override fun runNow() {
    val preferences = BackgroundWorkerPreferences(ctx)
    if (!shouldScheduleBackupWork(preferences.isBackupEnabled())) {
      preferences.recordEvent("run_now_skipped", "backup disabled")
      return
    }
    preferences.setHasPendingBackup(true)
    val action = selectRunNowAction(
      isLocked = preferences.isLocked(),
      isWorkerRunning = isBackgroundWorkerRunning(),
    )
    if (action == RunNowAction.DEFER) {
      preferences.recordEvent("run_now_deferred", "foreground lock active")
      updateNetworkRecoveryWork(ctx, preferences, force = true)
      return
    }
    scheduleRunNow(ctx, preferences, action, "run_now")
  }

  override fun handoffToBackground() {
    val preferences = BackgroundWorkerPreferences(ctx)
    if (!shouldScheduleBackupWork(preferences.isBackupEnabled())) {
      preferences.recordEvent("background_handoff_skipped", "backup disabled")
      return
    }
    preferences.apply {
      setHasPendingBackup(true)
      setLocked(false)
    }
    val action = selectRunNowAction(isLocked = false, isWorkerRunning = isBackgroundWorkerRunning())
    scheduleRunNow(ctx, preferences, action, "background_handoff")
  }

  override fun disable() {
    BackgroundWorkerPreferences(ctx).apply {
      setBackupEnabled(false)
      setHasPendingBackup(false)
      setLocked(true)
      recordEvent("backup_disabled")
    }
    WorkManager.getInstance(ctx).apply {
      cancelUniqueWork(OBSERVER_WORKER_NAME)
      cancelUniqueWork(BACKGROUND_WORKER_NAME)
      cancelUniqueWork(PERIODIC_WORKER_NAME)
      cancelUniqueWork(NETWORK_RECOVERY_WORKER_NAME)
    }
    ResumableUploadScheduler.cancelAll(ctx)
    FlutterEngineCache.getInstance().remove(ENGINE_CACHE_KEY)
    Log.i(TAG, "Cancelled background upload tasks")
  }

  companion object {
    private const val BACKGROUND_WORKER_NAME = "immich/BackgroundWorkerV1"
    private const val OBSERVER_WORKER_NAME = "immich/MediaObserverV1"
    private const val PERIODIC_WORKER_NAME = "immich/PeriodicBackgroundWorkerV1"
    private const val NETWORK_RECOVERY_WORKER_NAME = "immich/NetworkRecoveryWorkerV1"
    const val ENGINE_CACHE_KEY = "immich::background_worker::engine"

    fun enqueueMediaObserver(ctx: Context, rearm: Boolean = false) {
      val preferences = BackgroundWorkerPreferences(ctx)
      if (!shouldScheduleBackupWork(preferences.isBackupEnabled())) return
      val settings = preferences.getSettings()
      val constraints = Constraints.Builder().apply {
        addContentUriTrigger(MediaStore.Images.Media.INTERNAL_CONTENT_URI, true)
        addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
        addContentUriTrigger(MediaStore.Video.Media.INTERNAL_CONTENT_URI, true)
        addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
        setTriggerContentUpdateDelay(settings.minimumDelaySeconds, TimeUnit.SECONDS)
        setTriggerContentMaxDelay(settings.minimumDelaySeconds * 10, TimeUnit.SECONDS)
        setRequiresCharging(settings.requiresCharging)
        setRequiredNetworkType(NetworkType.CONNECTED)
      }.build()

      val work = OneTimeWorkRequestBuilder<MediaObserver>()
        .setConstraints(constraints)
        .build()
      WorkManager.getInstance(ctx)
        .enqueueUniqueWork(
          OBSERVER_WORKER_NAME,
          if (rearm) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.REPLACE,
          work,
        )

      Log.i(
        TAG,
        "Enqueued media observer worker with name: $OBSERVER_WORKER_NAME and settings: $settings"
      )
    }

    fun enqueuePeriodicWorker(ctx: Context) {
      val preferences = BackgroundWorkerPreferences(ctx)
      if (!shouldScheduleBackupWork(preferences.isBackupEnabled())) return
      val settings = preferences.getSettings()
      val constraints = Constraints.Builder().apply {
        setRequiresCharging(settings.requiresCharging)
        setRequiredNetworkType(NetworkType.CONNECTED)
      }.build()

      val work =
        PeriodicWorkRequestBuilder<PeriodicWorker>(
          15,
          TimeUnit.MINUTES,
          15,
          TimeUnit.MINUTES
        ).setConstraints(constraints)
          .build()

      WorkManager.getInstance(ctx)
        .enqueueUniquePeriodicWork(PERIODIC_WORKER_NAME, ExistingPeriodicWorkPolicy.UPDATE, work)

      Log.i(TAG, "Enqueued periodic background worker with name: $PERIODIC_WORKER_NAME")
    }

    internal fun backgroundWorkPolicy(replaceExisting: Boolean): ExistingWorkPolicy =
      if (replaceExisting) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP

    internal fun shouldReplaceForRunNow(isWorkerRunning: Boolean): Boolean = !isWorkerRunning

    internal fun selectRunNowAction(isLocked: Boolean, isWorkerRunning: Boolean): RunNowAction = when {
      isLocked -> RunNowAction.DEFER
      isWorkerRunning -> RunNowAction.KEEP
      else -> RunNowAction.REPLACE
    }

    internal fun shouldScheduleBackupWork(backupEnabled: Boolean): Boolean = backupEnabled

    internal fun buildBackgroundWorkRequest() =
      OneTimeWorkRequestBuilder<BackgroundWorker>()
        .setConstraints(
          Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        )
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .build()

    internal fun buildNetworkRecoveryWorkRequest() =
      OneTimeWorkRequestBuilder<NetworkRecoveryWorker>()
        .setConstraints(
          Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build()
        )
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .build()

    internal fun shouldArmNetworkRecovery(
      backupEnabled: Boolean,
      hasPending: Boolean,
      isUnmetered: Boolean,
    ): Boolean = backupEnabled && hasPending && !isUnmetered

    internal fun updateNetworkRecoveryWork(
      ctx: Context,
      preferences: BackgroundWorkerPreferences = BackgroundWorkerPreferences(ctx),
      force: Boolean = false,
    ) {
      val workManager = WorkManager.getInstance(ctx)
      if (!preferences.isBackupEnabled() || !preferences.hasPendingBackup()) {
        workManager.cancelUniqueWork(NETWORK_RECOVERY_WORKER_NAME)
        preferences.recordEvent("network_recovery_disarmed", "pending=false")
        return
      }
      val isUnmetered = isUnmeteredNetwork(ctx)
      if (!force && !shouldArmNetworkRecovery(true, true, isUnmetered)) {
        return
      }
      val work = buildNetworkRecoveryWorkRequest()
      workManager.enqueueUniqueWork(
        NETWORK_RECOVERY_WORKER_NAME,
        ExistingWorkPolicy.KEEP,
        work,
      )
      preferences.recordEvent(
        "network_recovery_armed",
        "id=${work.id} force=$force unmetered=$isUnmetered",
      )
    }

    internal fun isUnmeteredNetwork(ctx: Context): Boolean {
      val connectivity = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
      return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    fun enqueueBackgroundWorker(ctx: Context, replaceExisting: Boolean = false) {
      val preferences = BackgroundWorkerPreferences(ctx)
      if (!shouldScheduleBackupWork(preferences.isBackupEnabled())) {
        preferences.recordEvent("work_enqueue_skipped", "backup disabled")
        return
      }
      preferences.recordTrigger()
      val work = buildBackgroundWorkRequest()
      preferences.recordEvent(
        "work_enqueue",
        "id=${work.id} policy=${backgroundWorkPolicy(replaceExisting)} network=CONNECTED expedited=true",
      )
      val operation = WorkManager.getInstance(ctx)
        .enqueueUniqueWork(BACKGROUND_WORKER_NAME, backgroundWorkPolicy(replaceExisting), work)
      operation.result.addListener(
        {
          try {
            operation.result.get()
            preferences.recordEvent("work_enqueue_committed", "id=${work.id}")
          } catch (error: Exception) {
            preferences.recordEvent("work_enqueue_failed", "id=${work.id} ${error.message}")
          }
        },
        MoreExecutors.directExecutor(),
      )

      Log.i(TAG, "Enqueued background worker with name: $BACKGROUND_WORKER_NAME")
    }

    private fun scheduleRunNow(
      ctx: Context,
      preferences: BackgroundWorkerPreferences,
      action: RunNowAction,
      event: String,
    ) {
      val replaceExisting = action == RunNowAction.REPLACE
      preferences.recordEvent(
        event,
        if (replaceExisting) "replace queued work" else "keep running work",
      )
      enqueueBackgroundWorker(ctx, replaceExisting = replaceExisting)
    }

    fun isBackgroundWorkerRunning(): Boolean {
      // Easier to check if the engine is cached as we always cache the engine when starting the worker
      // and remove it when the worker is finished
      return FlutterEngineCache.getInstance().get(ENGINE_CACHE_KEY) != null
    }

    fun cancelBackgroundWorker(ctx: Context) {
      BackgroundWorkerPreferences(ctx).recordEvent("work_cancel_requested")
      WorkManager.getInstance(ctx).cancelUniqueWork(BACKGROUND_WORKER_NAME)
      FlutterEngineCache.getInstance().remove(ENGINE_CACHE_KEY)

      Log.i(TAG, "Cancelled background upload task")
    }

    internal fun buildSystemState(ctx: Context): String {
      val activityManager = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val notificationManager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val powerManager = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      val workManager = WorkManager.getInstance(ctx)
      val workState = listOf(
        BACKGROUND_WORKER_NAME,
        OBSERVER_WORKER_NAME,
        PERIODIC_WORKER_NAME,
        NETWORK_RECOVERY_WORKER_NAME,
      ).joinToString("\n") { name ->
        try {
          val infos = workManager.getWorkInfosForUniqueWork(name).get(2, TimeUnit.SECONDS)
          val summary = if (infos.isEmpty()) {
            "none"
          } else {
            infos.takeLast(4).joinToString(", ") {
              "${it.id}:${it.state}:attempt=${it.runAttemptCount}"
            }
          }
          "Work[$name]: $summary"
        } catch (error: Exception) {
          "Work[$name]: query failed: ${error.javaClass.simpleName}: ${error.message}"
        }
      }
      return buildString {
        val connectivity = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        val battery = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val batteryLevel = battery?.getIntExtra("level", -1) ?: -1
        val batteryScale = battery?.getIntExtra("scale", -1) ?: -1
        val batteryPercent = if (batteryLevel >= 0 && batteryScale > 0) batteryLevel * 100 / batteryScale else -1
        append("Background restricted: ${activityManager.isBackgroundRestricted}")
        append("\nIgnoring battery optimizations: ${powerManager.isIgnoringBatteryOptimizations(ctx.packageName)}")
        append("\nNotifications enabled: ${notificationManager.areNotificationsEnabled()}")
        append(
          "\nNetwork: validated=${capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true} " +
            "unmetered=${capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true} " +
            "wifi=${capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true}",
        )
        append("\nBattery: percent=$batteryPercent low=${batteryPercent in 0..15}")
        append("\n$workState")
        append("\n${ResumableUploadScheduler.diagnosticSummary(ctx)}")
      }
    }
  }
}

class NetworkRecoveryWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  private val ctx = context.applicationContext

  override fun doWork(): Result {
    val preferences = BackgroundWorkerPreferences(ctx)
    if (!preferences.isBackupEnabled() || !preferences.hasPendingBackup()) {
      preferences.recordEvent("network_recovery_skipped", "backup disabled or queue empty")
      return Result.success()
    }

    val recovered = runCatching { ResumableUploadScheduler.recoverMissingWork(ctx) }
      .onFailure {
        preferences.recordEvent(
          "network_recovery_resumable_failed",
          it.javaClass.simpleName,
        )
      }
      .getOrDefault(0)
    if (preferences.isLocked()) {
      preferences.recordEvent(
        "network_recovery_deferred",
        "foreground lock active resumableRecovered=$recovered",
      )
      return Result.retry()
    }

    preferences.recordEvent("network_recovery_triggered", "resumableRecovered=$recovered")
    BackgroundWorkerApiImpl.enqueueBackgroundWorker(ctx)
    return Result.success()
  }
}
