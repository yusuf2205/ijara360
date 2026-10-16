import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:workmanager/workmanager.dart';

import '../api/client.dart';

/// M7 location sharing on the resident's phone (docs/M7-LOCATION.md).
/// Only after the resident turns it on and the OS grants permission. The server decides whose point it is
/// (the tenant session); the app never sends a resident id. No foreground-service notification (owner's
/// decision), so in the background Android runs [backgroundTask] about every 15 minutes at best.
class LocationPolicy {
  static const foregroundInterval = Duration(seconds: 30);
  static const foregroundDistanceMeters = 25;
  /// A still phone still reports now and then, so staff can tell "here, not moving" from "silent".
  /// Below the server's 3-minute live window, so an open app on a table stays "В сети".
  static const heartbeat = Duration(minutes: 2);
  /// While the app is open: device state every minute (GPS off, permission withdrawn show up at once).
  static const foregroundTick = Duration(minutes: 1);
  static const minGap = Duration(seconds: 20);
  /// Worse than this is not a position worth sending (the server rejects > 5 km anyway).
  static const maxAccuracyMeters = 1500.0;
  static const bufferLimit = 200;
  static const batchSize = 100;
  static const backgroundEvery = Duration(minutes: 15);
  static const taskName = 'ijara360-location';
}

class Fix {
  const Fix(this.latitude, this.longitude, this.accuracy, this.recordedAt);
  final double latitude, longitude, accuracy;
  final DateTime recordedAt;
}

double metersBetween(double lat1, double lon1, double lat2, double lon2) {
  const r = 6371000.0, rad = math.pi / 180;
  final dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  final h = math.pow(math.sin(dLat / 2), 2) + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.pow(math.sin(dLon / 2), 2);
  return 2 * r * math.asin(math.min(1, math.sqrt(h)));
}

/// Decides whether [next] is worth sending after [last]: real movement, a heartbeat, or a better fix.
/// Saves battery, traffic and database rows; never sends a fix with useless accuracy.
bool worthSending(Fix? last, Fix next) {
  if (next.accuracy > LocationPolicy.maxAccuracyMeters) return false;
  if (last == null) return true;
  final gap = next.recordedAt.difference(last.recordedAt);
  if (gap < LocationPolicy.minGap) return false;
  if (gap >= LocationPolicy.heartbeat) return true;
  final moved = metersBetween(last.latitude, last.longitude, next.latitude, next.longitude);
  // Movement must exceed the noise of both fixes, not just the distance filter.
  final noise = math.max(LocationPolicy.foregroundDistanceMeters.toDouble(), (last.accuracy + next.accuracy) / 2);
  if (moved >= noise) return true;
  // Same place but a much better fix (e.g. GPS after a network guess).
  return next.accuracy < last.accuracy / 2;
}

/// Small local queue for offline periods. Each point gets a device sequence number: the server ignores a
/// point it already has, so a retry after a lost response never duplicates history.
class LocationBuffer {
  LocationBuffer(this._prefs);
  final SharedPreferences _prefs;
  static const _key = 'ijara_location_buffer', _seqKey = 'ijara_location_seq', _lastKey = 'ijara_location_last';

  List<Map<String, dynamic>> get points => (jsonDecode(_prefs.getString(_key) ?? '[]') as List).cast<Map<String, dynamic>>();
  Fix? get last {
    final s = _prefs.getString(_lastKey);
    if (s == null) return null;
    final m = jsonDecode(s) as Map<String, dynamic>;
    return Fix((m['latitude'] as num).toDouble(), (m['longitude'] as num).toDouble(), (m['accuracyMeters'] as num).toDouble(), DateTime.parse(m['recordedAt'] as String));
  }

  Future<void> add(Fix f) async {
    final seq = (_prefs.getInt(_seqKey) ?? 0) + 1;
    final p = {'latitude': f.latitude, 'longitude': f.longitude, 'accuracyMeters': double.parse(f.accuracy.toStringAsFixed(1)), 'recordedAt': f.recordedAt.toUtc().toIso8601String(), 'sequence': seq};
    var list = [...points, p];
    // Oldest go first when the phone is offline for very long; the newest position matters most.
    if (list.length > LocationPolicy.bufferLimit) list = list.sublist(list.length - LocationPolicy.bufferLimit);
    await _prefs.setInt(_seqKey, seq);
    await _prefs.setString(_key, jsonEncode(list));
    await _prefs.setString(_lastKey, jsonEncode(p));
  }

  List<Map<String, dynamic>> nextBatch() => points.take(LocationPolicy.batchSize).toList();
  Future<void> drop(int count) async => _prefs.setString(_key, jsonEncode(points.skip(count).toList()));
  Future<void> clear() async { await _prefs.remove(_key); await _prefs.remove(_lastKey); }
}

