package app.alextran.immich.background

import android.net.DnsResolver
import android.os.Build
import android.os.CancellationSignal
import androidx.annotation.RequiresApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal object TxtEndpointResolver {
  private const val DNS_TYPE_TXT = 16
  private const val TIMEOUT_MILLIS = 5_000L
  private val assignment = Regex("^(?:url|server|immich)\\s*=\\s*(.+)$", RegexOption.IGNORE_CASE)

  suspend fun resolve(
    source: String,
    failedEndpoint: String,
    client: OkHttpClient,
    headers: Map<String, String>,
  ): String? {
    val sourceUri = runCatching { URI(source.trim()) }.getOrNull() ?: return null
    if (!sourceUri.scheme.equals("txt", ignoreCase = true) || sourceUri.host.isNullOrBlank()) return null

    val records = withTimeout(TIMEOUT_MILLIS) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        querySystemDns(sourceUri.host)
      } else {
        queryDnsOverHttps(sourceUri.host, client)
      }
    }
    val candidates = records.mapNotNull(::extractHttpUrl).distinct().sortedBy { likelyApiEndpoint(it) == failedEndpoint }
    for (candidate in candidates) {
      val endpoint = resolveAndPing(candidate, client, headers)
      if (endpoint != null) return endpoint
    }
    return null
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private suspend fun querySystemDns(domain: String): List<String> = suspendCancellableCoroutine { continuation ->
    val cancellation = CancellationSignal()
    continuation.invokeOnCancellation { cancellation.cancel() }
    DnsResolver.getInstance().rawQuery(
      null,
      domain,
      DnsResolver.CLASS_IN,
      DNS_TYPE_TXT,
      DnsResolver.FLAG_EMPTY,
      Executor { command -> command.run() },
      cancellation,
      object : DnsResolver.Callback<ByteArray> {
        override fun onAnswer(answer: ByteArray, rcode: Int) {
          if (!continuation.isActive) return
          if (rcode == 0) {
            runCatching { parseTxtResponse(answer) }
              .onSuccess(continuation::resume)
              .onFailure(continuation::resumeWithException)
          } else {
            continuation.resumeWithException(IllegalStateException("DNS response code $rcode"))
          }
        }

        override fun onError(error: DnsResolver.DnsException) {
          if (continuation.isActive) continuation.resumeWithException(error)
        }
      },
    )
  }

  private fun queryDnsOverHttps(domain: String, client: OkHttpClient): List<String> {
    val url = "https://dns.google/resolve?name=${java.net.URLEncoder.encode(domain, "UTF-8")}&type=TXT"
    client.newCall(Request.Builder().url(url).header("Accept", "application/dns-json").get().build()).execute().use {
      if (!it.isSuccessful) return emptyList()
      val json = JSONObject(it.body?.string().orEmpty())
      if (json.optInt("Status", -1) != 0) return emptyList()
      val answers = json.optJSONArray("Answer") ?: return emptyList()
      return buildList {
        for (index in 0 until answers.length()) {
          val answer = answers.optJSONObject(index) ?: continue
          if (answer.optInt("type") == DNS_TYPE_TXT) add(decodePresentation(answer.optString("data")))
        }
      }
    }
  }

  private fun resolveAndPing(candidate: String, client: OkHttpClient, headers: Map<String, String>): String? {
    var endpoint = candidate.trimEnd('/')
    runCatching {
      val request = Request.Builder().url("$endpoint/.well-known/immich").headers(headers).get().build()
      client.newCall(request).execute().use { response ->
        if (response.isSuccessful) {
          val configured = JSONObject(response.body?.string().orEmpty()).optJSONObject("api")?.optString("endpoint")
          if (!configured.isNullOrBlank()) endpoint = if (configured.startsWith('/')) "$endpoint$configured" else configured
        }
      }
    }

    endpoint = endpoint.trimEnd('/').let { if (it.endsWith("/api")) it else "$it/api" }
    return runCatching {
      val request = Request.Builder().url("$endpoint/server/ping").headers(headers).get().build()
      client.newCall(request).execute().use { if (it.isSuccessful) endpoint else null }
    }.getOrNull()
  }

  private fun Request.Builder.headers(values: Map<String, String>): Request.Builder = apply {
    values.forEach { (name, value) -> header(name, value) }
  }

  private fun extractHttpUrl(record: String): String? {
    val value = assignment.matchEntire(record.trim())?.groupValues?.get(1)?.trim() ?: record.trim()
    val uri = runCatching { URI(value) }.getOrNull() ?: return null
    return value.takeIf { uri.host?.isNotEmpty() == true && (uri.scheme == "http" || uri.scheme == "https") }
  }

  private fun likelyApiEndpoint(value: String) = value.trimEnd('/').let { if (it.endsWith("/api")) it else "$it/api" }

  private fun parseTxtResponse(message: ByteArray): List<String> {
    require(message.size >= 12) { "Incomplete DNS response" }
    val questionCount = uint16(message, 4)
    val answerCount = uint16(message, 6)
    var offset = 12
    repeat(questionCount) {
      offset = skipName(message, offset)
      requireAvailable(message, offset, 4)
      offset += 4
    }

    return buildList {
      repeat(answerCount) {
        offset = skipName(message, offset)
        requireAvailable(message, offset, 10)
        val type = uint16(message, offset)
        val recordClass = uint16(message, offset + 2)
        val length = uint16(message, offset + 8)
        offset += 10
        requireAvailable(message, offset, length)
        if (type == DNS_TYPE_TXT && recordClass == 1) {
          val end = offset + length
          val bytes = mutableListOf<Byte>()
          while (offset < end) {
            val chunkLength = message[offset++].toInt() and 0xff
            require(offset + chunkLength <= end) { "Malformed DNS TXT response" }
            repeat(chunkLength) { bytes.add(message[offset++]) }
          }
          add(String(bytes.toByteArray(), StandardCharsets.UTF_8))
        } else {
          offset += length
        }
      }
    }
  }

  private fun skipName(message: ByteArray, start: Int): Int {
    var offset = start
    while (true) {
      requireAvailable(message, offset, 1)
      val length = message[offset++].toInt() and 0xff
      if (length == 0) return offset
      if (length and 0xc0 == 0xc0) {
        requireAvailable(message, offset, 1)
        return offset + 1
      }
      require(length and 0xc0 == 0) { "Malformed DNS name" }
      requireAvailable(message, offset, length)
      offset += length
    }
  }

  private fun uint16(message: ByteArray, offset: Int): Int {
    requireAvailable(message, offset, 2)
    return ((message[offset].toInt() and 0xff) shl 8) or (message[offset + 1].toInt() and 0xff)
  }

  private fun requireAvailable(message: ByteArray, offset: Int, length: Int) {
    require(offset >= 0 && length >= 0 && offset + length <= message.size) { "Incomplete DNS response" }
  }

  private fun decodePresentation(value: String): String {
    val trimmed = value.trim()
    if (!trimmed.startsWith('"')) return trimmed
    val output = StringBuilder()
    var index = 0
    while (index < trimmed.length) {
      while (index < trimmed.length && trimmed[index].isWhitespace()) index++
      if (index >= trimmed.length || trimmed[index++] != '"') return trimmed
      while (index < trimmed.length && trimmed[index] != '"') {
        if (trimmed[index] == '\\' && index + 1 < trimmed.length) index++
        output.append(trimmed[index++])
      }
      if (index >= trimmed.length) return trimmed
      index++
    }
    return output.toString()
  }
}
