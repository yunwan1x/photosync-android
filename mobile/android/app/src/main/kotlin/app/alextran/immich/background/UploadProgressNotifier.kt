package app.alextran.immich.background

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import app.alextran.immich.MainActivity
import app.alextran.immich.R
import java.util.Locale

internal class UploadProgressNotifier(context: Context) {
  private val ctx = context.applicationContext
  private val notificationManager =
    ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  fun update(
    state: BackupProgressState,
    filename: String? = null,
    uploadedBytes: Long? = null,
    totalBytes: Long? = null,
  ) {
    val overall = state.overall
    val queue = state.queue
    val displayTotal = if (overall.total > 0) overall.total else queue.total
    val displayBackedUp = if (overall.total > 0) overall.backedUp else queue.completed
    val displayRemaining = if (overall.total > 0) overall.remaining else queue.remaining
    if (displayTotal <= 0) {
      cancel()
      return
    }
    ensureChannel()

    val finished = state.isFinished
    val queueFinished = queue.isFinished
    val active = queue.remaining > 0
    val title = when {
      queueFinished && queue.failed > 0 -> ctx.getString(R.string.upload_progress_finished_with_failures, queue.failed)
      finished -> ctx.getString(R.string.upload_progress_finished)
      queueFinished -> ctx.getString(R.string.upload_progress_batch_finished)
      else -> ctx.getString(R.string.upload_progress_title)
    }
    val summary = ctx.getString(
      R.string.upload_progress_summary,
      displayBackedUp,
      displayTotal,
      displayRemaining,
    )
    val queueSummary = ctx.getString(
      R.string.upload_progress_queue,
      queue.processed,
      queue.total,
      queue.remaining,
      queue.retrying,
      queue.failed,
    )
    val fileProgress = if (filename != null && uploadedBytes != null && totalBytes != null) {
      ctx.getString(
        R.string.upload_progress_file,
        filename,
        formatBytes(uploadedBytes),
        formatBytes(totalBytes),
      )
    } else {
      null
    }

    val notification = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setContentTitle(title)
      .setContentText(summary)
      .setSubText(fileProgress)
      .setStyle(
        NotificationCompat.BigTextStyle().bigText(
          listOfNotNull(summary, queueSummary, fileProgress).joinToString("\n"),
        ),
      )
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setOngoing(active)
      .setAutoCancel(!active)
      .setContentIntent(contentIntent())
      .setProgress(displayTotal, displayBackedUp.coerceAtMost(displayTotal), false)
      .apply {
        if (state.shouldAutoDismissNotification) {
          setTimeoutAfter(COMPLETE_NOTIFICATION_TIMEOUT_MS)
        }
      }
      .build()

    notificationManager.notify(NOTIFICATION_ID, notification)
  }

  fun cancel() {
    notificationManager.cancel(NOTIFICATION_ID)
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    notificationManager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        ctx.getString(R.string.upload_progress_channel_name),
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = ctx.getString(R.string.upload_progress_channel_description)
      },
    )
  }

  private fun contentIntent(): PendingIntent {
    val intent = Intent(ctx, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
    return PendingIntent.getActivity(ctx, 0, intent, flags)
  }

  companion object {
    private const val CHANNEL_ID = "immich::resumable_upload::progress"
    private const val NOTIFICATION_ID = 101
    private const val COMPLETE_NOTIFICATION_TIMEOUT_MS = 5000L

    internal fun formatBytes(bytes: Long): String {
      if (bytes < 1024) return "$bytes B"
      val units = arrayOf("KB", "MB", "GB", "TB")
      var value = bytes.toDouble()
      var unitIndex = -1
      do {
        value /= 1024.0
        unitIndex++
      } while (value >= 1024 && unitIndex < units.lastIndex)
      return String.format(Locale.US, if (value >= 10) "%.0f %s" else "%.1f %s", value, units[unitIndex])
    }
  }
}
