import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/client.dart';
import '../location/agent.dart';
import '../theme.dart';
import '../ui/kit.dart';

/// "N минут назад" for location times.
String agoText(String? iso) {
  if (iso == null) return '—';
  final s = DateTime.now().difference(DateTime.parse(iso)).inSeconds;
  if (s < 30) return 'только что';
  if (s < 60) return '$s сек назад';
  if (s < 3600) return '${s ~/ 60} мин назад';
  if (s < 86400) return '${s ~/ 3600} ч назад';
  return dayTime(iso);
}

String accuracyLabel(num? m) {
  if (m == null) return '—';
  if (m >= 1000) return 'низкая, около ${(m / 1000).toStringAsFixed(1).replaceAll('.', ',')} км';
  return 'около ${m.round()} м';
}

/// Owner's decision (2026-10-17): no "Геолокация" item in the resident's profile. Consent is asked once,
/// in plain words, right after sign-in; withdrawal is the phone's own permission switch, and the server shows
/// a withdrawn permission to staff as "Отключена". Nothing is collected without that consent.
const _askedKey = 'ijara_location_asked';

Future<bool> _consentDialog(BuildContext context) async => await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (c) => AlertDialog(
        title: const Text('Геолокация для безопасности'),
        content: const SingleChildScrollView(child: Text(
          // Short enough to read whole on a 320 dp phone (the longer text needed scrolling on the device test).
          'Администрация просит видеть, где вы, — для вашей безопасности. '
          'Видят только сотрудники с доступом, история хранится 30 дней, после выселения передача останавливается.\n\n'
          'Выключить: Настройки телефона → Приложения → Ijara360 → Местоположение.')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Не сейчас')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Разрешить')),
        ],
      ),
    ) ??
    false;

/// The phone's permission: the system dialog, then "Разрешить в любом режиме" (Android 10+ keeps it in settings).
Future<bool> _grant(BuildContext context, {bool explainAlways = true}) async {
  var p = await Geolocator.checkPermission();
  if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
  if (p == LocationPermission.denied || p == LocationPermission.deniedForever) return false;
  if (p != LocationPermission.always && explainAlways && context.mounted) {
    await showDialog<void>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Ещё один шаг'),
        content: const Text('Чтобы место передавалось и когда приложение закрыто, в настройках выберите «Разрешить в любом режиме».'),
        actions: [FilledButton(onPressed: () => Navigator.pop(c), child: const Text('Открыть настройки'))],
      ),
    );
    await Geolocator.openAppSettings();
  }
  return true;
}

class ForegroundLocation extends StatefulWidget {
  const ForegroundLocation({super.key, required this.child});
  final Widget child;
  @override
  State<ForegroundLocation> createState() => _ForegroundLocationState();
}

class _ForegroundLocationState extends State<ForegroundLocation> with WidgetsBindingObserver {
  StreamSubscription<Position>? sub;
  StreamSubscription<ServiceStatus>? services;
  Timer? tick;
  DateTime? lastFlush;
  bool active = false;

