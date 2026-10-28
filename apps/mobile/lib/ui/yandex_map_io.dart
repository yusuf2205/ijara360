import 'dart:convert';

import 'package:flutter/material.dart';
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
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFEEF2F8))
      ..addJavaScriptChannel('FlutterMarker', onMessageReceived: _onMessage)
      // Surface load failures (e.g. a Cloudflare/QUIC hiccup) instead of showing a blank area.
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) { if (mounted) setState(() { _loading = true; _error = null; }); },
        onPageFinished: (_) { if (mounted) setState(() => _loading = false); },
        onWebResourceError: (e) { if ((e.isForMainFrame ?? true) && mounted) setState(() { _error = e.description; _loading = false; }); },
      ))
      ..loadRequest(Uri.parse(_url));
  }

  void _reload() { setState(() { _ready = false; _loading = true; _error = null; }); _c.loadRequest(Uri.parse(_url)); }

  void _onMessage(JavaScriptMessage m) {
    try {
      final d = jsonDecode(m.message) as Map<String, dynamic>;
      if (d['type'] == 'ready') { _ready = true; if (mounted) setState(() => _loading = false); _push(); }
      else if (d['type'] == 'marker') { widget.onTap('${d['id']}'); }
    } catch (_) {}
  }

  // setPoints expects a JSON string, so the list is encoded twice: once to JSON, once as a JS string literal.
  void _push() { if (_ready) _c.runJavaScript('window.setPoints(${jsonEncode(jsonEncode(widget.points))})'); }

  @override
  void didUpdateWidget(_YandexWebView old) { super.didUpdateWidget(old); _push(); }

  @override
  Widget build(BuildContext context) => Stack(children: [
        WebViewWidget(controller: _c),
        if (_error != null)
          Container(
            color: const Color(0xFFEEF2F8),
            alignment: Alignment.center,
            padding: const EdgeInsets.all(20),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.map_outlined, size: 40, color: Color(0xFF98A2B3)),
              const SizedBox(height: 10),
              const Text('Карта не загрузилась. Проверьте интернет и повторите.', textAlign: TextAlign.center),
              const SizedBox(height: 12),
              FilledButton(onPressed: _reload, child: const Text('Повторить')),
            ]),
          )
        else if (_loading)
          const Center(child: CircularProgressIndicator()),
      ]);
}
