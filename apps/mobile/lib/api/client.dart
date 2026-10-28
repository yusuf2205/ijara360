import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Server address. The web build is served by the server itself (same origin, session cookies);
/// the Android app talks to the public address with a bearer token kept in the device keystore.
String apiOrigin() => kIsWeb ? Uri.base.origin : const String.fromEnvironment('API_ORIGIN', defaultValue: 'https://mynas.tail4bf75c.ts.net:8443');

class ApiException implements Exception {
  ApiException(this.status, this.message, [this.body]);
  final int status;
  final String message;
  final Map<String, dynamic>? body;
  @override
  String toString() => message;
}

enum Audience { staff, tenant }

/// Thin JSON client. Errors carry the server's Russian message so screens can show it as is.
class ApiClient {
  ApiClient({http.Client? httpClient, FlutterSecureStorage? storage})
      : _http = httpClient ?? http.Client(),
        _storage = storage ?? const FlutterSecureStorage();
  final http.Client _http;
  final FlutterSecureStorage _storage;
  String? _token;
  Audience? audience;

  static const _tokenKey = 'ijara_token';
  static const _audienceKey = 'ijara_audience';
  static const _deviceKey = 'ijara_device_token';

  bool get native => !kIsWeb;
  String get platform => kIsWeb ? 'WEB' : 'ANDROID';

  Future<void> restore() async {
    if (!native) return;
    _token = await _storage.read(key: _tokenKey);
    final a = await _storage.read(key: _audienceKey);
    audience = a == null ? null : Audience.values.byName(a);
  }

  Future<void> remember(Audience a, String? token) async {
    audience = a;
    if (!native) return;
    _token = token;
    await _storage.write(key: _audienceKey, value: a.name);
    if (token != null) await _storage.write(key: _tokenKey, value: token);
  }

  Future<void> forget() async {
    _token = null;
    audience = null;
    if (native) {
      await _storage.delete(key: _tokenKey);
      await _storage.delete(key: _audienceKey);
    }
  }

  String? get token => _token;
  // The keystore can be unavailable (tests, a device without secure storage): never let that break a login.
  Future<String?> deviceToken() async { if (!native) return null; try { return await _storage.read(key: _deviceKey); } catch (_) { return null; } }
  Future<void> saveDeviceToken(String? t) async { if (native && t != null) { try { await _storage.write(key: _deviceKey, value: t); } catch (_) {} } }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'X-Ijara-Request': '1',
        if (native && _token != null) 'Authorization': 'Bearer $_token',
      };

  Uri _uri(String path, [Map<String, String>? query]) {
    final base = Uri.parse(apiOrigin());
    return base.replace(path: '/api$path', queryParameters: query == null || query.isEmpty ? null : query);
  }

  Future<dynamic> get(String path, [Map<String, String>? query]) => _send('GET', path, query: query);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body: body);
  Future<dynamic> put(String path, [Object? body]) => _send('PUT', path, body: body);
  Future<dynamic> patch(String path, [Object? body]) => _send('PATCH', path, body: body);
  Future<dynamic> delete(String path, [Object? body]) => _send('DELETE', path, body: body);

  /// Returns the decoded body; 202 bodies are returned too (pending login approvals).
  Future<dynamic> _send(String method, String path, {Object? body, Map<String, String>? query}) async {
    final request = http.Request(method, _uri(path, query))..headers.addAll(_headers);
    if (body != null) request.body = jsonEncode(body);
    http.Response response;
    try {
      response = await http.Response.fromStream(await _http.send(request).timeout(const Duration(seconds: 30)));
    } on TimeoutException {
      throw ApiException(0, 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.');
    } catch (_) {
      throw ApiException(0, 'Нет соединения с сервером. Проверьте интернет и попробуйте ещё раз.');
    }
    final text = utf8.decode(response.bodyBytes);
    final data = text.isEmpty ? null : _decode(text);
    if (response.statusCode >= 400) {
      final m = data is Map ? data['message'] : null;
      final message = m is List ? m.join(' · ') : (m is String ? m : 'Не удалось выполнить запрос.');
      throw ApiException(response.statusCode, message, data is Map<String, dynamic> ? data : null);
    }
    return data;
  }

  /// Raw bytes from an authenticated GET — passport and face images, which come back as JPEG, not JSON.
  /// The server audits each view (DOCUMENT_VIEWED / BIOMETRIC_SOURCE_VIEWED) exactly as for the web cabinet.
  Future<Uint8List> bytes(String path, [Map<String, String>? query]) async {
    final request = http.Request('GET', _uri(path, query))
      ..headers.addAll({'X-Ijara-Request': '1', if (native && _token != null) 'Authorization': 'Bearer $_token'});
    http.StreamedResponse res;
    try {
      res = await _http.send(request).timeout(const Duration(seconds: 30));
    } on TimeoutException {
      throw ApiException(0, 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.');
    } catch (_) {
      throw ApiException(0, 'Нет соединения с сервером. Проверьте интернет и попробуйте ещё раз.');
    }
    final body = await res.stream.toBytes();
    if (res.statusCode >= 400) {
      String? m;
      try { final d = jsonDecode(utf8.decode(body)); if (d is Map && d['message'] is String) m = d['message'] as String; } catch (_) {}
      throw ApiException(res.statusCode, m ?? 'Не удалось открыть изображение.');
    }
    return body;
  }

  dynamic _decode(String text) { try { return jsonDecode(text); } catch (_) { return null; } }

  /// Random UUID v4 for idempotent writes (payments): a retried request never records twice.
  static String uuid() {
    final r = Random.secure();
    final b = List<int>.generate(16, (_) => r.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    String h(int i) => b[i].toRadixString(16).padLeft(2, '0');
    final s = List.generate(16, h).join();
    return '${s.substring(0, 8)}-${s.substring(8, 12)}-${s.substring(12, 16)}-${s.substring(16, 20)}-${s.substring(20)}';
  }
}
