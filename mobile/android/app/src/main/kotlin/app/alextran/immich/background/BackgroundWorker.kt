package app.alextran.immich.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.ListenableWorker
import androidx.work.WorkerParameters
import app.alextran.immich.backupprogress.BackupProgressHostApi
import app.alextran.immich.MainActivity
import app.alextran.immich.R
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.FutureCallback
import com.google.common.util.concurrent.MoreExecutors
import com.google.common.util.concurrent.SettableFuture
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.embedding.engine.loader.FlutterLoader
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.TimeUnit

private const val TAG = "BackgroundWorker"

internal class WorkerCompletionGuard {
  private val completed = AtomicBoolean(false)

  val isComplete: Boolean
    get() = completed.get()

  fun tryComplete(): Boolean = completed.compareAndSet(false, true)
}

class BackgroundWorker(context: Context, params: WorkerParameters) :
  ListenableWorker(context, params), BackgroundWorkerBgHostApi {
  private val ctx: Context = context.applicationContext

  /// The Flutter loader that loads the native Flutter library and resources.
  /// This must be initialized before starting the Flutter engine.
  private var loader: FlutterLoader = FlutterInjector.instance().flutterLoader()

  /// The Flutter engine created specifically for background execution.
  /// This is a separate instance from the main Flutter engine that handles the UI.
  /// It operates in its own isolate and doesn't share memory with the main engine.
  /// Must be properly started, registered, and torn down during background execution.
  private var engine: FlutterEngine? = null

  // Used to call methods on the flutter side
  private var flutterApi: BackgroundWorkerFlutterApi? = null

  /// Result returned when the background task completes. This is used to signal
  /// to the WorkManager that the task has finished, either successfully or with failure.
  private val completionHandler: SettableFuture<Result> = SettableFuture.create()

  /// Guards every completion path, including the delayed cancellation fallback.
  private val completionGuard = WorkerCompletionGuard()

  private val notificationManager =
    ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private var foregroundFuture: ListenableFuture<Void>? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var deadlineRunnable: Runnable? = null

  companion object {
    private const val NOTIFICATION_CHANNEL_ID = "immich::background_worker::notif"
    private const val NOTIFICATION_ID = 100
    private const val ANDROID_WORKER_MAX_MINUTES = 8L
    private const val DEADLINE_GRACE_MILLIS = 5_000L
  }

  override fun startWork(): ListenableFuture<Result> {
    Log.i(TAG, "Starting background upload worker")
    BackgroundWorkerPreferences(ctx).apply {
      recordStarted()
      beginRun(id.toString(), runAttemptCount)
    }

    if (!loader.initialized()) {
      loader.startInitialization(ctx)
    }

    ensureNotificationChannel()
    val notificationConfig = BackgroundWorkerPreferences(ctx).getNotificationConfig()
    showNotification(notificationConfig.first, notificationConfig.second)

    loader.ensureInitializationCompleteAsync(ctx, null, Handler(Looper.getMainLooper())) {
      BackgroundWorkerPreferences(ctx).recordEvent("flutter_loader_ready")
      engine = FlutterEngine(ctx)
      FlutterEngineCache.getInstance().put(BackgroundWorkerApiImpl.ENGINE_CACHE_KEY, engine!!)

      // Register custom plugins
      MainActivity.registerPlugins(ctx, engine!!)
      flutterApi =
        BackgroundWorkerFlutterApi(binaryMessenger = engine!!.dartExecutor.binaryMessenger)
      BackgroundWorkerBgHostApi.setUp(
        binaryMessenger = engine!!.dartExecutor.binaryMessenger,
        api = this
      )
      BackupProgressHostApi.setUp(
        binaryMessenger = engine!!.dartExecutor.binaryMessenger,
        api = BackupProgressApiImpl(ctx),
      )

      engine!!.dartExecutor.executeDartEntrypoint(
        DartExecutor.DartEntrypoint(
          loader.findAppBundlePath(),
          "package:immich_mobile/domain/services/background_worker.service.dart",
          "backgroundSyncNativeEntrypoint"
        )
      )
      BackgroundWorkerPreferences(ctx).recordEvent("flutter_entrypoint_started")
    }

    return completionHandler
  }

  /**
   * Called by the Flutter side when it has finished initialization and is ready to receive commands.
   * Routes the appropriate task type (refresh or processing) to the corresponding Flutter method.
   * This method acts as a bridge between the native Android background task system and Flutter.
   */
  override fun onInitialized() {
    BackgroundWorkerPreferences(ctx).recordEvent("flutter_background_initialized")
    scheduleWorkerDeadline(ANDROID_WORKER_MAX_MINUTES)
    flutterApi?.onAndroidUpload(maxMinutesArg = ANDROID_WORKER_MAX_MINUTES) { handleHostResult(it) }
  }

  override fun enqueueResumableUploads(requests: List<ResumableUploadRequest>) {
    val preferences = BackgroundWorkerPreferences(ctx)
    preferences.recordDiagnosticEvent(
      "native_call_start",
      "call=enqueue_resumable count=${requests.size}",
    )
    try {
      ResumableUploadScheduler.enqueue(ctx, requests)
      preferences.recordDiagnosticEvent(
        "native_call_complete",
        "call=enqueue_resumable count=${requests.size}",
      )
    } catch (error: Exception) {
      preferences.recordDiagnosticEvent(
        "native_call_failed",
        "call=enqueue_resumable error=${error.javaClass.simpleName}",
      )
      throw error
    }
  }

  override fun refreshResumableUploadNetworkPolicy(requiresWifi: Boolean): Long {
    val preferences = BackgroundWorkerPreferences(ctx)
    preferences.recordDiagnosticEvent(
      "native_call_start",
      "call=refresh_resumable_policy requiresWifi=$requiresWifi",
    )
    return try {
      ResumableUploadScheduler.refreshNetworkPolicy(ctx, requiresWifi).toLong().also { count ->
        preferences.recordDiagnosticEvent(
          "native_call_complete",
          "call=refresh_resumable_policy requiresWifi=$requiresWifi count=$count",
        )
      }
    } catch (error: Exception) {
      preferences.recordDiagnosticEvent(
        "native_call_failed",
        "call=refresh_resumable_policy error=${error.javaClass.simpleName}",
      )
      throw error
    }
  }

  override fun getPendingResumableUploadIds(): List<String> {
    val preferences = BackgroundWorkerPreferences(ctx)
    preferences.recordDiagnosticEvent("native_call_start", "call=get_pending_resumable")
    return try {
      ResumableUploadScheduler.claimedTaskIds(ctx).also { ids ->
        preferences.recordDiagnosticEvent(
          "native_call_complete",
          "call=get_pending_resumable count=${ids.size}",
        )
      }
    } catch (error: Exception) {
      preferences.recordDiagnosticEvent(
        "native_call_failed",
        "call=get_pending_resumable error=${error.javaClass.simpleName}",
      )
      throw error
    }
  }

  override fun getCompletedResumableUploads(): Map<String, String> {
    return ResumableUploadStore(ctx).completedChecksums()
  }

  override fun clearCompletedResumableUploads(taskIds: List<String>) {
    val preferences = BackgroundWorkerPreferences(ctx)
    preferences.recordDiagnosticEvent(
      "native_call_start",
      "call=clear_completed_resumable count=${taskIds.size}",
    )
    ResumableUploadStore(ctx).clearCompleted(taskIds)
    preferences.recordDiagnosticEvent(
      "native_call_complete",
      "call=clear_completed_resumable count=${taskIds.size}",
    )
  }

  override fun setBackupPendingState(hasPending: Boolean) {
    val preferences = BackgroundWorkerPreferences(ctx).apply {
      recordDiagnosticEvent("native_call_start", "call=set_pending value=$hasPending")
      setHasPendingBackup(hasPending)
      recordDiagnosticEvent("native_call_complete", "call=set_pending value=$hasPending")
      recordEvent("backup_pending_state", hasPending.toString())
    }
    BackgroundWorkerApiImpl.updateNetworkRecoveryWork(ctx, preferences)
  }

  override fun recordWorkerEvent(event: String, detail: String?) {
    BackgroundWorkerPreferences(ctx).recordDiagnosticEvent(event, detail)
  }

  private fun scheduleWorkerDeadline(maxMinutes: Long) {
    val runnable = Runnable {
      if (completionGuard.isComplete) {
        return@Runnable
      }
      BackgroundWorkerPreferences(ctx).recordEvent(
        "native_worker_deadline",
        "maxMinutes=$maxMinutes",
      )
      flutterApi?.cancel {
        complete(Result.retry())
      }
      mainHandler.postDelayed({ complete(Result.retry()) }, DEADLINE_GRACE_MILLIS)
    }
    deadlineRunnable = runnable
    mainHandler.postDelayed(runnable, TimeUnit.MINUTES.toMillis(maxMinutes))
  }

  // TODO: Move this to a separate NotificationManager class
  private fun showNotification(title: String, content: String) {
    val notification = buildNotification(title, content)
    BackgroundWorkerPreferences(ctx).recordEvent("foreground_promotion_requested")
    foregroundFuture = setForegroundAsync(buildForegroundInfo(notification))
    Futures.addCallback(
      foregroundFuture!!,
      object : FutureCallback<Void> {
        override fun onSuccess(result: Void?) {
          BackgroundWorkerPreferences(ctx).recordEvent("foreground_promotion_succeeded")
        }

        override fun onFailure(error: Throwable) {
          BackgroundWorkerPreferences(ctx).recordEvent(
            "foreground_promotion_failed",
            "${error.javaClass.simpleName}: ${error.message}",
          )
        }
      },
      MoreExecutors.directExecutor(),
    )
  }

  override fun getForegroundInfoAsync(): ListenableFuture<ForegroundInfo> {
    ensureNotificationChannel()
    val notificationConfig = BackgroundWorkerPreferences(ctx).getNotificationConfig()
    return Futures.immediateFuture(
      buildForegroundInfo(buildNotification(notificationConfig.first, notificationConfig.second))
    )
  }

  private fun ensureNotificationChannel() {
    notificationManager.createNotificationChannel(
      NotificationChannel(
        NOTIFICATION_CHANNEL_ID,
        ctx.getString(R.string.background_worker_notification_channel_name),
        NotificationManager.IMPORTANCE_LOW
      )
    )
  }

  private fun buildNotification(title: String, content: String): Notification =
    NotificationCompat.Builder(applicationContext, NOTIFICATION_CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setTicker(title)
      .setContentTitle(title)
      .setContentText(content)
      .build()

  private fun buildForegroundInfo(notification: Notification): ForegroundInfo =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ForegroundInfo(
        NOTIFICATION_ID,
        notification,
        FOREGROUND_SERVICE_TYPE_DATA_SYNC
      )
    } else {
      ForegroundInfo(NOTIFICATION_ID, notification)
    }

  override fun close() {
    if (completionGuard.isComplete) {
      return
    }

    Handler(Looper.getMainLooper()).postAtFrontOfQueue {
      if (flutterApi != null) {
        flutterApi?.cancel {
          complete(Result.failure())
        }
      }
    }

    waitForForegroundPromotion()

    Handler(Looper.getMainLooper()).postDelayed({
      complete(Result.failure())
    }, 5000)
  }

  /**
   * Called when the system has to stop this worker because constraints are
   * no longer met or the system needs resources for more important tasks
   * This is also called when the worker has been explicitly cancelled or replaced
   */
  override fun onStopped() {
    Log.d(TAG, "About to stop BackupWorker")
    BackgroundWorkerPreferences(ctx).recordEvent("worker_stopped", "id=$id attempt=$runAttemptCount")
    close()
  }

  private fun handleHostResult(result: kotlin.Result<Unit>) {
    if (completionGuard.isComplete) {
      return
    }

    result.fold(
      onSuccess = { _ ->
        BackgroundWorkerPreferences(ctx).recordEvent("worker_flutter_result", "success")
        BackgroundWorkerPreferences(ctx).recordSucceeded()
        complete(Result.success())
      },
      onFailure = { error ->
        BackgroundWorkerPreferences(ctx).recordEvent(
          "worker_flutter_result",
          "failure ${error.javaClass.simpleName}: ${error.message}",
        )
        BackgroundWorkerPreferences(ctx).recordError(error.message ?: error.javaClass.simpleName)
        complete(Result.retry())
      }
    )
  }

  /**
   * Cleans up resources by destroying the Flutter engine context and invokes the completion handler.
   * This method ensures that the background task is marked as complete, releases the Flutter engine,
   * and notifies the caller of the task's success or failure. This is the final step in the
   * background task lifecycle and should only be called once per task instance.
   *
   * - Parameter success: Indicates whether the background task completed successfully
   */
  private fun complete(success: Result) {
    if (!completionGuard.tryComplete()) {
      BackgroundWorkerPreferences(ctx).recordEvent("worker_complete_ignored", success.toString())
      return
    }

    Log.d(TAG, "About to complete BackupWorker with result: $success")
    deadlineRunnable?.let(mainHandler::removeCallbacks)
    deadlineRunnable = null
    BackgroundWorkerPreferences(ctx).endRun(success.toString())
    if (engine != null) {
      MainActivity.cancelPlugins(engine!!)
    }
    engine?.destroy()
    engine = null
    flutterApi = null
    notificationManager.cancel(NOTIFICATION_ID)
    FlutterEngineCache.getInstance().remove(BackgroundWorkerApiImpl.ENGINE_CACHE_KEY)
    waitForForegroundPromotion()
    completionHandler.set(success)
  }

  /**
   *  Calls to setForegroundAsync() that do not complete before completion of a ListenableWorker will signal an IllegalStateException
   * https://android-review.googlesource.com/c/platform/frameworks/support/+/1262743
   * Wait for a short period of time for the foreground promotion to complete before completing the worker
   */
  private fun waitForForegroundPromotion() {
    val foregroundFuture = this.foregroundFuture
    if (foregroundFuture != null && !foregroundFuture.isCancelled && !foregroundFuture.isDone) {
      try {
        foregroundFuture.get(500, TimeUnit.MILLISECONDS)
      } catch (e: Exception) {
        // ignored, there is nothing to be done
      }
    }
  }
}
