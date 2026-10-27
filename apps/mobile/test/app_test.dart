import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ijara360/api/client.dart';
import 'package:ijara360/app.dart';
import 'package:ijara360/screens/login.dart';
import 'package:ijara360/screens/tenant.dart';
import 'package:ijara360/session.dart';
import 'package:ijara360/theme.dart';
import 'package:ijara360/ui/kit.dart';
import 'package:ijara360/ui/shell.dart';
import 'package:intl/date_symbol_data_local.dart';

/// Fake server: answers by path with the shapes the real API returns.
MockClient fakeApi(Map<String, Object?> routes, {List<String>? calls}) => MockClient((req) async {
      calls?.add('${req.method} ${req.url.path}');
      final body = routes[req.url.path];
      if (body == null) return http.Response(jsonEncode({'message': 'Не найдено'}), 404);
      return http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});
    });

Widget host(Session s, Widget child, {Size size = const Size(390, 844)}) => MediaQuery(
      data: MediaQueryData(size: size),
      child: SessionScope(
        session: s,
        child: MaterialApp(theme: buildTheme(), locale: const Locale('ru'), supportedLocales: const [Locale('ru')], localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate], home: child),
      ),
    );

void main() {
  setUpAll(() => initializeDateFormatting('ru'));

  test('money and dates follow the Uzbek convention', () {
    expect(sum('1200000'), '1 200 000 сум');
    expect(sum(0), '0 сум');
    expect(day('2026-11-05T00:00:00.000Z'), '5 ноября');
  });

  testWidgets('login switches between resident and staff and explains empty input', (tester) async {
    final s = Session()..ready = true;
    await tester.pumpWidget(host(s, const LoginScreen()));
    expect(find.text('Хочу заселиться'), findsOneWidget);
    await tester.tap(find.text('Войти'));
    await tester.pump();
    expect(find.text('Введите телефон и пароль.'), findsOneWidget);
    await tester.tap(find.text('Я сотрудник'));
    await tester.pumpAndSettle();
    expect(find.text('Хочу заселиться'), findsNothing);
    // The Telegram login-confirmation hint was removed (owner's request).
    expect(find.textContaining('Telegram'), findsNothing);
  });

  testWidgets('a wrong password shows the server message and keeps the form', (tester) async {
    final api = ApiClient(httpClient: MockClient((req) async => http.Response.bytes(utf8.encode(jsonEncode({'message': 'Неверный телефон или пароль.'})), 401)));
    final s = Session(api: api)..ready = true;
    await tester.pumpWidget(host(s, const LoginScreen()));
    await tester.enterText(find.byType(TextField).at(0), '+998900000001');
    await tester.enterText(find.byType(TextField).at(1), 'wrong');
    await tester.tap(find.text('Войти'));
    await tester.pumpAndSettle();
    expect(find.text('Неверный телефон или пароль.'), findsOneWidget);
    expect(s.signedIn, isFalse);
  });

  for (final (width, rail, extended) in [(390.0, false, false), (800.0, true, false), (1280.0, true, true)]) {
    testWidgets('the shell adapts to a ${width.toInt()} px screen', (tester) async {
      tester.view.physicalSize = Size(width, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final s = sessionForTest(Role.tenant);
      await tester.pumpWidget(host(s, AppShell(destinations: [
        for (final l in ['Главная', 'Платежи', 'Обращения', 'Лента', 'Профиль']) Destination(l, Icons.circle_outlined, Icons.circle, (_) => Text('Экран $l')),
      ]), size: Size(width, 900)));
      expect(find.byType(NavigationRail), rail ? findsOneWidget : findsNothing);
      expect(find.byType(NavigationBar), rail ? findsNothing : findsOneWidget);
      if (rail) expect(tester.widget<NavigationRail>(find.byType(NavigationRail)).extended, extended);
      await tester.tap(find.text('Платежи').last);
      await tester.pumpAndSettle();
      expect(find.text('Экран Платежи'), findsOneWidget);
    });
  }

  testWidgets('tenant home shows the place, the next payment, debt and access', (tester) async {
    final api = ApiClient(httpClient: fakeApi({
      '/api/tenant/me': {'fullName': 'Каримов Азиз', 'phone': '+998901234567', 'property': {'name': 'Студенческий дом'}, 'occupancy': {'room': '3', 'bed': '2', 'moveInDate': '2026-08-12T00:00:00.000Z', 'monthlyPrice': '1200000', 'paymentDay': 5, 'depositAmount': '0'}},
      '/api/tenant/finance': {'access': {'granted': false, 'reason': 'OVERDUE'}, 'totalDebt': '1200000', 'creditBalance': '0', 'overdue': {'amount': '1200000', 'count': 1}, 'nextCharge': {'type': 'RENT', 'status': 'OVERDUE', 'dueAmount': '1200000', 'dueDate': '2026-10-05T00:00:00.000Z', 'billingPeriodStart': '2026-10-01T00:00:00.000Z'}, 'rent': null},
      '/api/tenant/notifications': {'items': [{'id': '1', 'kind': 'CHARGE_CREATED', 'title': 'Новое начисление', 'body': 'Аренда за октябрь', 'readAt': null, 'createdAt': '2026-10-01T05:00:00.000Z'}], 'unread': 1, 'total': 1},
    }));
    final s = sessionForTest(Role.tenant, name: 'Каримов Азиз');
    final session = Session(api: api)..role = s.role..fullName = s.fullName..ready = true;
    await tester.pumpWidget(host(session, const Scaffold(body: TenantHome())));
    await tester.pumpAndSettle();
    expect(find.text('Комната 3'), findsOneWidget);
    expect(find.textContaining('Место 3-2'), findsOneWidget);
    expect(find.textContaining('Долг 1 200 000 сум'), findsOneWidget);
    expect(find.text('Ограничен'), findsOneWidget);
    expect(find.text('Просрочено'), findsOneWidget);
    expect(find.text('Новое начисление'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('staff sections follow permissions: an accountant has finance but no tickets or applications', (tester) async {
    final api = ApiClient(httpClient: fakeApi({'/api/notifications': {'items': [], 'unread': 0, 'total': 0}, '/api/rooms': [], '/api/finance': {'summary': {'charged': '0', 'paid': '0', 'outstanding': '0', 'overdue': '0'}, 'residents': [], 'payments': []}}));
    final session = Session(api: api)..role = Role.admin..permissions = {'FINANCE_VIEW', 'FINANCE_MANAGE'}..fullName = 'Бухгалтер Тест'..ready = true;
    await tester.pumpWidget(host(session, const StaffApp(), size: const Size(1280, 900)));
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpAndSettle();
    final rail = tester.widget<NavigationRail>(find.byType(NavigationRail));
    final labels = rail.destinations.map((d) => ((d.label as ExcludeSemantics).child as Text).data).toList();
    expect(labels, containsAll(['Главная', 'Жильцы', 'Оплаты', 'Комнаты', 'Уведомления', 'Профиль']));
    expect(labels, isNot(contains('Обращения')));
    expect(labels, isNot(contains('Заявки')));
    expect(find.text('Принять оплату'), findsWidgets);
  });
}
