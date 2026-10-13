import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ijara360/session.dart';
import 'package:ijara360/theme.dart';
import 'package:ijara360/ui/kit.dart';
import 'package:ijara360/ui/shell.dart';

void main() {
  for (final width in [390.0, 800.0, 1280.0]) {
    testWidgets('menu items are announced to screen readers at ${width.toInt()} px', (tester) async {
      final handle = tester.ensureSemantics();
      tester.view.physicalSize = Size(width, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(SessionScope(session: sessionForTest(Role.tenant), child: MaterialApp(theme: buildTheme(), home: AppShell(destinations: [
        for (final l in ['Главная', 'Платежи']) Destination(l, Icons.circle_outlined, Icons.circle, (_) => Text('Экран $l')),
      ]))));
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel(RegExp('^Платежи')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('^Главная')), findsOneWidget);
      handle.dispose();
    });
  }
}
