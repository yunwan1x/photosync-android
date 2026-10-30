package app.alextran.immich.dns

import android.net.DnsResolver
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresApi
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class DnsTxtResolverPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
  private var channel: MethodChannel? = null
  private val mainExecutor = java.util.concurrent.Executor { command ->
    Handler(Looper.getMainLooper()).post(command)
  }

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel = MethodChannel(binding.binaryMessenger, "app.alextran.immich/dns_txt").also {
      it.setMethodCallHandler(this)
    }
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel?.setMethodCallHandler(null)
    channel = null
  }

  override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
    if (call.method != "queryTxt") {
      result.notImplemented()
      return
    }

    val domain = call.argument<String>("domain")
    if (domain.isNullOrBlank()) {
      result.error("INVALID_DOMAIN", "DNS domain is empty", null)
      return
    }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      result.error("UNSUPPORTED", "System DNS TXT lookup requires Android 10 or newer", null)
      return
    }

    queryTxt(domain, result)
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun queryTxt(domain: String, result: MethodChannel.Result) {
    DnsResolver.getInstance().rawQuery(
      null,
      domain,
      DnsResolver.CLASS_IN,
      DNS_TYPE_TXT,
      DnsResolver.FLAG_EMPTY,
      mainExecutor,
      CancellationSignal(),
      object : DnsResolver.Callback<ByteArray> {
        override fun onAnswer(answer: ByteArray, rcode: Int) {
          if (rcode == 0) {
            result.success(answer)
          } else {
            result.error("DNS_ERROR", "DNS TXT lookup failed with response code $rcode", null)
          }
        }

        override fun onError(error: DnsResolver.DnsException) {
          result.error("DNS_ERROR", error.message ?: "DNS TXT lookup failed", null)
        }
      },
    )
  }

  private companion object {
    const val DNS_TYPE_TXT = 16
  }
}
