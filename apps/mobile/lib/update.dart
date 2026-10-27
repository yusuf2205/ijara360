import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api/client.dart';
import 'theme.dart';

/// The release this build was made from (git commit), baked in by scripts/Build-MobileWeb.ps1
/// (`--dart-define=BUILD_COMMIT=...`). Empty in `flutter test` and in debug runs, which disables updating.
const String buildCommit = String.fromEnvironment('BUILD_COMMIT');

/// This build's Android versionCode (the release's commit count), baked in alongside the commit.
const int buildNumber = int.fromEnvironment('BUILD_NUMBER');

const _native = MethodChannel('uz.ijara360/update');
bool get _android => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
bool get _enabled => _android && buildNumber > 0;

/// The server's build number when it is strictly higher than this one, else null. A server rolled back to an
/// older release is never "an update" (Android would refuse the downgrade anyway). Never throws.
Future<int?> newerRelease() async {
  if (!_enabled) return null;
  try {
    // Cache-buster so a proxy never serves an old BUILD and hides a real update.
    final r = await http.get(Uri.parse('${apiOrigin()}/app/BUILD?t=${DateTime.now().millisecondsSinceEpoch}')).timeout(const Duration(seconds: 8));
    final latest = r.statusCode == 200 ? int.tryParse(r.body.trim()) : null;
    return latest != null && latest > buildNumber ? latest : null;
  } catch (_) {
    return null;
  }
}

/// Fetches the small APK for this phone's processor (~20 MB); falls back to the universal one (~55 MB)
/// when the processor is unknown or the server has no per-processor file.
Future<bool> _download(File target) async {
  String? abi;
  try { abi = await _native.invokeMethod<String>('abi'); } catch (_) {}
  if (abi != null && await _fetch('/app/ijara360-$abi.apk', target)) return true;
  return _fetch('/app/ijara360.apk', target);
}

/// Downloads to `<file>.part` and renames only once every byte has arrived.
Future<bool> _fetch(String path, File target) async {
  final part = File('${target.path}.part');
  final client = http.Client();
  try {
    final res = await client.send(http.Request('GET', Uri.parse('${apiOrigin()}$path'))).timeout(const Duration(seconds: 30));
    if (res.statusCode != 200) return false;
    final sink = part.openWrite();
    var got = 0;
    await for (final chunk in res.stream.timeout(const Duration(seconds: 60))) { got += chunk.length; sink.add(chunk); }
    await sink.close();
    if (got < 1024 * 1024 || (res.contentLength != null && got != res.contentLength)) { await part.delete(); return false; }
    await part.rename(target.path);
    return true;
  } catch (_) {
    try { if (await part.exists()) await part.delete(); } catch (_) {}
    return false;
  } finally {
    client.close();
  }
}

/// Whether this build can update itself (Android release build). False on web and in debug/test runs.
bool get updatesSupported => _enabled;

/// Version line for the Профиль «О приложении» card.
String get appVersionLabel => buildNumber > 0 ? '1.0.$buildNumber' : 'веб-версия';

/// The Профиль button. Checks the server now and answers either way, then downloads and installs if there is
/// a newer build. Auto-update still runs on its own in the background; this is the manual fallback for when it
/// has not happened yet (no internet earlier, install permission not granted, etc.).
Future<void> checkForUpdateNow(BuildContext context) async {
  final messenger = ScaffoldMessenger.of(context);
  void say(String m) { messenger.clearSnackBars(); messenger.showSnackBar(SnackBar(content: Text(m))); }
  if (!_enabled) { say('Обновление устанавливается только в приложении для Android. Веб-версия обновляется сама.'); return; }
  say('Проверяем обновления…');
  final latest = await newerRelease();
  if (latest == null) { say('Установлена последняя версия (1.0.$buildNumber).'); return; }
  try {
    final dir = Directory((await _native.invokeMethod<String>('updateDir'))!);
    final apk = File('${dir.path}/ijara360-$latest.apk');
    if (!await apk.exists()) {
      say('Скачиваем новую версию (1.0.$latest)…');
      if (!await _download(apk)) { say('Не удалось скачать. Проверьте интернет и попробуйте ещё раз.'); return; }
    }
    if (!(await _native.invokeMethod<bool>('canInstall') ?? false)) {
      say('Разрешите установку обновлений — сейчас откроются настройки.');
      await _native.invokeMethod('openInstallSettings');
      return;
    }
    messenger.clearSnackBars();
    await _native.invokeMethod('installNow', {'path': apk.path});
  } catch (_) {
    say('Не удалось обновить. Попробуйте позже.');
  }
}

