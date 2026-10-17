import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:geolocator/geolocator.dart';
import 'package:ijara360/api/client.dart';
import 'package:ijara360/location/agent.dart';
import 'package:ijara360/screens/location.dart';
import 'package:shared_preferences/shared_preferences.dart';

final t0 = DateTime.utc(2026, 10, 15, 10);
Fix fix(double lat, double lon, {double acc = 10, int sec = 0}) => Fix(lat, lon, acc, t0.add(Duration(seconds: sec)));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('worthSending: distance + time + accuracy', () {
    test('the first good fix is sent, a useless one never', () {
      expect(worthSending(null, fix(41.3, 69.2)), isTrue);
      expect(worthSending(null, fix(41.3, 69.2, acc: 1600)), isFalse);
    });
    test('standing still is not resent until the heartbeat', () {
      final a = fix(41.3, 69.2);
      expect(worthSending(a, fix(41.30005, 69.2, sec: 60)), isFalse, reason: '~5 m in a minute is noise');
      expect(worthSending(a, fix(41.30005, 69.2, sec: 100)), isFalse, reason: 'still within the heartbeat');
      expect(worthSending(a, fix(41.30005, 69.2, sec: 121)), isTrue, reason: 'heartbeat after 2 minutes, inside the 3-minute live window');
    });
    test('real movement is sent, but not more often than every 20 s', () {
      final a = fix(41.3, 69.2);
      expect(worthSending(a, fix(41.301, 69.2, sec: 10)), isFalse);
      expect(worthSending(a, fix(41.301, 69.2, sec: 30)), isTrue, reason: '~110 m');
    });
    test('movement must exceed the fixes\' own noise', () {
      final a = fix(41.3, 69.2, acc: 150);
      expect(worthSending(a, fix(41.3009, 69.2, acc: 150, sec: 60)), isFalse, reason: '100 m with ±150 m fixes');
    });
    test('a much better fix of the same place is sent', () {
      expect(worthSending(fix(41.3, 69.2, acc: 400), fix(41.3, 69.2, acc: 12, sec: 30)), isTrue);
    });
  });

  group('offline buffer', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));
    test('the same fix caught twice at once is stored once (device test finding)', () async {
      final b = LocationBuffer(await SharedPreferences.getInstance());
      final f = fix(41.3, 69.2, sec: 5);
      await Future.wait([b.add(f), b.add(f), LocationBuffer(await SharedPreferences.getInstance()).add(f)]);
      expect(b.points.length, 1);
      await b.add(fix(41.3, 69.2, sec: 4));
      expect(b.points.length, 1, reason: 'an older fix never follows a newer one');
      await b.add(fix(41.301, 69.2, sec: 40));
      expect(b.points.map((p) => p['sequence']), [1, 2]);
    });
    test('numbers points, keeps order, caps at 200 newest', () async {
      final b = LocationBuffer(await SharedPreferences.getInstance());
      for (var i = 0; i < 205; i++) { await b.add(fix(41.3 + i / 1000, 69.2, sec: i * 30)); }
      final p = b.points;
      expect(p.length, LocationPolicy.bufferLimit);
      expect(p.first['sequence'], 6);
      expect(p.last['sequence'], 205);
      expect(b.nextBatch().length, 100);
      expect(b.last!.latitude, closeTo(41.504, 1e-9));
    });
  });

  group('upload', () {
    late List<Map<String, dynamic>> sent;
    setUp(() { SharedPreferences.setMockInitialValues({}); sent = []; });
    ApiClient api(int status, [Map<String, dynamic>? body]) => ApiClient(httpClient: MockClient((req) async {
          sent.add(jsonDecode(req.body) as Map<String, dynamic>);
          return http.Response.bytes(utf8.encode(jsonEncode(body ?? {'accepted': 1})), status, headers: {'content-type': 'application/json'});
        }));
    const state = DeviceState(LocationPermission.always, true);

    test('sends the queue in batches of 100 with the real device state, then empties it', () async {
      final b = LocationBuffer(await SharedPreferences.getInstance());
      for (var i = 0; i < 150; i++) { await b.add(fix(41.3, 69.2, sec: i * 30)); }
      expect(await LocationAgent.flush(api(200), state, buffer: b), isNull);
      expect(sent.length, 2);
      expect((sent[0]['points'] as List).length, 100);
      expect((sent[1]['points'] as List).length, 50);
      expect(sent[0]['state'], {'permission': 'ALWAYS', 'servicesEnabled': true, 'background': 'ALLOWED'});
      expect(sent[0].containsKey('residentId'), isFalse, reason: 'the server decides whose point it is');
      expect(b.points, isEmpty);
    });
    test('no points still reports the phone state (location switched off)', () async {
      await LocationAgent.flush(api(200), const DeviceState(LocationPermission.deniedForever, true));
      expect(sent.single['points'], isEmpty);
      expect(sent.single['state']['permission'], 'DENIED');
    });
    test('offline keeps the queue for later', () async {
      final b = LocationBuffer(await SharedPreferences.getInstance());
      await b.add(fix(41.3, 69.2));
      final offline = ApiClient(httpClient: MockClient((_) async => throw Exception('no network')));
      expect(await LocationAgent.flush(offline, state, buffer: b), isNull);
      expect(b.points.length, 1);
    });
    test('checkout, sharing off, another phone or a revoked session stop collection and clear the queue', () async {
      for (final (status, code, reason) in [(409, 'NOT_RESIDENT', StopReason.notResident), (409, 'SHARING_OFF', StopReason.sharingOff), (409, 'NOT_PRIMARY', StopReason.notPrimary), (401, null, StopReason.signedOut)]) {
        SharedPreferences.setMockInitialValues({});
        final b = LocationBuffer(await SharedPreferences.getInstance());
        await b.add(fix(41.3, 69.2));
        expect(await LocationAgent.flush(api(status, {'message': 'x', 'code': ?code}), state, buffer: b), reason);
        expect(b.points, isEmpty);
        expect(await LocationAgent.stoppedReason(), reason);
      }
    });
  });

  test('device state codes match the API', () {
    expect(const DeviceState(LocationPermission.whileInUse, true).toJson(), {'permission': 'WHILE_IN_USE', 'servicesEnabled': true, 'background': 'RESTRICTED'});
    expect(const DeviceState(LocationPermission.denied, false).toJson()['permission'], 'DENIED');
  });

  test('Yandex links carry only the point: Navigator first, then Maps, then the browser', () {
    final links = yandexLinks(41.311081, 69.240562);
    expect(links.map((u) => u.scheme), ['yandexnavi', 'yandexmaps', 'https']);
    expect(links[0].queryParameters['lat'], '41.311081');
    expect(links[0].queryParameters['lon'], '69.240562');
    expect(links[1].queryParameters['pt'], '69.240562,41.311081');
    expect(links[2].host, 'yandex.ru');
    for (final u in links) {
      expect(u.queryParameters.keys, isNot(contains('desc')));
    }
  });

  group('location is required for the resident app (owner, 2026-10-17)', () {
    LocationGate g(LocationPermission p, {bool gps = true, bool resident = true, bool sharing = true, bool thisPhone = true, bool otherPhone = false}) =>
        gateFor(resident: resident, sharing: sharing, thisPhone: thisPhone, otherPhone: otherPhone, device: DeviceState(p, gps));
    test('open only with "always" and GPS on', () {
      expect(g(LocationPermission.always), LocationGate.open);
      expect(g(LocationPermission.always, gps: false), LocationGate.gps);
      expect(g(LocationPermission.whileInUse), LocationGate.always);
      expect(g(LocationPermission.denied), LocationGate.permission);
      expect(g(LocationPermission.deniedForever), LocationGate.settings);
    });
    test('no consent yet: the lock asks for it', () {
      expect(g(LocationPermission.denied, sharing: false, thisPhone: false), LocationGate.permission);
      expect(g(LocationPermission.always, sharing: false, thisPhone: false), LocationGate.consent);
    });
    test('never locks a checked-out person or a second phone', () {
      expect(g(LocationPermission.denied, resident: false), LocationGate.open);
      expect(g(LocationPermission.denied, thisPhone: false, otherPhone: true), LocationGate.open);
    });
    test('every lock has a button and an explanation', () {
      for (final x in LocationGate.values.where((x) => x != LocationGate.open)) {
        final (button, text) = LocationLock.texts(x);
        expect(button, isNotEmpty);
        expect(text, isNotEmpty);
      }
    });
  });
}
