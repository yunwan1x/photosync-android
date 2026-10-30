package app.alextran.immich.background

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters

class MediaObserver(context: Context, params: WorkerParameters) : Worker(context, params) {
  private val ctx: Context = context.applicationContext

  override fun doWork(): Result {
    Log.i("MediaObserver", "Content change detected, starting background worker")
    // Enqueue backup worker only if there are new media changes
    if (triggeredContentUris.isNotEmpty()) {
      BackgroundWorkerPreferences(ctx).setHasPendingBackup(true)
      BackgroundWorkerApiImpl.enqueueBackgroundWorker(ctx)
    }
    // Re-arm after the current unique work has completed. Enqueuing synchronously
    // with REPLACE from inside this worker can cancel the worker that is doing it.
    BackgroundWorkerApiImpl.enqueueMediaObserver(ctx, rearm = true)
    return Result.success()
  }
}
