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

/// Resident: what is shared, the real phone state, and the switches that actually control it.
/// Nothing here pretends: if Android says "denied", the screen says "denied" and opens settings.
class LocationScreen extends StatefulWidget {
  const LocationScreen({super.key});
  @override
  State<LocationScreen> createState() => _LocationScreenState();
}

class _LocationScreenState extends State<LocationScreen> with WidgetsBindingObserver {
  Map<String, dynamic>? server;
  DeviceState? device;
  StopReason? stopped;
  String? error;
  bool busy = false;

  @override
  void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); refresh(); }
  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); super.dispose(); }
  // Coming back from the phone's settings: show what changed there.
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) { if (s == AppLifecycleState.resumed) refresh(); }

  Future<void> refresh() async {
    final s = SessionScope.of(context);
    try {
      final st = kIsWeb ? null : await DeviceState.read();
      final r = await s.api.get('/tenant/location') as Map<String, dynamic>;
      final why = await LocationAgent.stoppedReason();
      if (mounted) setState(() { server = r; device = st; stopped = why; error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    }
  }

  Future<void> run(Future<void> Function() action) async {
    setState(() => busy = true);
    try { await action(); } on ApiException catch (e) { if (mounted) toast(context, e.message); }
    finally { if (mounted) setState(() => busy = false); await refresh(); }
  }

  /// Turn on: OS permission first (the system dialog), then consent on the server, then collection.
  Future<void> enable() => run(() async {
        final s = SessionScope.of(context);
        var p = await Geolocator.checkPermission();
        if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
        if (p == LocationPermission.denied || p == LocationPermission.deniedForever) {
          if (mounted) toast(context, 'Без разрешения телефона передача невозможна.');
          return;
        }
        await s.api.post('/tenant/location/consent', {'enabled': true});
        await LocationAgent.start();
        await LocationAgent.captureAndSend(s.api, force: true);
      });

  Future<void> disable() => run(() async {
        final s = SessionScope.of(context);
        await s.api.post('/tenant/location/consent', {'enabled': false});
        await LocationAgent.stop();
      });

  /// Second step on Android 10+: "Allow all the time" lives in the app's settings page.
  Future<void> askAlways() => run(() async {
        final p = await Geolocator.requestPermission();
        if (p != LocationPermission.always) await Geolocator.openAppSettings();
      });

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final r = server;
    return Scaffold(
      appBar: AppBar(title: const Text('Геолокация')),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: PageBody(maxWidth: 640, children: [
          if (error != null) AppCard(color: Brand.redSoft, child: Text(error!, style: manrope(14, FontWeight.w600))),
          if (r == null && error == null) const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator())),
          if (r != null) ..._content(context, r, t),
          const Gap(16),
          AppCard(color: Brand.gray100, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Как это работает', style: manrope(15, FontWeight.w800)),
            const Gap(8),
            Text('• Передача включается только вами и выключается здесь в любой момент.\n'
                '• Ваше место видят владелец дома и сотрудники, которым он дал доступ. Каждый просмотр истории записывается.\n'
                '• История перемещений хранится ${r?['policy']?['retentionDays'] ?? 30} дней и удаляется автоматически.\n'
                '• Когда приложение закрыто, Android отправляет место примерно раз в 15 минут или реже — так экономится батарея.\n'
                '• После выселения передача останавливается.', style: t.bodyMedium?.copyWith(height: 1.5)),
          ])),
        ]),
      ),
    );
  }

  List<Widget> _content(BuildContext context, Map<String, dynamic> r, TextTheme t) {
    if (kIsWeb) {
      return [_hero(Icons.phone_android_rounded, Tone.gray, 'Работает в приложении для Android', 'Браузер не может передавать местоположение в фоне. Установите приложение Ijara360 на телефон.')];
    }
    if (r['resident'] != true || stopped == StopReason.notResident) {
      return [_hero(Icons.location_off_rounded, Tone.gray, 'Передача остановлена', 'Проживание завершено, поэтому местоположение больше не передаётся.')];
    }
    final d = device;
    final enabled = r['sharingEnabled'] == true;
    if (!enabled) {
      return [
        _hero(Icons.location_on_outlined, Tone.yellow, 'Передача местоположения выключена', 'Включите, если хотите, чтобы администрация видела, где вы, — например, для вашей безопасности.'),
        const Gap(14),
        FilledButton.icon(onPressed: busy ? null : enable, icon: const Icon(Icons.my_location_rounded), label: const Text('Включить передачу')),
      ];
    }
    if (r['thisDeviceIsPrimary'] != true) {
      return [
        _hero(Icons.phone_iphone_rounded, Tone.orange, 'Передаёт другой телефон', 'Сейчас местоположение отправляет «${r['primaryDevice'] ?? 'другое устройство'}». Точки с двух телефонов не смешиваются.'),
        const Gap(14),
        FilledButton(onPressed: busy ? null : enable, child: const Text('Передавать с этого телефона')),
        TextButton(onPressed: busy ? null : disable, child: const Text('Выключить передачу')),
      ];
    }
    final widgets = <Widget>[];
    if (d != null && !d.servicesEnabled) {
      widgets.addAll([
        _hero(Icons.location_disabled_rounded, Tone.red, 'Геолокация отключена', 'В телефоне выключены службы геолокации. Чтобы обновлять ваше местоположение, включите их.'),
        const Gap(14),
        FilledButton(onPressed: () => Geolocator.openLocationSettings(), child: const Text('Открыть настройки')),
      ]);
    } else if (d != null && !d.granted) {
      widgets.addAll([
        _hero(Icons.location_disabled_rounded, Tone.red, 'Геолокация отключена', 'Чтобы обновлять ваше местоположение, разрешите приложению доступ в настройках телефона.'),
        const Gap(14),
        FilledButton(onPressed: () => Geolocator.openAppSettings(), child: const Text('Открыть настройки')),
      ]);
    } else {
      final live = r['status'] == 'LIVE';
      widgets.add(_hero(live ? Icons.my_location_rounded : Icons.location_searching_rounded, live ? Tone.green : Tone.orange,
          live ? 'Геолокация активна' : 'Ждём свежую точку', live ? 'Ваше местоположение обновляется.' : 'Телефон ещё не отправил свежую точку. Это нормально в помещении или в режиме экономии.'));
      if (d != null && !d.always) {
        widgets.addAll([
          const Gap(12),
          AppCard(color: Brand.orangeSoft, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Только при открытом приложении', style: manrope(15, FontWeight.w800)),
            const Gap(4),
            Text('Сейчас место передаётся, только пока приложение открыто. Чтобы передавать и в фоне, выберите «Разрешить всегда».', style: Theme.of(context).textTheme.bodyMedium),
            const Gap(10),
            OutlinedButton(onPressed: busy ? null : askAlways, child: const Text('Разрешить всегда')),
          ])),
        ]);
      }
    }
    widgets.addAll([
      const Gap(14),
      AppCard(child: Column(children: [
        KeyValue('Последнее обновление', agoText(r['lastSentAt'] as String?)),
        KeyValue('Точность', accuracyLabel(r['accuracyMeters'] as num?)),
        KeyValue('Работа в фоне', d == null ? '—' : d.always ? 'разрешена' : 'ограничена'),
        KeyValue('Основной телефон', '${r['primaryDevice'] ?? 'этот'}'),
      ])),
      const Gap(12),
      OutlinedButton.icon(onPressed: busy ? null : () => run(() => LocationAgent.captureAndSend(SessionScope.of(context).api, force: true)), icon: const Icon(Icons.refresh_rounded), label: const Text('Отправить сейчас')),
      TextButton(onPressed: busy ? null : disable, child: const Text('Выключить передачу')),
    ]);
    return widgets;
  }

  Widget _hero(IconData icon, Tone tone, String title, String text) => AppCard(child: Column(children: [
        IconChip(icon, tone: tone, size: 64),
        const Gap(14),
        Semantics(header: true, child: Text(title, textAlign: TextAlign.center, style: manrope(20, FontWeight.w800))),
        const Gap(6),
        Text(text, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Brand.gray500, height: 1.45)),
      ]));
}

