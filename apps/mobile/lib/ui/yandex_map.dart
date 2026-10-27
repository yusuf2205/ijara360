import 'package:flutter/widgets.dart';

import 'yandex_map_stub.dart'
    if (dart.library.io) 'yandex_map_io.dart'
    if (dart.library.js_interop) 'yandex_map_web.dart' as platform;

/// A Yandex map embedded through its JavaScript API: a WebView on mobile, an iframe on Flutter web. The page
/// (served at ijara360.uz/app/yandex.html, so the key's referer matches) renders the points it is given.
/// Each point is {id, lat, lon, status, label}; a tap on a marker calls [onTap] with the point's id.
class YandexLiveMap extends StatelessWidget {
  const YandexLiveMap({super.key, required this.points, required this.onTap});
  final List<Map<String, dynamic>> points;
  final void Function(String id) onTap;
  @override
  Widget build(BuildContext context) => platform.buildYandexMap(points, onTap);
}