  @override
  void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); LocationAgent.started.addListener(resume); WidgetsBinding.instance.addPostFrameCallback((_) => resume()); }
  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); LocationAgent.started.removeListener(resume); pause(); super.dispose(); }
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) { if (s == AppLifecycleState.resumed) { resume(); } else if (s == AppLifecycleState.paused) { pause(); } }

  void pause() { active = false; sub?.cancel(); sub = null; services?.cancel(); services = null; tick?.cancel(); tick = null; }

  Future<void> resume() async {
    if (kIsWeb || active || asking || !mounted) return;
    final api = SessionScope.of(context).api;
    try {
      final r = await api.get('/tenant/location') as Map<String, dynamic>;
      if (r['resident'] != true) return;
      if (r['thisDeviceIsPrimary'] != true && !await _arrange(api, r)) return;
      active = true;
      await LocationAgent.start(); // re-registers the background task after an update or reboot
      // GPS switched off or on in the shade: tell the server at once, restart the stream when it is back.
      services = Geolocator.getServiceStatusStream().listen((_) => unawaited(check(api)), onError: (_) {});
      // While the app is open: a state report every minute and a point at least every 2 minutes, so a phone
      // lying still stays "В сети" (the server's live window is 3 minutes).
      tick = Timer.periodic(LocationPolicy.foregroundTick, (_) => unawaited(check(api, capture: true)));
      await check(api, capture: true);
    } on ApiException {
      // Offline at start: the background task and the next resume will try again.
    }
  }

  bool asking = false;

  /// Not sending from this phone yet. Asks once for consent; after a sign-out (consent given, no phone signed in)
  /// resumes on this phone; leaves another signed-in phone alone. True when this phone now sends.
  Future<bool> _arrange(ApiClient api, Map<String, dynamic> r) async {
    if (asking || !mounted) return false;
    asking = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      if (r['sharingEnabled'] == true) {
        if (r['primaryDevice'] != null) return false;
        if (!mounted || !await _grant(context, explainAlways: false)) return false;
      } else {
        if (prefs.getBool(_askedKey) == true || !mounted) return false;
        final yes = await _consentDialog(context);
        await prefs.setBool(_askedKey, true);
        if (!yes || !mounted || !await _grant(context)) return false;
      }
      await api.post('/tenant/location/consent', {'enabled': true});
      await LocationAgent.start(); // registers the background task; the listener is ignored while asking
      return true;
    } finally {
      asking = false;
    }
  }

  /// Sends the honest device state; keeps the position stream running only while it can deliver.
  Future<void> check(ApiClient api, {bool capture = false}) async {
    if (!active) return;
    final state = await DeviceState.read();
    if (!state.granted || !state.servicesEnabled) {
      await sub?.cancel(); sub = null;
      await send(api, state, null);
      return;
    }
    sub ??= Geolocator.getPositionStream(locationSettings: AndroidSettings(accuracy: LocationAccuracy.high, distanceFilter: LocationPolicy.foregroundDistanceMeters, intervalDuration: LocationPolicy.foregroundInterval))
        .listen((p) => unawaited(onFix(api, p)), onError: (_) { sub = null; unawaited(check(api)); });
    if (capture) {
      try {
        final p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 20)));
        await onFix(api, p, force: true);
      } catch (_) {
        await send(api, state, null, force: true);
      }
    }
  }

  Future<void> onFix(ApiClient api, Position p, {bool force = false}) async {
    final buffer = LocationBuffer(await SharedPreferences.getInstance());
    await LocationAgent.queue(buffer, p);
    await send(api, await DeviceState.read(), buffer, force: force);
  }

  /// At most one upload per 20 s from the stream; the minute tick and GPS changes always go.
  Future<void> send(ApiClient api, DeviceState state, LocationBuffer? buffer, {bool force = true}) async {
    if (!force && lastFlush != null && DateTime.now().difference(lastFlush!) < LocationPolicy.minGap) return;
    lastFlush = DateTime.now();
    final reason = await LocationAgent.flush(api, state, buffer: buffer);
    if (reason == null) return;
    pause();
    // The server ended the session (checkout, revoked device): leave the account, as a 401 does elsewhere.
    if (reason == StopReason.signedOut && mounted) await SessionScope.of(context).expired();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Staff: counters and the resident list in the app; the full map opens in the cabinet.
class StaffMapScreen extends StatefulWidget {
  const StaffMapScreen({super.key});
  @override
  State<StaffMapScreen> createState() => _StaffMapScreenState();
}

class _StaffMapScreenState extends State<StaffMapScreen> {
  String filter = 'ALL';
  String query = '';
  static const labels = {'ALL': 'Все', 'LIVE': 'В сети', 'STALE': 'Давно', 'OFFLINE': 'Нет связи', 'LOCATION_DISABLED': 'Отключена'};
  static Tone tone(String s) => switch (s) { 'LIVE' => Tone.green, 'STALE' => Tone.orange, 'LOCATION_DISABLED' => Tone.red, _ => Tone.gray };

  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Карта'), actions: [
        IconButton(tooltip: 'Открыть карту в кабинете', icon: const Icon(Icons.map_rounded), onPressed: () => launchUrl(Uri.parse('${apiOrigin()}/map'), mode: LaunchMode.externalApplication)),
      ]),
      body: LiveData<Map<String, dynamic>>(
        topics: const {'location'},
        load: () async => (await s.api.get('/locations')) as Map<String, dynamic>,
        builder: (context, data, refresh) {
          final counts = (data['counts'] as Map).cast<String, dynamic>();
          final q = query.trim().toLowerCase().replaceFirst(RegExp(r'^(комната|место)\s*'), '');
          final items = (data['items'] as List).cast<Map<String, dynamic>>().where((i) =>
              (filter == 'ALL' || i['status'] == filter) &&
              (q.isEmpty || '${i['fullName']}'.toLowerCase().contains(q) || i['room'] == q || i['bed'] == q)).toList();
          return PageBody(maxWidth: 900, onRefresh: refresh, children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final k in labels.keys) ChoiceChip(
                label: Text('${labels[k]} ${counts[k] ?? 0}'),
                selected: filter == k,
                selectedColor: Brand.yellow,
                onSelected: (_) => setState(() => filter = k),
              ),
            ]),
            const Gap(12),
            TextField(decoration: const InputDecoration(labelText: 'Имя, комната или место', prefixIcon: Icon(Icons.search_rounded)), onChanged: (v) => setState(() => query = v)),
            const Gap(12),
            if (items.isEmpty) const EmptyState(icon: Icons.location_off_rounded, title: 'Никого не нашли', text: 'Измените фильтр или поиск.'),
            for (final i in items) Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AppCard(child: Row(children: [
                Avatar('${i['fullName']}', size: 44),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${i['fullName']}', style: manrope(15, FontWeight.w700)),
                  Text([if (i['room'] != null) 'Комната ${i['room']}', if (i['bed'] != null) 'Место ${i['bed']}'].join(' · '), style: Theme.of(context).textTheme.bodySmall),
                  Text(i['position'] == null ? '—' : '${i['status'] == 'LIVE' ? 'Обновлено' : 'Последняя точка'} ${agoText(i['position']['recordedAt'] as String?)} · ${accuracyLabel(i['position']['accuracy'] as num?)}', style: Theme.of(context).textTheme.bodySmall),
                ])),
                Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                  StatusPill('${labels[i['status']]}', tone: tone('${i['status']}')),
                  if (i['position'] != null) IconButton(
                    tooltip: 'Открыть в Яндекс Навигаторе',
                    icon: const Icon(Icons.navigation_rounded),
                    onPressed: () => openInYandex(context, s.api, '${i['residentId']}'),
                  ),
                ]),
              ])),
            ),
          ]);
        },
      ),
    );
  }
}

