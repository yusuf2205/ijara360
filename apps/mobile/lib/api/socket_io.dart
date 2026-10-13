import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Android: no Origin header and a bearer token, which the server accepts only from native apps.
WebSocketChannel openSocket(Uri uri, String? token) =>
    IOWebSocketChannel.connect(uri, headers: {if (token != null) 'Authorization': 'Bearer $token'}, pingInterval: const Duration(seconds: 25));
