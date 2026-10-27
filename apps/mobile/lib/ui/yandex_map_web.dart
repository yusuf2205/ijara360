import 'dart:convert';
import 'dart:js_interop';
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

// Same page as mobile; the Flutter web app is served from ijara360.uz/app, so this is same-origin there.
const _url = 'https://ijara360.uz/app/yandex.html';

Widget buildYandexMap(List<Map<String, dynamic>> points, void Function(String) onTap) => _YandexIFrame(points: points, onTap: onTap);

class _YandexIFrame extends StatefulWidget {
  const _YandexIFrame({required this.points, required this.onTap});
  final List<Map<String, dynamic>> points;
  final void Function(String) onTap;
  @override
  State<_YandexIFrame> createState() => _YandexIFrameState();
}

class _YandexIFrameState extends State<_YandexIFrame> {
  late final String _viewType;
  web.HTMLIFrameElement? _iframe;
  bool _ready = false;
  late final JSFunction _listener;

  @override
  void initState() {
    super.initState();
    _viewType = 'yandex-map-${identityHashCode(this)}';
    ui_web.platformViewRegistry.registerViewFactory(_viewType, (int _) {
      final f = web.HTMLIFrameElement()
        ..src = _url
        ..style.border = 'none'
        ..style.width = '100%'
        ..style.height = '100%';
      _iframe = f;
      return f;
    });
    _listener = ((web.Event e) {
      try {
        final data = (e as web.MessageEvent).data;
        if (!data.isA<JSString>()) return;
        final d = jsonDecode((data as JSString).toDart) as Map<String, dynamic>;
        if (d['type'] == 'ready') { _ready = true; _push(); }
        else if (d['type'] == 'marker') { widget.onTap('${d['id']}'); }
      } catch (_) {}
    }).toJS;
    web.window.addEventListener('message', _listener);
  }

  void _push() {
    if (!_ready || _iframe == null) return;
    final msg = jsonEncode({'type': 'points', 'points': widget.points});
    _iframe!.contentWindow?.postMessage(msg.toJS, '*'.toJS);
  }

  @override
  void didUpdateWidget(_YandexIFrame old) { super.didUpdateWidget(old); _push(); }

  @override
  void dispose() { web.window.removeEventListener('message', _listener); super.dispose(); }

  @override
  Widget build(BuildContext context) => HtmlElementView(viewType: _viewType);
}