/// Yandex Navigator first, then Yandex Maps, then the browser. Only the point leaves the phone: no name or
/// other data goes into the link. Coordinates come from the per-resident endpoint, so the server audits
/// the view (RESIDENT_LOCATION_VIEWED) exactly as on the web map.
List<Uri> yandexLinks(num lat, num lon) => [
      Uri.parse('yandexnavi://show_point_on_map?lat=$lat&lon=$lon&zoom=17&no-balloon=1'),
      Uri.parse('yandexmaps://maps.yandex.ru/?pt=$lon,$lat&z=17&l=map'),
      Uri.parse('https://yandex.ru/maps/?pt=$lon,$lat&z=17&l=map'),
    ];

Future<void> openInYandex(BuildContext context, ApiClient api, String residentId) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final r = (await api.get('/residents/$residentId/location')) as Map<String, dynamic>;
    final p = r['position'] as Map<String, dynamic>?;
    if (p == null) { messenger.showSnackBar(const SnackBar(content: Text('У жильца пока нет точки.'))); return; }
    for (final u in yandexLinks(p['latitude'] as num, p['longitude'] as num)) {
      if (u.scheme != 'https' && !await canLaunchUrl(u)) continue;
      if (await launchUrl(u, mode: LaunchMode.externalApplication)) return;
    }
    messenger.showSnackBar(const SnackBar(content: Text('Не удалось открыть Яндекс Навигатор или Карты.')));
  } on ApiException catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
  }
}
