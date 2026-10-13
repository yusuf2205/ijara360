import 'package:web_socket_channel/web_socket_channel.dart';

/// Browser: same origin, so the session cookie and the Origin header are sent by the browser itself.
WebSocketChannel openSocket(Uri uri, String? token) => WebSocketChannel.connect(uri);