/// The real OS state, sent with every upload so staff never see a fake "enabled".
class DeviceState {
  const DeviceState(this.permission, this.servicesEnabled);
  final LocationPermission permission;
  final bool servicesEnabled;
  bool get granted => permission == LocationPermission.always || permission == LocationPermission.whileInUse;
  bool get always => permission == LocationPermission.always;
  String get permissionCode => switch (permission) {
        LocationPermission.always => 'ALWAYS',
        LocationPermission.whileInUse => 'WHILE_IN_USE',
        LocationPermission.denied || LocationPermission.deniedForever => 'DENIED',
        _ => 'UNKNOWN',
      };
  Map<String, dynamic> toJson() => {'permission': permissionCode, 'servicesEnabled': servicesEnabled, 'background': always ? 'ALLOWED' : 'RESTRICTED'};

  static Future<DeviceState> read() async => DeviceState(await Geolocator.checkPermission(), await Geolocator.isLocationServiceEnabled());
}

/// Why sharing stopped on the server side; the app stops collecting and tells the resident.
enum StopReason { notResident, sharingOff, notPrimary, signedOut }

class LocationAgent {
  static const _stoppedKey = 'ijara_location_stopped';

  /// Takes one fix if allowed, queues it when worth it, then sends the queue with the device state.
  static Future<void> captureAndSend(ApiClient api, {bool force = false}) async {
    if (kIsWeb) return;
    final prefs = await SharedPreferences.getInstance();
    final buffer = LocationBuffer(prefs);
    final state = await DeviceState.read();
    if (state.granted && state.servicesEnabled) {
      try {
        final p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 25)));
        await queue(buffer, p, force: force);
      } catch (_) {
        // No fix right now (indoors, timeout): the state still goes, the server keeps the status honest.
      }
    }
    await flush(api, state, buffer: buffer);
  }

  static Future<void> queue(LocationBuffer buffer, Position p, {bool force = false}) async {
    final fix = Fix(p.latitude, p.longitude, p.accuracy, p.timestamp);
    if ((force && fix.accuracy <= LocationPolicy.maxAccuracyMeters) || worthSending(buffer.last, fix)) await buffer.add(fix);
  }

  /// Sends queued points (100 per request) with the device state. Keeps them on network errors.
  static Future<StopReason?> flush(ApiClient api, DeviceState state, {LocationBuffer? buffer}) async {
    buffer ??= LocationBuffer(await SharedPreferences.getInstance());
    var first = true;
    while (first || buffer.points.isNotEmpty) {
      first = false;
      final batch = buffer.nextBatch();
      try {
        await api.post('/tenant/location', {'points': batch, 'state': state.toJson()});
        await buffer.drop(batch.length);
      } on ApiException catch (e) {
        final reason = switch ((e.status, e.body?['code'])) {
          (401, _) => StopReason.signedOut,
          (409, 'NOT_RESIDENT') => StopReason.notResident,
          (409, 'SHARING_OFF') => StopReason.sharingOff,
          (409, 'NOT_PRIMARY') => StopReason.notPrimary,
          _ => null,
        };
        if (reason != null) { await stop(reason); return reason; }
        // 422 means a broken point: drop that batch rather than block the queue forever.
        if (e.status == 422) { await buffer.drop(batch.length); continue; }
        return null; // offline or server busy: keep the queue for the next attempt
      }
    }
    return null;
  }

  /// Periodic background capture (WorkManager). Android decides the real timing (15 min or later).
  static Future<void> start() async {
    if (kIsWeb) return;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_stoppedKey);
    await Workmanager().registerPeriodicTask(LocationPolicy.taskName, LocationPolicy.taskName,
        frequency: LocationPolicy.backgroundEvery, existingWorkPolicy: ExistingPeriodicWorkPolicy.update);
  }

  /// Stops all collection on this phone and forgets queued points (logout, checkout, sharing off).
  static Future<void> stop([StopReason? reason]) async {
    if (kIsWeb) return;
    // Where WorkManager is unavailable (tests, other platforms) there is nothing to cancel.
    try { await Workmanager().cancelByUniqueName(LocationPolicy.taskName); } catch (_) {}
    final prefs = await SharedPreferences.getInstance();
    await LocationBuffer(prefs).clear();
    if (reason != null) await prefs.setString(_stoppedKey, reason.name);
  }

  static Future<StopReason?> stoppedReason() async {
    final s = (await SharedPreferences.getInstance()).getString(_stoppedKey);
    return s == null ? null : StopReason.values.asNameMap()[s];
  }
}

/// WorkManager entry point: runs in its own isolate, with the bearer token from the keystore.
@pragma('vm:entry-point')
void backgroundTask() {
  Workmanager().executeTask((task, _) async {
    WidgetsFlutterBinding.ensureInitialized();
    DartPluginRegistrant.ensureInitialized();
    final api = ApiClient();
    await api.restore();
    if (api.audience != Audience.tenant || api.token == null) {
      await LocationAgent.stop(StopReason.signedOut);
      return true;
    }
    await LocationAgent.captureAndSend(api);
    return true;
  });
}

/// Called once in main(): registers the background entry point (Android only).
Future<void> initLocationAgent() async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
  await Workmanager().initialize(backgroundTask);
}