/// Profile card that opens the location screen and shows its state in one line.
class LocationCard extends StatelessWidget {
  const LocationCard({super.key});
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: LiveData<Map<String, dynamic>>(
        topics: const {'location'},
        load: () async => (await s.api.get('/tenant/location')) as Map<String, dynamic>,
        builder: (context, r, _) => AppCard(
          semanticLabel: 'Геолокация: открыть',
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const LocationScreen())),
          child: Row(children: [
            IconChip(Icons.location_on_rounded, tone: r['sharingEnabled'] == true ? (r['status'] == 'LIVE' ? Tone.green : Tone.orange) : Tone.gray),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Геолокация', style: manrope(15, FontWeight.w700)),
              Text(r['sharingEnabled'] == true ? (r['status'] == 'LIVE' ? 'Активна · ${agoText(r['lastSentAt'] as String?)}' : 'Включена · ждём свежую точку') : 'Выключена', style: Theme.of(context).textTheme.bodySmall),
            ])),
            const Icon(Icons.chevron_right_rounded),
          ]),
        ),
      ),
    );
  }
}

/// While the resident's app is open, a position stream sends real movement (every 30 s / 25 m at most);
/// in the background WorkManager takes over. Paused when the app leaves the screen.
class ForegroundLocation extends StatefulWidget {
  const ForegroundLocation({super.key, required this.child});
  final Widget child;
  @override
  State<ForegroundLocation> createState() => _ForegroundLocationState();
}

