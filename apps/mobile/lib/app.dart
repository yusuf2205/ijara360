import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'session.dart';
import 'screens/common.dart';
import 'screens/login.dart';
import 'screens/staff.dart';
import 'screens/location.dart';
import 'screens/tenant.dart';
import 'theme.dart';
import 'ui/kit.dart';
import 'ui/shell.dart';
import 'update.dart';

class IjaraApp extends StatelessWidget {
  const IjaraApp({super.key, required this.session});
  final Session session;
  @override
  Widget build(BuildContext context) => SessionScope(
        session: session,
        child: MaterialApp(
          title: 'Ijara360',
          debugShowCheckedModeBanner: false,
          theme: buildTheme(),
          locale: const Locale('ru'),
          supportedLocales: const [Locale('ru')],
          localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
          // A new-version card floats over every screen (native only; inert on web and in tests).
          builder: (context, child) => Stack(children: [child ?? const SizedBox.shrink(), const UpdateBanner()]),
          home: const _Root(),
        ),
      );
}

class _Root extends StatefulWidget {
  const _Root();
  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  bool _greeted = false;
  @override
  void initState() {
    super.initState();
    // Keep the animated greeting on screen a short while even when the session restores instantly, so it is seen.
    Timer(const Duration(milliseconds: 2000), () { if (mounted) setState(() => _greeted = true); });
  }

  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    final showGreeting = !s.ready || !_greeted;
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 450),
      child: showGreeting
          ? const _Greeting(key: ValueKey('greeting'))
          : !s.signedIn
              ? const LoginScreen(key: ValueKey('login'))
              : s.role == Role.tenant
                  ? const TenantApp(key: ValueKey('tenant'))
                  : StaffApp(key: ValueKey('staff:${s.permissions.join(',')}')),
    );
  }
}

/// Animated welcome shown as the app opens: the logo rises and fades in, then "Добро пожаловать" and the tagline.
class _Greeting extends StatefulWidget {
  const _Greeting({super.key});
  @override
  State<_Greeting> createState() => _GreetingState();
}

class _GreetingState extends State<_Greeting> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500))..forward();

  @override
  void dispose() { _c.dispose(); super.dispose(); }

  // A fade+rise for one part, timed to a slice of the controller.
  Widget _part(double start, double end, Widget child, {double rise = 16}) {
    final t = CurvedAnimation(parent: _c, curve: Interval(start, end, curve: Curves.easeOutCubic));
    return AnimatedBuilder(
      animation: t,
      builder: (context, _) => Opacity(opacity: t.value, child: Transform.translate(offset: Offset(0, (1 - t.value) * rise), child: child)),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Brand.navy,
        body: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            _part(0.0, 0.55, ScaleTransition(
              scale: Tween(begin: 0.85, end: 1.0).animate(CurvedAnimation(parent: _c, curve: const Interval(0, 0.55, curve: Curves.easeOutBack))),
              child: Image.asset('assets/brand/logo-light.png', height: 58, semanticLabel: 'ijara360'),
            ), rise: 0),
            const Gap(22),
            _part(0.35, 0.8, Text('Добро пожаловать', style: manrope(22, FontWeight.w800, color: Brand.white))),
            const Gap(10),
            _part(0.6, 1.0, Text('ВАШ ДОМ. ВСЁ НА СВОИХ МЕСТАХ.', textAlign: TextAlign.center, style: manrope(11.5, FontWeight.w700, color: Brand.blueLight, spacing: 1.4))),
          ]),
        ),
      );
}

/// Keeps the unread count for the menu badge in step with the live channel.
mixin _Unread<T extends StatefulWidget> on State<T> {
  int unread = 0;
  StreamSubscription<String>? _sub;
  String get feedPath;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_sub != null) return;
    final s = SessionScope.of(context);
    _sub = s.realtime.topics.listen((t) { if (t == 'notifications' || t == 'resync') _load(); });
    _load();
  }
  Future<void> _load() async {
    try {
      final r = await SessionScope.of(context).api.get(feedPath) as Map<String, dynamic>;
      if (mounted) setState(() => unread = r['unread'] as int? ?? 0);
    } catch (_) {}
  }
  @override
  void dispose() { _sub?.cancel(); super.dispose(); }
}

