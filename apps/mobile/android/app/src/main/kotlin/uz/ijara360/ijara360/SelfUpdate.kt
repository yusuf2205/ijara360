package uz.ijara360.ijara360

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.work.BackoffPolicy
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The app updates itself. The Dart side downloads the new APK while the person uses the app; once the app
 * leaves the screen, a short-delayed job installs it through PackageInstaller. On Android 12+ an app that
 * updates itself, holds "install unknown apps" and asks for USER_ACTION_NOT_REQUIRED is installed with no
 * dialog, so the next launch is already the new version. Older Android (or a refused silent install) shows
 * the system confirmation the next time the person opens the app.
 */
object SelfUpdate {
    @Volatile var foreground = false
    private const val WORK = "ijara360-self-update"
    const val PREFS = "ijara360_self_update"

    fun dir(ctx: Context) = File(ctx.cacheDir, "update").apply { mkdirs() }

    fun canInstall(ctx: Context) = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ctx.packageManager.canRequestPackageInstalls()

    fun openSettings(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Install about a minute after the app leaves the screen, so a quick app switch is never interrupted. */
    fun schedule(ctx: Context, path: String) {
        val request = OneTimeWorkRequest.Builder(InstallWorker::class.java)
            .setInitialDelay(60, TimeUnit.SECONDS)
            .setBackoffCriteria(BackoffPolicy.LINEAR, 15, TimeUnit.MINUTES)
            .setInputData(Data.Builder().putString("path", path).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, request)
    }

    fun cancel(ctx: Context) { WorkManager.getInstance(ctx).cancelUniqueWork(WORK) }

    fun pendingConfirm(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("confirm", false)

    fun clear(ctx: Context) { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply() }

    fun install(ctx: Context, apk: File, interactive: Boolean) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            apk.inputStream().use { input -> session.openWrite("base.apk", 0, apk.length()).use { out -> input.copyTo(out); session.fsync(out) } }
            val result = Intent(ctx, InstallResultReceiver::class.java).putExtra("interactive", interactive)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(ctx, id, result, flags).intentSender)
        }
    }
}

/** Runs the scheduled install; waits (retries later) while the person is using the app. */
class InstallWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        if (SelfUpdate.foreground) return Result.retry()
        val apk = File(inputData.getString("path") ?: return Result.failure())
        if (!apk.isFile || !SelfUpdate.canInstall(applicationContext)) return Result.failure()
        return try { SelfUpdate.install(applicationContext, apk, interactive = false); Result.success() } catch (e: Exception) { Result.retry() }
    }
}

/** PackageInstaller's answer. A needed confirmation is shown now only if the person is looking at the app. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val prefs = ctx.getSharedPreferences(SelfUpdate.PREFS, Context.MODE_PRIVATE)
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm != null && (intent.getBooleanExtra("interactive", false) || SelfUpdate.foreground)) {
                    ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } else {
                    prefs.edit().putBoolean("confirm", true).apply()
                }
            }
            PackageInstaller.STATUS_SUCCESS -> prefs.edit().clear().apply()
            // A refused silent install is not retried in the dark: the app offers the one-tap install instead.
            else -> prefs.edit().putBoolean("confirm", true).putString("error", intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "install failed").apply()
        }
    }
}
