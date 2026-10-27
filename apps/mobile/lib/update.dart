import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'api/client.dart';

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

enum _Stage { idle, silent, needsPermission, needsConfirm, failed }

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
    _check();
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
        _set(_Stage.idle);
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
    final (text, action) = switch (_stage) {
      _Stage.needsPermission => ('Разрешите приложению устанавливать обновления — дальше оно будет обновляться само, без вашего участия.', 'Разрешить'),
      _Stage.needsConfirm => ('Новая версия уже скачана. Нажмите «Установить» — это займёт несколько секунд.', 'Установить'),
      _Stage.failed => ('Вышла новая версия приложения. Нажмите «Обновить» — файл скачается, откройте его и нажмите «Установить».', 'Обновить'),
      _ => ('', ''),
    };
    if (text.isEmpty || _dismissed) return const SizedBox.shrink();
    final cs = Theme.of(context).colorScheme;
    return Material(
      color: cs.primary,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 6, 8),
          child: Row(children: [
            const Icon(Icons.system_update_rounded, color: Colors.white, size: 20),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: const TextStyle(color: Colors.white, fontSize: 12.5, fontWeight: FontWeight.w600, height: 1.3))),
            TextButton(onPressed: _busy ? null : _act, child: Text(action, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800))),
            IconButton(tooltip: 'Позже', onPressed: () => setState(() => _dismissed = true), icon: const Icon(Icons.close_rounded, color: Colors.white70, size: 18)),
          ]),
        ),
      ),
    );
  }
}
