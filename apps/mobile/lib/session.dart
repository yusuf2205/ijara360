import 'package:flutter/foundation.dart';

import 'api/client.dart';
import 'api/realtime.dart';
import 'location/agent.dart';

/// Who is signed in. Roles come from the server: OWNER/SUPER_ADMIN (super-admin), ADMIN with granted
/// permissions, or a tenant. The UI only hides what the server would refuse anyway.
enum Role { superAdmin, admin, tenant }

class Approval {
  Approval(this.id, this.pollToken, this.expiresAt, {this.byOwner = false});
  final String id;
  /// Another staff member's login: the owner confirms it, not the person logging in.
  final bool byOwner;
  final String pollToken;
  final DateTime expiresAt;
}

class Session extends ChangeNotifier {
  Session({ApiClient? api}) : api = api ?? ApiClient() { realtime = Realtime(this.api); }
  final ApiClient api;
  late final Realtime realtime;

  bool ready = false;
  Role? role;
  String fullName = '';
  String phone = '';
  String propertyName = '';
  Set<String> permissions = {};

  bool get signedIn => role != null;
  bool get isStaff => role == Role.superAdmin || role == Role.admin;
  bool can(String permission) => role == Role.superAdmin || permissions.contains(permission);
  String get firstName => fullName.split(' ').first;
  String get roleLabel => switch (role) { Role.superAdmin => 'Супер-админ', Role.admin => 'Администратор', Role.tenant => 'Жилец', null => '' };

  /// On start: native apps use the stored token; the web build asks both endpoints with its cookies.
  Future<void> restore() async {
    await api.restore();
    try {
      if (api.native) {
        if (api.audience == Audience.staff) await _loadStaff();
        if (api.audience == Audience.tenant) await _loadTenant();
      } else {
        try { api.audience = Audience.staff; await _loadStaff(); }
        on ApiException catch (e) { if (e.status != 401) rethrow; api.audience = Audience.tenant; await _loadTenant(); }
      }
    } on ApiException catch (e) {
      if (e.status == 401) { await api.forget(); role = null; }
    } finally {
      ready = true;
      if (signedIn) realtime.start();
      notifyListeners();
    }
  }

  Future<void> _loadStaff() async {
    final me = await api.get('/auth/me') as Map<String, dynamic>;
    final rights = await api.get('/permissions/me') as Map<String, dynamic>;
    String property = '';
    try { property = ((await api.get('/property')) as Map<String, dynamic>)['name'] as String? ?? ''; } catch (_) {}
    fullName = me['fullName'] as String? ?? '';
    phone = me['phone'] as String? ?? '';
    propertyName = property;
    permissions = {...(rights['permissions'] as List).cast<String>()};
    role = (me['role'] == 'OWNER' || me['role'] == 'SUPER_ADMIN') ? Role.superAdmin : Role.admin;
  }

  Future<void> _loadTenant() async {
    final me = await api.get('/tenant/me') as Map<String, dynamic>;
    fullName = me['fullName'] as String? ?? '';
    phone = me['phone'] as String? ?? '';
    propertyName = (me['property'] as Map?)?['name'] as String? ?? '';
    permissions = {};
    role = Role.tenant;
  }

  /// Staff login. Returns an [Approval] when the server wants a Telegram confirmation first.
  Future<Approval?> loginStaff(String phoneInput, String password, {required bool remember, String deviceName = 'Приложение Android'}) async {
    final r = await api.post('/auth/login', {
      'phone': phoneInput,
      'password': password,
      'remember': remember,
      'platform': api.platform,
      if (api.native) 'deviceName': deviceName,
      'deviceToken': ?await api.deviceToken(),
    }) as Map<String, dynamic>;
    if (r['approval'] is Map) {
      final a = r['approval'] as Map;
      return Approval(a['id'] as String, a['pollToken'] as String, DateTime.parse(a['expiresAt'] as String), byOwner: a['confirmBy'] == 'owner');
    }
    await _signedInStaff(r);
    return null;
  }

  /// Polls once: true when the session exists, false while still waiting. Throws when denied or expired.
  Future<bool> pollApproval(Approval a) async {
    final r = await api.post('/auth/login/approval', {'id': a.id, 'pollToken': a.pollToken, 'deviceToken': ?await api.deviceToken()}) as Map<String, dynamic>?;
    if (r == null || r['status'] == 'PENDING') return false;
    await _signedInStaff(r);
    return true;
  }

  Future<void> _signedInStaff(Map<String, dynamic> r) async {
    await api.saveDeviceToken(r['deviceToken'] as String?);
    await api.remember(Audience.staff, r['token'] as String?);
    await _loadStaff();
    realtime.start();
    notifyListeners();
  }

  Future<void> loginTenant(String phoneInput, String password, {required bool remember, String deviceName = 'Приложение Android'}) async {
    final r = await api.post('/tenant/auth/login', {'phone': phoneInput, 'password': password, 'remember': remember, 'platform': api.platform, if (api.native) 'deviceName': deviceName}) as Map<String, dynamic>;
    await api.remember(Audience.tenant, r['token'] as String?);
    await _loadTenant();
    realtime.start();
    notifyListeners();
  }

  Future<void> logout() async {
    // Location collection belongs to this session: it ends with it (M7).
    if (api.audience == Audience.tenant) await LocationAgent.stop(StopReason.signedOut);
    try { await api.post(api.audience == Audience.tenant ? '/tenant/auth/logout' : '/auth/logout'); } catch (_) {}
    realtime.stop();
    await api.forget();
    role = null;
    fullName = phone = propertyName = '';
    permissions = {};
    notifyListeners();
  }

  /// A 401 anywhere means the session ended on the server (revoked, password changed, access closed).
  Future<void> expired() async {
    if (!signedIn) return;
    realtime.stop();
    await api.forget();
    role = null;
    notifyListeners();
  }

  @override
  void dispose() { realtime.stop(); super.dispose(); }
}

/// Small helper so tests can build a session without touching storage.
@visibleForTesting
Session sessionForTest(Role role, {Set<String> permissions = const {}, String name = 'Тест Тестов'}) =>
    Session()..role = role..permissions = {...permissions}..fullName = name..ready = true;
