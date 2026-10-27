package uz.ijara360.ijara360

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import android.os.Build
import java.io.File

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Self-update (see SelfUpdate.kt); the Dart side is lib/update.dart.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "uz.ijara360/update").setMethodCallHandler { call, result ->
            when (call.method) {
                "updateDir" -> result.success(SelfUpdate.dir(this).absolutePath)
                "canInstall" -> result.success(SelfUpdate.canInstall(this))
                "silentCapable" -> result.success(Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                "pendingConfirm" -> result.success(SelfUpdate.pendingConfirm(this))
                "openInstallSettings" -> { SelfUpdate.openSettings(this); result.success(null) }
                "scheduleInstall" -> { SelfUpdate.schedule(this, call.argument<String>("path")!!); result.success(null) }
                "cancelInstall" -> { SelfUpdate.cancel(this); result.success(null) }
                "installNow" -> try { SelfUpdate.install(this, File(call.argument<String>("path")!!), interactive = true); result.success(null) } catch (e: Exception) { result.error("install", e.message, null) }
                "clear" -> { SelfUpdate.clear(this); result.success(null) }
                else -> result.notImplemented()
            }
        }
    }

    override fun onResume() { super.onResume(); SelfUpdate.foreground = true }
    override fun onStop() { super.onStop(); SelfUpdate.foreground = false }
}
