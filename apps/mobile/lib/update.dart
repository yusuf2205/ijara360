import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'api/client.dart';

/// The release this build was made from (git commit), baked in by scripts/Build-MobileWeb.ps1
/// (`--dart-define=BUILD_COMMIT=...`). Empty in `flutter test` and in debug runs, which disables the check.
const String buildCommit = String.fromEnvironment('BUILD_COMMIT');

/// Whether the server carries a newer build than this one. Native only — the web app is always served fresh,
/// and a build without a baked-in commit (tests, debug) never reports an update. Never throws.
Future<bool> updateAvailable() async {
  if (kIsWeb || buildCommit.isEmpty) return false;
  try {
    // Cache-buster so a proxy never serves an old COMMIT and hides a real update.
    final r = await http.get(Uri.parse('${apiOrigin()}/app/COMMIT?t=${DateTime.now().millisecondsSinceEpoch}')).timeout(const Duration(seconds: 8));
    if (r.statusCode != 200) return false;
    final latest = r.body.trim();
    return latest.length >= 7 && latest != buildCommit;
  } catch (_) {
    return false;
  }
}

/// Opens the latest APK so Android downloads it and offers to install. A sideloaded app cannot install
/// silently — the person taps "Install" (and allows this source once); this is the closest to self-updating.
Future<void> downloadUpdate() => launchUrl(Uri.parse('${apiOrigin()}/app/ijara360.apk'), mode: LaunchMode.externalApplication);

/// A thin top banner shown on every screen once a newer build is found; checks once when it mounts.
class UpdateBanner extends StatefulWidget {
  const UpdateBanner({super.key});
  @override
  State<UpdateBanner> createState() => _UpdateBannerState();
}

class _UpdateBannerState extends State<UpdateBanner> {
  bool _show = false, _dismissed = false, _busy = false;

  @override
  void initState() {
    super.initState();
    updateAvailable().then((yes) {
      if (yes && mounted) setState(() => _show = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_show || _dismissed) return const SizedBox.shrink();
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
            const Expanded(
              child: Text('Вышла новая версия приложения. Нажмите «Обновить» — файл скачается, откройте его и нажмите «Установить».',
                  style: TextStyle(color: Colors.white, fontSize: 12.5, fontWeight: FontWeight.w600, height: 1.3)),
            ),
            TextButton(
              onPressed: _busy ? null : () async {
                setState(() => _busy = true);
                try { await downloadUpdate(); } catch (_) {}
                if (mounted) setState(() => _busy = false);
              },
              child: const Text('Обновить', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
            ),
            IconButton(
              tooltip: 'Позже',
              onPressed: () => setState(() => _dismissed = true),
              icon: const Icon(Icons.close_rounded, color: Colors.white70, size: 18),
            ),
          ]),
        ),
      ),
    );
  }
}
