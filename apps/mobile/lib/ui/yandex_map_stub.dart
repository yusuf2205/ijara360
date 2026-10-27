import 'package:flutter/widgets.dart';

// Used only where neither dart:io nor dart:js_interop is available (e.g. the VM under flutter test).
Widget buildYandexMap(List<Map<String, dynamic>> points, void Function(String) onTap) => const SizedBox.shrink();
