import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

// Loaded from ijara360.uz (not the tailnet address) so the Referer matches the Yandex key's allowlist.
const _url = 'https://ijara360.uz/app/yandex.html';

Widget buildYandexMap(List<Map<String, dynamic>> points, void Function(String) onTap) => _YandexWebView(points: points, onTap: onTap);

class _YandexWebView extends StatefulWidget {
  const _YandexWebView({required this.points, required this.onTap});
  final List<Map<String, dynamic>> points;
  final void Function(String) onTap;
  @override
  State<_YandexWebView> createState() => _YandexWebViewState();
}

class _YandexWebViewState extends State<_YandexWebView> {
  late final WebViewController _c;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('FlutterMarker', onMessageReceived: _onMessage)
      ..loadRequest(Uri.parse(_url));
  }

  void _onMessage(JavaScriptMessage m) {
    try {
      final d = jsonDecode(m.message) as Map<String, dynamic>;
      if (d['type'] == 'ready') { _ready = true; _push(); }
      else if (d['type'] == 'marker') { widget.onTap('${d['id']}'); }
    } catch (_) {}
  }

  // setPoints expects a JSON string, so the list is encoded twice: once to JSON, once as a JS string literal.
  void _push() { if (_ready) _c.runJavaScript('window.setPoints(${jsonEncode(jsonEncode(widget.points))})'); }

  @override
  void didUpdateWidget(_YandexWebView old) { super.didUpdateWidget(old); _push(); }

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _c);
}
