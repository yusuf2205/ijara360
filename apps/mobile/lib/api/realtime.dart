import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'client.dart';
import 'socket_io.dart' if (dart.library.js_interop) 'socket_web.dart';

/// One live channel per signed-in person. Events only name what changed ({topic, type, id});
/// screens refetch what they may see. After a reconnect every screen refetches ('resync').
class Realtime {
  Realtime(this.api);
  final ApiClient api;
  final _events = StreamController<String>.broadcast();
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _retry;
  Duration _delay = const Duration(seconds: 1);
  bool _running = false;
  bool connected = false;

  /// Topic names: applications, tickets, finance, house, notifications, or 'resync'.
  Stream<String> get topics => _events.stream;

  void start() {
    if (_running) return;
    _running = true;
    _connect();
  }

  void _connect() {
    if (!_running) return;
    final origin = Uri.parse(apiOrigin());
    final path = api.audience == Audience.tenant ? '/api/tenant/events' : '/api/events';
    final uri = origin.replace(scheme: origin.scheme == 'https' ? 'wss' : 'ws', path: path);
    try {
      final channel = openSocket(uri, api.token);
      _channel = channel;
      _sub = channel.stream.listen((raw) {
        Map<String, dynamic>? e;
        try { e = jsonDecode(raw as String) as Map<String, dynamic>; } catch (_) { return; }
        if (e['type'] == 'ready') {
          final again = _delay > const Duration(seconds: 1);
          connected = true;
          _delay = const Duration(seconds: 1);
          if (again) _events.add('resync');
          return;
        }
        if (e['type'] == 'resync' || e['type'] == 'permissions.changed') { _events.add('resync'); return; }
        final topic = e['topic'];
        if (topic is String) _events.add(topic);
      }, onDone: _lost, onError: (_) => _lost(), cancelOnError: true);
    } catch (_) {
      _lost();
    }
  }

  void _lost() {
    connected = false;
    _sub?.cancel();
    _channel = null;
    if (!_running) return;
    _retry?.cancel();
    _retry = Timer(_delay, _connect);
    final next = _delay * 2;
    _delay = next > const Duration(seconds: 15) ? const Duration(seconds: 15) : next;
  }

  void stop() {
    _running = false;
    _retry?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _channel = null;
    connected = false;
  }
}
