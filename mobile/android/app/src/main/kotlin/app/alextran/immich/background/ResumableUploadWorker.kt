package app.alextran.immich.background

import android.content.Context
import android.util.Log
import app.alextran.immich.core.HttpClientManager
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import okhttp3.RequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit

class ResumableUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  private val store = ResumableUploadStore(context)
  private val diagnostics = BackgroundWorkerPreferences(context)
  private val notifier = UploadProgressNotifier(context)
  private val client by lazy {
    // WorkManager can start this process without ever creating MainActivity.
    HttpClientManager.initialize(applicationContext)
    HttpClientManager.getClient().newBuilder()
      .connectTimeout(30, TimeUnit.SECONDS)
      .readTimeout(90, TimeUnit.SECONDS)
      .writeTimeout(90, TimeUnit.SECONDS)
      .build()
  }

  override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
    if (!diagnostics.isBackupEnabled()) return@withContext Result.success()
    val taskId = inputData.getString(ResumableUploadScheduler.TASK_ID) ?: return@withContext Result.failure()
    val upload = store.get(taskId) ?: return@withContext Result.failure()
    try {
      val file = File(upload.filePath)
      if (!file.isFile || file.length() != upload.fileSize) {
        return@withContext fail(taskId, "Local file is missing or changed")
      }

      val baseUrl = upload.serverUrl.trimEnd('/') + "/assets/resumable"
      var uploadId = store.getUploadId(taskId)
      var offset = 0L

      if (uploadId == null) {
        val create = JSONObject().apply {
          put("filename", upload.filename)
          put("fileSize", upload.fileSize)
          put("checksum", upload.checksum)
          put("metadata", JSONObject(upload.fields))
        }
        val response = execute(
          Request.Builder()
            .url(baseUrl)
            .headers(upload.headers)
            .post(create.toString().toRequestBody(JSON))
            .build(),
        )
        response.use {
          val body = JSONObject(it.body?.string().orEmpty().ifEmpty { "{}" })
          if (it.code in 200..299 && body.optString("assetId").isNotEmpty()) {
            store.markCompleted(taskId, upload.checksum, body.optString("assetId"))
            markSucceeded()
            return@withContext Result.success()
          }
          ensureSuccessful(it.code, body.optString("message"))
          uploadId = body.getString("id")
          offset = body.optLong("offset", 0)
          store.setUploadId(taskId, uploadId!!)
        }
      } else {
        val response = execute(Request.Builder().url("$baseUrl/$uploadId").headers(upload.headers).get().build())
        response.use {
          if (it.code == 404) {
            store.setUploadId(taskId, "")
            store.remove(taskId)
            store.save(upload)
            return@withContext retry("Server upload session expired")
          }
          val body = JSONObject(it.body?.string().orEmpty().ifEmpty { "{}" })
          ensureSuccessful(it.code, body.optString("message"))
          offset = body.getLong("offset")
        }
      }
      diagnostics.markUploadStarted(taskId, runAttemptCount > 0)?.let {
        notifier.update(it, upload.filename, offset, upload.fileSize)
      }

      val startedAt = System.nanoTime()
      var bytesThisRun = 0L
      while (offset < upload.fileSize && bytesThisRun < MAX_BYTES_PER_RUN && elapsedMinutes(startedAt) < MAX_MINUTES_PER_RUN) {
        val length = minOf(CHUNK_SIZE, upload.fileSize - offset)
        val request = Request.Builder()
          .url("$baseUrl/$uploadId")
          .headers(upload.headers)
          .header("Upload-Offset", offset.toString())
          .patch(FileSliceRequestBody(file, offset, length))
          .build()
        val response = execute(request)
        response.use {
          val responseBody = JSONObject(it.body?.string().orEmpty().ifEmpty { "{}" })
          ensureSuccessful(it.code, responseBody.optString("message"))
          val nextOffset = responseBody.getLong("offset")
          if (nextOffset <= offset) throw IllegalStateException("Server did not advance upload offset")
          bytesThisRun += nextOffset - offset
          offset = nextOffset
          notifier.update(diagnostics.getProgressState(), upload.filename, offset, upload.fileSize)
        }
      }

      if (offset < upload.fileSize) {
        ResumableUploadScheduler.enqueueContinuation(applicationContext, store.get(taskId) ?: upload)
        diagnostics.recordDiagnosticEvent("upload_checkpoint", "offset=$offset total=${upload.fileSize}")
        return@withContext Result.success()
      }

      val completeResponse = execute(
        Request.Builder()
          .url("$baseUrl/$uploadId/complete")
          .headers(upload.headers)
          .post(ByteArray(0).toRequestBody(null))
          .build(),
      )
      val assetId = completeResponse.use {
        val body = JSONObject(it.body?.string().orEmpty().ifEmpty { "{}" })
        ensureSuccessful(it.code, body.optString("message"))
        body.optString("id").takeIf(String::isNotEmpty)
      }

      store.markCompleted(taskId, upload.checksum, assetId)
      markSucceeded()
      Result.success()
    } catch (error: UploadInterruptedException) {
      if (!diagnostics.isBackupEnabled()) {
        store.remove(taskId)
        Result.success()
      } else {
        Result.retry()
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: PermanentUploadException) {
      fail(taskId, error.message ?: "Permanent upload failure")
    } catch (error: EndpointUnavailableException) {
      val refreshed = runCatching {
        TxtEndpointResolver.resolve(
          source = upload.serverUrlSource,
          failedEndpoint = upload.serverUrl,
          client = client,
          headers = upload.headers,
        )
      }.getOrNull()
      if (refreshed != null) {
        if (refreshed != upload.serverUrl) {
          val updated = upload.copy(serverUrl = refreshed)
          store.save(updated)
          // Continue the existing session when a reachable replacement is known.
          // Keep retry backoff for outages without a working replacement.
          val scheduled = runCatching {
            ResumableUploadScheduler.enqueueContinuation(applicationContext, updated)
          }
          if (scheduled.isSuccess) {
            diagnostics.recordDiagnosticEvent("upload_endpoint_changed", "continuation=true sessionPreserved=true")
            return@withContext Result.success()
          }
          diagnostics.recordDiagnosticEvent(
            "upload_endpoint_continuation_failed",
            scheduled.exceptionOrNull()?.javaClass?.simpleName,
          )
        }
        return@withContext retry("TXT endpoint refreshed after upload failure: ${error.message}")
      }
      if (runAttemptCount >= MAX_RETRIES) {
        fail(taskId, error.message ?: error.javaClass.simpleName)
      } else {
        retry(error.message ?: error.javaClass.simpleName)
      }
    } catch (error: Exception) {
      if (runAttemptCount >= MAX_RETRIES) {
        fail(taskId, error.message ?: error.javaClass.simpleName)
      } else {
        retry(error.message ?: error.javaClass.simpleName)
      }
    }
  }

  private suspend fun execute(request: Request): Response {
    if (!diagnostics.isBackupEnabled() || isStopped) throw UploadInterruptedException()
    val call = client.newCall(request)
    return suspendCancellableCoroutine { continuation ->
      continuation.invokeOnCancellation { call.cancel() }
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          if (!continuation.isActive) return
          val failure = if (!diagnostics.isBackupEnabled() || isStopped || call.isCanceled()) {
            UploadInterruptedException()
          } else {
            EndpointUnavailableException(e.message ?: "Connection failed", e)
          }
          continuation.resumeWith(kotlin.Result.failure(failure))
        }

        override fun onResponse(call: Call, response: Response) {
          if (!diagnostics.isBackupEnabled() || isStopped || call.isCanceled()) {
            response.close()
            continuation.resumeWith(kotlin.Result.failure(UploadInterruptedException()))
            return
          }
          if (!continuation.isActive) {
            response.close()
          } else {
            continuation.resumeWith(kotlin.Result.success(response))
          }
        }
      })
    }
  }

  private fun ensureSuccessful(status: Int, message: String) {
    if (status in 200..299) return
    if (status == 401 || status == 403 || status == 413 || status == 422) {
      throw PermanentUploadException("HTTP $status: $message")
    }
    if (status == 502 || status == 503 || status == 504) {
      throw EndpointUnavailableException("HTTP $status: $message")
    }
    throw IOException("HTTP $status: $message")
  }

  private fun retry(message: String, recordError: Boolean = true): Result {
    if (!diagnostics.isBackupEnabled()) return Result.success()
    Log.w(TAG, message)
    if (recordError) diagnostics.recordUploadError(message)
    val taskId = inputData.getString(ResumableUploadScheduler.TASK_ID)
    if (taskId != null) diagnostics.markUploadRetrying(taskId)?.let(notifier::update)
    return Result.retry()
  }

  private fun fail(taskId: String, message: String): Result {
    if (!diagnostics.isBackupEnabled()) {
      store.remove(taskId)
      return Result.success()
    }
    Log.e(TAG, message)
    diagnostics.recordUploadError(message)
    diagnostics.markUploadFailed(taskId)?.let(notifier::update)
    return Result.failure()
  }

  private fun markSucceeded() {
    val taskId = inputData.getString(ResumableUploadScheduler.TASK_ID) ?: return
    diagnostics.markUploadSucceeded(taskId)?.let {
      diagnostics.recordUploadSucceeded()
      if (it.queue.isFinished && it.queue.failed == 0) {
        diagnostics.clearUploadError()
      }
      notifier.update(it)
    }
  }

  private fun elapsedMinutes(startedAt: Long) = TimeUnit.NANOSECONDS.toMinutes(System.nanoTime() - startedAt)

  private class FileSliceRequestBody(
    private val file: File,
    private val offset: Long,
    private val length: Long,
  ) : RequestBody() {
    override fun contentType() = OCTET_STREAM
    override fun contentLength() = length

    override fun writeTo(sink: BufferedSink) {
      RandomAccessFile(file, "r").use { input ->
        input.seek(offset)
        val buffer = ByteArray(256 * 1024)
        var remaining = length
        while (remaining > 0) {
          val read = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
          if (read < 0) throw IOException("Unexpected end of file")
          sink.write(buffer, 0, read)
          remaining -= read
        }
      }
    }
  }

  private fun Request.Builder.headers(values: Map<String, String>): Request.Builder = apply {
    values.forEach { (name, value) -> header(name, value) }
  }

  private class PermanentUploadException(message: String) : Exception(message)

  private class EndpointUnavailableException(message: String, cause: Throwable? = null) : Exception(message, cause)

  private class UploadInterruptedException : Exception()

  companion object {
    private const val TAG = "ResumableUploadWorker"
    private const val CHUNK_SIZE = 8L * 1024 * 1024
    private const val MAX_BYTES_PER_RUN = 64L * 1024 * 1024
    private const val MAX_MINUTES_PER_RUN = 7L
    private const val MAX_RETRIES = 8
    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val OCTET_STREAM = "application/offset+octet-stream".toMediaType()
  }
}