class TenantApp extends StatefulWidget {
  const TenantApp({super.key});
  @override
  State<TenantApp> createState() => _TenantAppState();
}

class _TenantAppState extends State<TenantApp> with _Unread {
  @override
  String get feedPath => '/tenant/notifications';
  @override
  Widget build(BuildContext context) => ForegroundLocation(child: AppShell(destinations: [
        Destination('Главная', Icons.home_outlined, Icons.home_rounded, (_) => const LocationLock(child: TenantHome())),
        Destination('Платежи', Icons.account_balance_wallet_outlined, Icons.account_balance_wallet_rounded, (_) => const TenantPayments()),
        Destination('Обращения', Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded, (_) => const LocationLock(child: TenantTickets())),
        Destination('Лента', Icons.notifications_none_rounded, Icons.notifications_rounded, (_) => const LocationLock(child: NotificationsScreen()), badge: unread),
        Destination('Профиль', Icons.person_outline_rounded, Icons.person_rounded, (_) => const ProfileScreen()),
      ]));
}

class StaffApp extends StatefulWidget {
  const StaffApp({super.key});
  @override
  State<StaffApp> createState() => _StaffAppState();
}

class _StaffAppState extends State<StaffApp> with _Unread {
  @override
  String get feedPath => '/notifications';
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    // Sections follow the person's rights; the super-admin sees all of them.
    final sections = <(String, Destination)>[];
    sections.addAll([
      ('home', Destination('Главная', Icons.space_dashboard_outlined, Icons.space_dashboard_rounded, (c) => StaffHome(go: (k) { final i = sections.indexWhere((x) => x.$1 == k); if (i >= 0) AppShell.go(c, i); }))),
      // Phone bar as on the mockup: Главная, Комнаты, Жильцы, Оплаты; the rest under "Ещё".
      ('rooms', Destination('Комнаты', Icons.meeting_room_outlined, Icons.meeting_room_rounded, (_) => const RoomsScreen())),
      ('residents', Destination('Жильцы', Icons.people_outline_rounded, Icons.people_rounded, (_) => const ResidentsScreen())),
      if (s.can('FINANCE_VIEW')) ('finance', Destination('Оплаты', Icons.account_balance_wallet_outlined, Icons.account_balance_wallet_rounded, (_) => const FinanceScreen())),
      if (s.can('TICKETS_VIEW') || s.can('TICKETS_MANAGE')) ('tickets', Destination('Обращения', Icons.chat_bubble_outline_rounded, Icons.chat_bubble_rounded, (_) => const StaffTicketsScreen())),
      if (s.can('VIEW_LOCATION')) ('map', Destination('Карта', Icons.map_outlined, Icons.map_rounded, (_) => const StaffMapScreen())),
      if (s.can('APPLICATION_VIEW')) ('applications', Destination('Заявки', Icons.assignment_outlined, Icons.assignment_rounded, (_) => const ApplicationsScreen())),
      ('feed', Destination('Уведомления', Icons.notifications_none_rounded, Icons.notifications_rounded, (_) => NotificationsScreen(onOpen: (c, n) => _openLink(c, n)), badge: unread)),
      ('profile', Destination('Профиль', Icons.person_outline_rounded, Icons.person_rounded, (_) => ProfileScreen(extra: [const TelegramCard(), if (s.role == Role.superAdmin) const PropertyCard(), if (s.role == Role.superAdmin) const StaffListCard()]))),
    ]);
    return AppShell(destinations: [for (final x in sections) x.$2]);
  }

  /// Notification links point at cabinet paths; open the matching screen in the app.
  void _openLink(BuildContext context, Map<String, dynamic> n) {
    final link = '${n['link'] ?? ''}';
    final id = link.split('/').last;
    if (link.startsWith('/tickets/')) openPage(context, TicketScreen(id: id));
    if (link.startsWith('/applications/')) openPage(context, ApplicationScreen(id: id));
  }
}
