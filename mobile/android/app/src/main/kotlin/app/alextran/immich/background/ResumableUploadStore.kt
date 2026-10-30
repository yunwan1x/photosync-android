package app.alextran.immich.background

import android.content.Context
import androidx.core.content.edit
import org.json.JSONObject

internal class ResumableUploadStore(context: Context) {
  private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  fun save(request: ResumableUploadRequest) {
    val json = JSONObject().apply {
      put("taskId", request.taskId)
      put("serverUrl", request.serverUrl)
      put("serverUrlSource", request.serverUrlSource)
      put("filePath", request.filePath)
      put("filename", request.filename)
      put("fileSize", request.fileSize)
      put("checksum", request.checksum)
      put("headers", JSONObject(request.headers))
      put("fields", JSONObject(request.fields))
      put("requiresWifi", request.requiresWifi)
    }
    preferences.edit { putString(requestKey(request.taskId), json.toString()) }
  }

  fun contains(taskId: String) = preferences.contains(requestKey(taskId))

  fun taskIds(): List<String> = preferences.all.keys
    .asSequence()
    .filter { it.startsWith(REQUEST_PREFIX) }
    .map { it.removePrefix(REQUEST_PREFIX) }
    .toList()

  fun claimedTaskIds(): List<String> {
    cleanupExpiredCompleted()
    return (taskIds() + completedTaskIds())
      .distinct()
      .toList()
  }

  fun completedTaskIds(): List<String> {
    cleanupExpiredCompleted()
    return preferences.all.keys.asSequence()
      .filter { it.startsWith(COMPLETED_PREFIX) }
      .map { it.removePrefix(COMPLETED_PREFIX) }
      .toList()
  }

  fun get(taskId: String): ResumableUploadRequest? {
    val value = preferences.getString(requestKey(taskId), null) ?: return null
    return runCatching {
      val json = JSONObject(value)
      ResumableUploadRequest(
        taskId = json.getString("taskId"),
        serverUrl = json.getString("serverUrl"),
        serverUrlSource = json.optString("serverUrlSource", json.getString("serverUrl")),
        filePath = json.getString("filePath"),
        filename = json.getString("filename"),
        fileSize = json.getLong("fileSize"),
        checksum = json.getString("checksum"),
        headers = json.getJSONObject("headers").toStringMap(),
        fields = json.getJSONObject("fields").toStringMap(),
        requiresWifi = json.getBoolean("requiresWifi"),
      )
    }.getOrNull()
  }

  fun getUploadId(taskId: String): String? = preferences.getString(uploadIdKey(taskId), null)

  fun setUploadId(taskId: String, uploadId: String) {
    preferences.edit { putString(uploadIdKey(taskId), uploadId) }
  }

  fun clearUploadId(taskId: String) {
    preferences.edit { remove(uploadIdKey(taskId)) }
  }

  fun markCompleted(taskId: String, checksum: String, assetId: String?) {
    val value = JSONObject().apply {
      put("checksum", checksum)
      put("assetId", assetId)
      put("completedAt", System.currentTimeMillis())
    }
    preferences.edit(commit = true) {
      remove(requestKey(taskId))
      remove(uploadIdKey(taskId))
      putString(completedKey(taskId), value.toString())
    }
  }

  fun clearCompleted(taskId: String) {
    preferences.edit { remove(completedKey(taskId)) }
  }

  fun completedChecksums(): Map<String, String> {
    cleanupExpiredCompleted()
    return preferences.all.asSequence()
      .filter { (key, value) -> key.startsWith(COMPLETED_PREFIX) && value is String }
      .mapNotNull { (key, value) ->
        runCatching {
          key.removePrefix(COMPLETED_PREFIX) to JSONObject(value as String).getString("checksum")
        }.getOrNull()
      }
      .toMap()
  }

  fun clearCompleted(taskIds: List<String>) {
    if (taskIds.isNotEmpty()) {
      preferences.edit(commit = true) { taskIds.forEach { remove(completedKey(it)) } }
    }
  }

  fun remove(taskId: String) {
    preferences.edit {
      remove(requestKey(taskId))
      remove(uploadIdKey(taskId))
    }
  }

  fun clear() {
    preferences.edit(commit = true) { clear() }
  }

  private fun JSONObject.toStringMap(): Map<String, String> = keys().asSequence().associateWith { getString(it) }

  private fun requestKey(taskId: String) = "$REQUEST_PREFIX$taskId"
  private fun uploadIdKey(taskId: String) = "upload::$taskId"
  private fun completedKey(taskId: String) = "$COMPLETED_PREFIX$taskId"

  private fun cleanupExpiredCompleted() {
    val cutoff = System.currentTimeMillis() - COMPLETED_RETENTION_MILLIS
    val expired = preferences.all.asSequence()
      .filter { (key, value) ->
        if (!key.startsWith(COMPLETED_PREFIX) || value !is String) {
          false
        } else {
          runCatching { JSONObject(value).optLong("completedAt", 0) < cutoff }.getOrDefault(true)
        }
      }
      .map { it.key }
      .toList()
    if (expired.isNotEmpty()) {
      preferences.edit { expired.forEach { key -> remove(key) } }
    }
  }

  companion object {
    private const val PREFERENCES_NAME = "Immich::ResumableUploads"
    private const val REQUEST_PREFIX = "request::"
    private const val COMPLETED_PREFIX = "completed::"
    private const val COMPLETED_RETENTION_MILLIS = 7L * 24 * 60 * 60 * 1000
  }
}