class _ForegroundLocationState extends State<ForegroundLocation> with WidgetsBindingObserver {
  StreamSubscription<Position>? sub;
  DateTime? lastFlush;

  @override
  void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); WidgetsBinding.instance.addPostFrameCallback((_) => resume()); }
  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); sub?.cancel(); super.dispose(); }
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) { if (s == AppLifecycleState.resumed) { resume(); } else if (s == AppLifecycleState.paused) { sub?.cancel(); sub = null; } }

  Future<void> resume() async {
    if (kIsWeb || sub != null || !mounted) return;
    final api = SessionScope.of(context).api;
    try {
      final r = await api.get('/tenant/location') as Map<String, dynamic>;
      if (r['sharingEnabled'] != true || r['thisDeviceIsPrimary'] != true || r['resident'] != true) return;
      await LocationAgent.start(); // re-registers the background task after an update or reboot
      final state = await DeviceState.read();
      if (!state.granted || !state.servicesEnabled) { await LocationAgent.flush(api, state); return; }
      sub = Geolocator.getPositionStream(locationSettings: AndroidSettings(accuracy: LocationAccuracy.high, distanceFilter: LocationPolicy.foregroundDistanceMeters, intervalDuration: LocationPolicy.foregroundInterval)).listen((p) async {
        final prefs = LocationBuffer(await SharedPreferences.getInstance());
        await LocationAgent.queue(prefs, p);
        // Send at most every 20 s; points wait in the buffer in between.
        if (lastFlush == null || DateTime.now().difference(lastFlush!) > LocationPolicy.minGap) {
          lastFlush = DateTime.now();
          final reason = await LocationAgent.flush(api, await DeviceState.read(), buffer: prefs);
          if (reason != null) { await sub?.cancel(); sub = null; }
        }
      }, onError: (_) {});
    } on ApiException {
      // Offline at start: the background task and the next resume will try again.
    }
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
                StatusPill('${labels[i['status']]}', tone: tone('${i['status']}')),
              ])),
            ),
          ]);
        },
      ),
    );
  }
}