enum _Stage { idle, silent, needsPermission, needsConfirm, failed, updated }

/// Updates the Android app in the background: a newer release is downloaded while the app is in use and
/// installed by the system once the app leaves the screen (SelfUpdate.kt), so the next launch is already new.
/// The banner appears only when the person has to do something: allow updates once, confirm on older
/// Android, or download by hand if the background download failed. Inert on web and in tests.
class UpdateBanner extends StatefulWidget {
  const UpdateBanner({super.key});
  @override
  State<UpdateBanner> createState() => _UpdateBannerState();
}

class _UpdateBannerState extends State<UpdateBanner> with WidgetsBindingObserver {
  _Stage _stage = _Stage.idle;
  String? _apk;
  bool _checking = false, _dismissed = false, _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startup();
  }

  Future<void> _startup() async {
    await _announceIfUpdated();
    await _check();
  }

  /// Shows a short "Обновлено до 1.0.X" confirmation the first time a build runs after it was installed — so a
  /// silent background update is visible to the person. Compares this build to the last one that ran on the phone.
  Future<void> _announceIfUpdated() async {
    if (!_enabled) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final last = prefs.getInt('ijara_last_build') ?? 0;
      await prefs.setInt('ijara_last_build', buildNumber);
      if (last > 0 && buildNumber > last) {
        _set(_Stage.updated);
        Timer(const Duration(seconds: 6), () { if (mounted && _stage == _Stage.updated) _set(_Stage.idle); });
      }
    } catch (_) {}
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!_enabled) return;
    if (state == AppLifecycleState.paused && _stage == _Stage.silent && _apk != null) {
      _native.invokeMethod('scheduleInstall', {'path': _apk}).catchError((_) {});
    } else if (state == AppLifecycleState.resumed) {
      _native.invokeMethod('cancelInstall').catchError((_) {});
      _check(); // the person may have just allowed updates in the settings
    }
  }

  Future<void> _check() async {
    if (_checking || !_enabled) return;
    _checking = true;
    try {
      final latest = await newerRelease();
      final dir = Directory((await _native.invokeMethod<String>('updateDir'))!);
      if (latest == null) {
        // Up to date (or offline): drop leftovers of an update that has been installed meanwhile.
        if (await dir.exists()) { for (final f in dir.listSync()) { try { f.deleteSync(); } catch (_) {} } }
        await _native.invokeMethod('clear');
        if (_stage != _Stage.updated) _set(_Stage.idle); // don't clobber the "just updated" confirmation
        return;
      }
      final apk = File('${dir.path}/ijara360-$latest.apk');
      if (!await apk.exists()) {
        for (final f in dir.listSync()) { if (f.path != apk.path) { try { f.deleteSync(); } catch (_) {} } }
        if (!await _download(apk)) { _set(_Stage.failed); return; }
      }
      _apk = apk.path;
      final canInstall = await _native.invokeMethod<bool>('canInstall') ?? false;
      final silent = await _native.invokeMethod<bool>('silentCapable') ?? false;
      final confirm = await _native.invokeMethod<bool>('pendingConfirm') ?? false;
      _set(!canInstall ? _Stage.needsPermission : (!silent || confirm) ? _Stage.needsConfirm : _Stage.silent);
      debugPrint('[update] $latest ready, stage=$_stage');
    } catch (e) {
      debugPrint('[update] check failed: $e');
      _set(_Stage.idle);
    } finally {
      _checking = false;
    }
  }

  void _set(_Stage s) { if (mounted) setState(() => _stage = s); }

  Future<void> _act() async {
    setState(() => _busy = true);
    try {
      switch (_stage) {
        case _Stage.needsPermission: await _native.invokeMethod('openInstallSettings');
        case _Stage.needsConfirm: await _native.invokeMethod('installNow', {'path': _apk});
        case _Stage.failed: await launchUrl(Uri.parse('${apiOrigin()}/app/ijara360.apk'), mode: LaunchMode.externalApplication);
        default: break;
      }
    } catch (_) {}
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final (icon, title, subtitle, action) = switch (_stage) {
      _Stage.needsPermission => (Icons.autorenew_rounded, 'Автообновление', 'Разрешите один раз — дальше всё само', 'Разрешить'),
      _Stage.needsConfirm => (Icons.download_done_rounded, 'Версия скачана', 'Установка займёт пару секунд', 'Установить'),
      _Stage.failed => (Icons.rocket_launch_rounded, 'Новая версия', 'Скачайте и установите', 'Обновить'),
      _Stage.updated => (Icons.check_circle_rounded, 'Готово', 'Обновлено до версии 1.0.$buildNumber', ''),
      _ => (Icons.circle, '', '', ''),
    };
    final visible = title.isNotEmpty && !_dismissed;
    // A floating card over the screen (the page underneath does not jump), sliding in from the top.
    return Align(
      alignment: Alignment.topCenter,
      child: AnimatedSlide(
        offset: visible ? Offset.zero : const Offset(0, -1.4),
        duration: const Duration(milliseconds: 380),
        curve: Curves.easeOutCubic,
        child: AnimatedOpacity(
          opacity: visible ? 1 : 0,
          duration: const Duration(milliseconds: 250),
          child: !visible && title.isEmpty ? const SizedBox.shrink() : SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 520),
                child: Material(
                  color: Brand.navy,
                  elevation: 8,
                  shadowColor: Brand.navy.withValues(alpha: .35),
                  borderRadius: BorderRadius.circular(20),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 12, 6, 12),
                    child: Row(children: [
                      Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(14),
                          gradient: const LinearGradient(colors: [Brand.blue, Brand.blueDark], begin: Alignment.topLeft, end: Alignment.bottomRight),
                        ),
                        child: Icon(icon, color: Brand.white, size: 22),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: manrope(14.5, FontWeight.w800, color: Brand.white)),
                          const SizedBox(height: 2),
                          Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis, style: manrope(12.5, FontWeight.w600, color: Brand.blueLight, height: 1.3)),
                        ]),
                      ),
                      if (action.isNotEmpty) ...[
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: _busy ? null : _act,
                          style: FilledButton.styleFrom(
                            backgroundColor: Brand.white,
                            foregroundColor: Brand.blue,
                            disabledBackgroundColor: Brand.white.withValues(alpha: .6),
                            minimumSize: const Size(0, 40),
                            padding: const EdgeInsets.symmetric(horizontal: 16),
                            shape: const StadiumBorder(),
                            textStyle: manrope(13.5, FontWeight.w800),
                          ),
                          child: _busy
                              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.4, color: Brand.blue))
                              : Text(action),
                        ),
                      ] else
                        const SizedBox(width: 8),
                      // No tooltip: this card sits above the Navigator, where there is no Overlay for one.
                      Semantics(
                        label: 'Позже',
                        button: true,
                        child: InkResponse(
                          onTap: () => setState(() => _dismissed = true),
                          radius: 20,
                          child: const Padding(padding: EdgeInsets.all(8), child: Icon(Icons.close_rounded, color: Color(0xFFAEB9D6), size: 18)),
                        ),
                      ),
                    ]),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
