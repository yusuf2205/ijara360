import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'app.dart';
import 'location/agent.dart';
import 'session.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('ru');
  // The web build exposes its semantics tree, so screen readers and browser tests can read the app.
  if (kIsWeb) SemanticsBinding.instance.ensureSemantics();
  await initLocationAgent();
  final session = Session();
  runApp(IjaraApp(session: session));
  await session.restore();
}
