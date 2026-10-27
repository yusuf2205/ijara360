import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;
import 'package:url_launcher/url_launcher.dart';

import '../api/client.dart';
import '../session.dart';
import '../theme.dart';
import '../ui/kit.dart';
import 'common.dart';
import 'tenant.dart' show methodLabel;

// ---------- Shared action helpers (edit/delete rooms, residents, staff; review applications) ----------
Future<bool> _confirmAction(BuildContext context, {required String title, required String message, String confirm = 'Удалить', bool danger = true}) async {
  final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Отмена')),
          FilledButton(style: danger ? FilledButton.styleFrom(backgroundColor: Brand.red) : null, onPressed: () => Navigator.pop(d, true), child: Text(confirm)),
        ],
      ));
  return ok == true;
}

Future<String?> _promptText(BuildContext context, {required String title, required String label, String ok = 'Готово', int maxLines = 3}) async {
  final c = TextEditingController();
  final r = await showDialog<String>(context: context, builder: (d) => AlertDialog(
        title: Text(title),
        content: TextField(controller: c, autofocus: true, minLines: 1, maxLines: maxLines, decoration: InputDecoration(labelText: label)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(d, c.text.trim()), child: Text(ok)),
        ],
      ));
  c.dispose();
  return r;
}

String _todayIso() { final n = DateTime.now(); return '${n.year.toString().padLeft(4, '0')}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}'; }

// ---------- Home ----------
class StaffHome extends StatelessWidget {
  const StaffHome({super.key, required this.go});
  final void Function(String section) go;
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return LiveData<Map<String, dynamic>>(
      topics: const {'house', 'finance', 'applications', 'tickets', 'notifications'},
      load: () async {
        // Each block only for staff who may see it; the server would refuse the rest anyway.
        final rooms = s.api.get('/rooms');
        final feed = s.api.get('/notifications');
        final fin = s.can('FINANCE_VIEW') ? s.api.get('/finance') : Future.value(null);
        final apps = s.can('APPLICATION_VIEW') ? s.api.get('/applications', {'status': 'SUBMITTED'}) : Future.value(null);
        final tickets = s.can('TICKETS_VIEW') || s.can('TICKETS_MANAGE') ? s.api.get('/tickets', {'status': 'OPEN'}) : Future.value(null);
        final month = s.can('FINANCE_VIEW') ? s.api.get('/finance/month').catchError((_) => null) : Future.value(null);
        final today = s.api.get('/occupancies/today').catchError((_) => null);
        final r = await Future.wait([rooms, feed, fin, apps, tickets, month, today]);
        return {'rooms': r[0], 'feed': r[1], 'finance': r[2], 'apps': r[3], 'tickets': r[4], 'month': r[5], 'today': r[6]};
      },
      builder: (context, d, refresh) {
        final rooms = (d['rooms'] as List).cast<Map<String, dynamic>>();
        final beds = rooms.fold<int>(0, (n, r) => n + (r['totalBeds'] as int));
        final busy = rooms.fold<int>(0, (n, r) => n + (r['occupiedBeds'] as int));
        final fin = d['finance'] as Map<String, dynamic>?;
        final debtors = fin == null ? null : (fin['residents'] as List).where((r) => (num.tryParse('${r['totalDebt']}') ?? 0) > 0).length;
        final newApps = (d['apps'] as Map?)?['counts']?['SUBMITTED'] as int?;
        final newTickets = (d['tickets'] as Map?)?['counts']?['OPEN'] as int?;
        final unread = (d['feed'] as Map)['unread'] as int? ?? 0;
        final month = d['month'] as Map<String, dynamic>?;
        final today = d['today'] as Map<String, dynamic>?;
        int count(String k) => ((month?[k] as Map?)?['residents'] as int?) ?? 0;
        final t = Theme.of(context).textTheme;
        final wide = MediaQuery.sizeOf(context).width >= 900;
        final ring = AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Заполняемость', style: t.titleMedium),
          const Gap(14),
          Row(children: [
            OccupancyRing(busy: busy, total: beds),
            const SizedBox(width: 18),
            Expanded(child: Column(children: [
              _Legend(color: Brand.blue, label: 'Занято', value: busy),
              _Legend(color: Brand.gray100, label: 'Свободно', value: beds - busy, border: true),
            ])),
          ]),
        ]));
        final money = fin == null ? null : AppCard(onTap: () => go('finance'), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // All-time totals; next to "Получено за месяц" a bare "Оплачено" read as this month's figure.
          Text('Финансы за всё время', style: t.titleMedium),
          const Gap(10),
          _MoneyRow(Icons.receipt_long_outlined, Tone.blue, sum(fin['summary']['charged']), 'Начислено'),
          _MoneyRow(Icons.check_circle_outline_rounded, Tone.green, sum(fin['summary']['paid']), 'Оплачено'),
          _MoneyRow(Icons.error_outline_rounded, Tone.red, sum(fin['summary']['outstanding']), 'Долг${debtors != null && debtors > 0 ? ' · $debtors жильцов' : ''}'),
        ]));
        return PageBody(onRefresh: refresh, children: [
          // Mockup "Главная (Dashboard)": greeting, today's date, then tinted tiles.
          Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Здравствуйте,', style: manrope(13, FontWeight.w600, color: Brand.gray500)),
              Semantics(header: true, child: Text(s.firstName, style: t.headlineMedium)),
              Text('Сегодня, ${longDate(DateTime.now())}', style: t.bodySmall),
            ])),
            BellButton(unread: unread, onTap: () => go('feed')),
          ]),
          const Gap(18),
          TileGrid(minTile: 150, max: 5, spacing: 10, children: [
            ColorTile(icon: Icons.meeting_room_outlined, value: '${rooms.length}', label: 'Комнаты', onTap: () => go('rooms')),
            ColorTile(icon: Icons.bed_outlined, tone: Tone.green, value: '$beds', label: 'Мест всего', onTap: () => go('rooms')),
            ColorTile(icon: Icons.people_outline_rounded, tone: Tone.red, value: '$busy', label: 'Занято', onTap: () => go('residents')),
            ColorTile(icon: Icons.check_circle_outline_rounded, tone: Tone.green, value: '${beds - busy}', label: 'Свободно', onTap: () => go('rooms')),
            if (month != null) ...[
              ColorTile(icon: Icons.verified_outlined, tone: Tone.green, value: '${count('paid')}', label: 'Оплатили', onTap: () => go('finance')),
              ColorTile(icon: Icons.error_outline_rounded, tone: Tone.red, value: '${count('unpaid') + count('partial')}', label: 'Не оплатили', onTap: () => go('finance')),
            ],
            if (fin != null) ColorTile(icon: Icons.account_balance_wallet_outlined, tone: Tone.orange, value: sum(fin['summary']['outstanding']), label: 'Общий долг', onTap: () => go('finance')),
            if (debtors != null) ColorTile(icon: Icons.person_off_outlined, tone: Tone.orange, value: '$debtors', label: 'Должники', onTap: () => go('finance')),
            if (newApps != null) ColorTile(icon: Icons.assignment_outlined, value: '$newApps', label: 'Новые заявки', onTap: () => go('applications')),
            if (newTickets != null) ColorTile(icon: Icons.chat_bubble_outline_rounded, value: '$newTickets', label: 'Новые обращения', onTap: () => go('tickets')),
          ]),
          if (month != null) ...[const Gap(10), ColorTile(icon: Icons.payments_outlined, tone: Tone.green, value: sum(month['received']), label: 'Получено за месяц', onTap: () => go('finance'))],
          if (today != null) ...[
            const SectionTitle('Сегодня'),
            TileGrid(minTile: 150, max: 2, spacing: 10, children: [
              ColorTile(icon: Icons.person_add_alt_outlined, value: '${today['movedIn']}', label: 'Заселились', onTap: () => go('residents')),
              ColorTile(icon: Icons.person_remove_outlined, tone: Tone.red, value: '${today['movedOut']}', label: 'Выселились', onTap: () => go('residents')),
            ]),
          ],
          const Gap(14),
          if (s.can('FINANCE_MANAGE')) ...[
            FilledButton.icon(onPressed: () => acceptPayment(context), icon: const Icon(Icons.add_card_rounded), label: const Text('Принять оплату')),
            const Gap(14),
          ],
          if (wide && money != null) IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Expanded(child: ring), const SizedBox(width: 14), Expanded(child: money)]))
          else ...[ring, if (money != null) ...[const Gap(14), money]],
          SectionTitle('План дома', action: 'Все комнаты', onAction: () => go('rooms')),
          HousePlan(rooms: rooms),
        ]);
      },
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({required this.color, required this.label, required this.value, this.border = false});
  final Color color;
  final String label;
  final int value;
  final bool border;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          Container(width: 12, height: 12, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4), border: border ? Border.all(color: Brand.gray300) : null)),
          const SizedBox(width: 8),
          Expanded(child: Text(label, style: manrope(14, FontWeight.w600))),
          Text('$value', style: manrope(15, FontWeight.w800)),
        ]),
      );
}

class _MoneyRow extends StatelessWidget {
  const _MoneyRow(this.icon, this.tone, this.value, this.label);
  final IconData icon;
  final Tone tone;
  final String value;
  final String label;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          IconChip(icon, tone: tone, size: 36),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(value, style: manrope(17, FontWeight.w800)), Text(label, style: Theme.of(context).textTheme.bodySmall)])),
        ]),
      );
}

class OccupancyRing extends StatelessWidget {
  const OccupancyRing({super.key, required this.busy, required this.total, this.size = 112});
  final int busy;
  final int total;
  final double size;
  @override
  Widget build(BuildContext context) {
    final pct = total == 0 ? 0 : (busy / total * 100).round();
    return Semantics(
      label: 'Занято $pct процентов, $busy из $total мест',
      child: SizedBox(width: size, height: size, child: CustomPaint(
        painter: _RingPainter(total == 0 ? 0 : busy / total),
        child: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Text('$pct%', style: manrope(24, FontWeight.w800)), Text('$busy из $total', style: manrope(11, FontWeight.w600, color: Brand.gray500))])),
      )),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.value);
  final double value;
  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 13.0;
    final rect = Offset.zero & size;
    final arc = rect.deflate(stroke / 2);
    canvas.drawArc(arc, 0, math.pi * 2, false, Paint()..color = Brand.gray100..style = PaintingStyle.stroke..strokeWidth = stroke);
    if (value > 0) canvas.drawArc(arc, -math.pi / 2, math.pi * 2 * value, false, Paint()..color = Brand.blue..style = PaintingStyle.stroke..strokeWidth = stroke..strokeCap = StrokeCap.round);
  }
  @override
  bool shouldRepaint(_RingPainter old) => old.value != value;
}

/// Rooms coloured by fill: red full, orange almost, green free.
class HousePlan extends StatelessWidget {
  const HousePlan({super.key, required this.rooms});
  final List<Map<String, dynamic>> rooms;
  @override
  Widget build(BuildContext context) {
    if (rooms.isEmpty) return const EmptyState(icon: Icons.meeting_room_outlined, title: 'Комнат пока нет', text: 'Добавьте комнаты в кабинете на компьютере.');
    return TileGrid(minTile: 108, max: 8, spacing: 10, children: [
      for (final r in rooms)
        Builder(builder: (context) {
          final total = r['totalBeds'] as int, free = r['availableBeds'] as int;
          final tone = total == 0 ? Tone.gray : free == 0 ? Tone.red : free <= (total / 4).ceil() ? Tone.orange : Tone.green;
          final (bg, fg) = toneColors(tone);
          return Material(
            color: bg,
            borderRadius: BorderRadius.circular(16),
            child: InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: () => openPage(context, RoomScreen(id: '${r['id']}')),
              child: Semantics(
                button: true,
                label: 'Комната ${r['number']}: занято ${r['occupiedBeds']} из $total',
                child: ExcludeSemantics(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Комната ${r['number']}', style: manrope(12.5, FontWeight.w700, color: fg)),
                  const Gap(4),
                  Text('${r['occupiedBeds']}/$total', style: manrope(22, FontWeight.w800, color: fg)),
                  Text(free == 0 ? 'Мест нет' : 'Свободно $free', style: manrope(11, FontWeight.w600, color: fg)),
                ]))),
              ),
            ),
          );
        }),
    ]);
  }
}

// ---------- Rooms ----------
class RoomsScreen extends StatelessWidget {
  const RoomsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Комнаты')),
      body: LiveData<List<dynamic>>(
        topics: const {'house'},
        load: () async => (await s.api.get('/rooms')) as List<dynamic>,
        builder: (context, data, refresh) {
          // Mockup "Комнаты": a row per room with its monthly income.
          final rooms = data.cast<Map<String, dynamic>>();
          return PageBody(onRefresh: refresh, children: [
            for (final r in rooms) _RoomRow(room: r),
          ]);
        },
      ),
    );
  }
}

num _roomIncome(Map<String, dynamic> r) => (r['beds'] as List?)?.fold<num>(0, (sum, b) {
      final occ = (b as Map)['occupancy'] as Map?;
      return sum + (occ != null ? (num.tryParse('${occ['monthlyPrice']}') ?? 0) : 0);
    }) ?? 0;

class _RoomRow extends StatelessWidget {
  const _RoomRow({required this.room});
  final Map<String, dynamic> room;
  @override
  Widget build(BuildContext context) {
    final total = room['totalBeds'] as int? ?? 0, busy = room['occupiedBeds'] as int? ?? 0, free = room['availableBeds'] as int? ?? 0;
    final tone = room['archivedAt'] != null || total == 0 ? Tone.gray : free == 0 ? Tone.red : Tone.blue;
    final (bg, fg) = toneColors(tone);
    final income = _roomIncome(room);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        onTap: () => openPage(context, RoomScreen(id: '${room['id']}')),
        padding: const EdgeInsets.all(14),
        child: Row(children: [
          Container(width: 44, height: 44, alignment: Alignment.center, decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)), child: Icon(Icons.meeting_room_outlined, color: fg, size: 22)),
          const SizedBox(width: 14),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Комната ${room['number']}', style: manrope(15, FontWeight.w800)),
            Text('$busy / $total занято${free > 0 ? ' · Свободно: $free' : total == 0 ? ' · Места не добавлены' : ''}', style: manrope(12, FontWeight.w500, color: Brand.gray500)),
          ])),
          const SizedBox(width: 10),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(income > 0 ? sum(income) : '—', style: manrope(14, FontWeight.w800)),
            Text('Доход в месяц', style: manrope(10.5, FontWeight.w500, color: Brand.gray500)),
          ]),
        ]),
      ),
    );
  }
}

class RoomScreen extends StatelessWidget {
  const RoomScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return LiveData<Map<String, dynamic>>(
      topics: const {'house'},
      load: () async => (await s.api.get('/rooms/$id')) as Map<String, dynamic>,
      builder: (context, r, refresh) {
        final beds = (r['beds'] as List).cast<Map<String, dynamic>>();
        final total = r['totalBeds'] as int? ?? 0, busy = r['occupiedBeds'] as int? ?? 0, free = r['availableBeds'] as int? ?? 0;
        final income = _roomIncome(r);
        final debt = beds.fold<num>(0, (sum, b) {
          final occ = b['occupancy'] as Map?;
          return sum + (occ != null ? (num.tryParse('${(occ['resident'] as Map?)?['totalDebt'] ?? 0}') ?? 0) : 0);
        });
        return Scaffold(
          appBar: AppBar(title: Text('Комната ${r['number']}'), actions: [
            if (s.can('ROOMS_MANAGE'))
              PopupMenuButton<String>(
                onSelected: (v) => _roomAction(context, s.api, r, v, refresh),
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'edit', child: Text('Изменить комнату')),
                  PopupMenuItem(value: 'archive', child: Text(r['archivedAt'] == null ? 'Убрать в архив' : 'Вернуть из архива')),
                  const PopupMenuItem(value: 'delete', child: Text('Удалить', style: TextStyle(color: Brand.red))),
                ],
              ),
          ]),
          body: PageBody(onRefresh: refresh, children: [
            // Mockup "Детали комнаты": counts, income and debt, then a place per row.
            Row(children: [
              Expanded(child: _MiniStat(Icons.bed_outlined, Tone.blue, '$total', 'Всего мест')),
              const SizedBox(width: 10),
              Expanded(child: _MiniStat(Icons.people_outline_rounded, Tone.red, '$busy', 'Занято')),
              const SizedBox(width: 10),
              Expanded(child: _MiniStat(Icons.check_circle_outline_rounded, Tone.green, '$free', 'Свободно')),
            ]),
            const Gap(12),
            Row(children: [
              Expanded(child: AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Доход в месяц', style: manrope(11.5, FontWeight.w500, color: Brand.gray500)), const Gap(4), Text(income > 0 ? sum(income) : '—', style: manrope(18, FontWeight.w800))]))),
              const SizedBox(width: 12),
              Expanded(child: AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('Общий долг', style: manrope(11.5, FontWeight.w500, color: Brand.gray500)), const Gap(4), Text(debt > 0 ? sum(debt) : '0 сум', style: manrope(18, FontWeight.w800, color: debt > 0 ? Brand.red : Brand.ink))]))),
            ]),
            const Gap(6),
            const SectionTitle('Места'),
            for (final b in beds) _PlaceRow(room: '${r['number']}', bed: b),
          ]),
        );
      },
    );
  }
}

Future<void> _roomAction(BuildContext context, ApiClient api, Map<String, dynamic> r, String action, Future<void> Function() refresh) async {
  final id = '${r['id']}';
  final version = r['version'];
  try {
    switch (action) {
      case 'edit':
        final res = await _editRoomDialog(context, r);
        if (res == null) return;
        await api.patch('/rooms/$id', {'number': res.$1, 'capacity': res.$2, 'version': version});
        await refresh();
        if (context.mounted) toast(context, 'Комната изменена');
      case 'archive':
        final toArchive = r['archivedAt'] == null;
        if (toArchive && !await _confirmAction(context, title: 'Убрать в архив?', message: 'Комнату можно вернуть позже. В архиве её не видно в списке. Нумерация активных комнат обновится.', confirm: 'В архив', danger: false)) return;
        await api.patch('/rooms/$id/archive', {'version': version, 'archived': toArchive});
        if (context.mounted) { toast(context, toArchive ? 'Комната в архиве' : 'Комната возвращена'); Navigator.pop(context); }
      case 'delete':
        if (!await _confirmAction(context, title: 'Удалить комнату?', message: 'Удалить можно только комнату без истории. Если были проживания или начисления — уберите её в архив.')) return;
        await api.delete('/rooms/$id', {'version': version});
        if (context.mounted) { toast(context, 'Комната удалена'); Navigator.pop(context); }
    }
  } on ApiException catch (e) {
    if (context.mounted) toast(context, e.message);
  }
}

/// Number + capacity (capacity is the maximum number of places; the server rejects a value below the beds
/// that already exist). Returns (number, capacity) or null on cancel.
Future<(String, int)?> _editRoomDialog(BuildContext context, Map<String, dynamic> r) async {
  final number = TextEditingController(text: '${r['number']}');
  final capacity = TextEditingController(text: '${r['capacity'] ?? r['totalBeds'] ?? ''}');
  final res = await showDialog<(String, int)>(context: context, builder: (d) => AlertDialog(
        title: const Text('Изменить комнату'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: number, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Номер комнаты')),
          const Gap(10),
          TextField(controller: capacity, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Вместимость, мест')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('Отмена')),
          FilledButton(onPressed: () {
            final n = number.text.trim();
            final c = int.tryParse(capacity.text.trim());
            if (n.isEmpty || c == null || c < 1) return;
            Navigator.pop(d, (n, c));
          }, child: const Text('Сохранить')),
        ],
      ));
  number.dispose();
  capacity.dispose();
  return res;
}

class _MiniStat extends StatelessWidget {
  const _MiniStat(this.icon, this.tone, this.value, this.label);
  final IconData icon; final Tone tone; final String value; final String label;
  @override
  Widget build(BuildContext context) {
    final (bg, fg) = toneColors(tone);
    return AppCard(padding: const EdgeInsets.all(13), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Container(width: 34, height: 34, alignment: Alignment.center, decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)), child: Icon(icon, color: fg, size: 18)),
      const Gap(10),
      Text(value, style: manrope(20, FontWeight.w800)),
      Text(label, style: manrope(11, FontWeight.w500, color: Brand.gray500)),
    ]));
  }
}

class _PlaceRow extends StatelessWidget {
  const _PlaceRow({required this.room, required this.bed});
  final String room; final Map<String, dynamic> bed;
  @override
  Widget build(BuildContext context) {
    final occ = bed['occupancy'] as Map<String, dynamic>?;
    final resident = occ?['resident'] as Map?;
    final debt = num.tryParse('${resident?['totalDebt'] ?? 0}') ?? 0;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: AppCard(
        onTap: occ == null ? null : () => openPage(context, ResidentScreen(id: '${occ['residentId']}')),
        padding: const EdgeInsets.all(12),
        child: Row(children: [
          Avatar(occ == null ? '' : '${resident?['fullName'] ?? ''}', size: 40),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Место $room-${bed['number']}', style: manrope(14, FontWeight.w700)),
            Text(occ == null ? 'Свободно' : '${resident?['fullName'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: manrope(12, FontWeight.w500, color: Brand.gray500)),
          ])),
          const SizedBox(width: 8),
          if (occ != null) StatusPill(debt > 0 ? 'Долг ${sum(debt)}' : 'Оплачено', tone: debt > 0 ? Tone.red : Tone.green)
          else StatusPill('Свободно', tone: Tone.gray),
        ]),
      ),
    );
  }
}

// ---------- Residents ----------
class ResidentsScreen extends StatefulWidget {
  const ResidentsScreen({super.key});
  @override
  State<ResidentsScreen> createState() => _ResidentsScreenState();
}

class _ResidentsScreenState extends State<ResidentsScreen> {
  String query = '';
  String filter = 'active';
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Жильцы')),
      body: LiveData<List<dynamic>>(
        topics: const {'house', 'finance'},
        load: () async => (await s.api.get('/residents')) as List<dynamic>,
        builder: (context, all, refresh) {
          final list = all.cast<Map<String, dynamic>>().where((r) {
            final living = (r['occupancies'] as List).any((o) => o['status'] == 'ACTIVE');
            final debt = (num.tryParse('${r['totalDebt']}') ?? 0) > 0;
            final okFilter = filter == 'all' || (filter == 'active' && living) || (filter == 'debt' && debt);
            final q = query.toLowerCase();
            return okFilter && (q.isEmpty || '${r['fullName']}'.toLowerCase().contains(q) || '${r['phone']}'.contains(q));
          }).toList();
          return PageBody(maxWidth: 900, onRefresh: refresh, children: [
            TextField(onChanged: (v) => setState(() => query = v), decoration: const InputDecoration(hintText: 'Имя или телефон', prefixIcon: Icon(Icons.search_rounded))),
            const Gap(12),
            Wrap(spacing: 8, children: [
              for (final f in const [('active', 'Проживают'), ('debt', 'Должники'), ('all', 'Все')])
                ChoiceChip(label: Text(f.$2), selected: filter == f.$1, showCheckmark: false, onSelected: (_) => setState(() => filter = f.$1)),
            ]),
            const Gap(12),
            if (list.isEmpty) const EmptyState(icon: Icons.person_search_outlined, title: 'Никого не нашли'),
            for (final r in list) Padding(padding: const EdgeInsets.only(bottom: 10), child: _ResidentTile(r)),
          ]);
        },
      ),
    );
  }
}

class _ResidentTile extends StatelessWidget {
  const _ResidentTile(this.r);
  final Map<String, dynamic> r;
  @override
  Widget build(BuildContext context) {
    final occ = (r['occupancies'] as List).cast<Map<String, dynamic>>().where((o) => o['status'] == 'ACTIVE').firstOrNull;
    final debt = num.tryParse('${r['totalDebt']}') ?? 0;
    return AppCard(
      onTap: () => openPage(context, ResidentScreen(id: '${r['id']}')),
      semanticLabel: '${r['fullName']}${occ != null ? ', комната ${occ['room']['number']}' : ''}${debt > 0 ? ', долг ${sum(debt)}' : ''}',
      child: ExcludeSemantics(child: Row(children: [
        Avatar('${r['fullName']}'),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${r['fullName']}', style: manrope(15, FontWeight.w800)),
          Text(occ == null ? 'Не проживает' : 'Комната ${occ['room']['number']} · место ${occ['room']['number']}-${occ['bed']['number']}', style: Theme.of(context).textTheme.bodySmall),
        ])),
        debt > 0 ? StatusPill(sum(debt), tone: Tone.red) : const StatusPill('Оплачено', tone: Tone.green),
      ])),
    );
  }
}

class ResidentScreen extends StatelessWidget {
  const ResidentScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return LiveData<Map<String, dynamic>>(
      topics: const {'house', 'finance'},
      load: () async => (await s.api.get('/residents/$id')) as Map<String, dynamic>,
      builder: (context, r, refresh) {
          final stays = (r['occupancies'] as List).cast<Map<String, dynamic>>();
          final occ = stays.where((o) => o['status'] == 'ACTIVE').firstOrNull;
          final debt = num.tryParse('${r['totalDebt']}') ?? 0;
          return Scaffold(
            appBar: AppBar(title: const Text('Жилец'), actions: [
              if (s.can('RESIDENTS_MANAGE'))
                PopupMenuButton<String>(
                  onSelected: (v) => _residentAction(context, s.api, r, occ, v, refresh),
                  itemBuilder: (_) => [
                    if (occ != null) const PopupMenuItem(value: 'checkout', child: Text('Выселить')),
                    const PopupMenuItem(value: 'delete', child: Text('Удалить', style: TextStyle(color: Brand.red))),
                  ],
                ),
            ]),
            body: PageBody(maxWidth: 820, onRefresh: refresh, children: [
            AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Avatar('${r['fullName']}', size: 60),
                const SizedBox(width: 14),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${r['fullName']}', style: Theme.of(context).textTheme.titleLarge),
                  Text('${r['phone']}', style: Theme.of(context).textTheme.bodySmall),
                  const Gap(6),
                  StatusPill(occ == null ? 'Не проживает' : 'Комната ${occ['room']['number']}, место ${occ['room']['number']}-${occ['bed']['number']}', tone: occ == null ? Tone.gray : Tone.blue),
                ])),
              ]),
              const Gap(14),
              Row(children: [
                Expanded(child: OutlinedButton.icon(onPressed: () => launchUrl(Uri.parse('tel:${r['phone']}')), icon: const Icon(Icons.call_outlined), label: const Text('Позвонить'))),
                if (s.can('FINANCE_MANAGE') && occ != null) ...[
                  const SizedBox(width: 10),
                  Expanded(child: FilledButton.icon(onPressed: () => acceptPayment(context, resident: r), icon: const Icon(Icons.add_card_rounded), label: const Text('Оплата'))),
                ],
              ]),
            ])),
            const Gap(12),
            TileGrid(minTile: 150, max: 3, children: [
              Kpi(icon: Icons.error_outline_rounded, tone: debt > 0 ? Tone.red : Tone.green, value: sum(debt), label: 'Долг'),
              Kpi(icon: Icons.savings_outlined, value: sum(r['creditBalance']), label: 'Аванс'),
              Kpi(icon: r['accessGranted'] == true ? Icons.verified_user_outlined : Icons.gpp_bad_outlined, tone: r['accessGranted'] == true ? Tone.green : Tone.red, value: r['accessGranted'] == true ? 'Разрешён' : 'Ограничен', label: 'Допуск'),
            ]),
            if (occ != null) ...[
              const SectionTitle('Проживание'),
              AppCard(child: Column(children: [
                KeyValue('Заселён', day(occ['moveInDate'])),
                KeyValue('Цена в месяц', sum(occ['monthlyPrice'])),
                KeyValue('День оплаты', '${occ['paymentDay']}-е число'),
                KeyValue('Залог', sum(occ['depositAmount'])),
              ])),
            ],
            if (stays.where((o) => o['status'] != 'ACTIVE').isNotEmpty) ...[
              const SectionTitle('История'),
              for (final o in stays.where((o) => o['status'] != 'ACTIVE')) Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: AppCard(child: KeyValue('Комната ${o['room']['number']}, место ${o['bed']['number']}', '${day(o['moveInDate'])} — ${day(o['moveOutDate'])}')),
              ),
            ],
          ]),
          );
        },
    );
  }
}

Future<void> _residentAction(BuildContext context, ApiClient api, Map<String, dynamic> r, Map<String, dynamic>? occ, String action, Future<void> Function() refresh) async {
  try {
    switch (action) {
      case 'checkout':
        if (occ == null) return;
        if (!await _confirmAction(context, title: 'Выселить жильца?', message: 'Проживание закроется сегодняшней датой. История и платежи сохранятся.', confirm: 'Выселить', danger: false)) return;
        await api.post('/occupancies/${occ['id']}/check-out', {'moveOutDate': _todayIso()});
        await refresh();
        if (context.mounted) toast(context, 'Жилец выселен');
      case 'delete':
        if (!await _confirmAction(context, title: 'Удалить жильца?', message: 'Удалить можно только жильца без истории проживания и платежей. Если история есть — его можно выселить.')) return;
        await api.delete('/residents/${r['id']}');
        if (context.mounted) { toast(context, 'Жилец удалён'); Navigator.pop(context); }
    }
  } on ApiException catch (e) {
    if (context.mounted) toast(context, e.message);
  }
}

// ---------- Finance ----------
class FinanceScreen extends StatefulWidget {
  const FinanceScreen({super.key});
  @override
  State<FinanceScreen> createState() => _FinanceScreenState();
}

class _FinanceScreenState extends State<FinanceScreen> {
  // The "Принять оплату" button collapses to just its icon while the list is being scrolled, and opens back
  // up to the full label when scrolling stops (owner's request).
  bool _extended = true;

  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Оплаты')),
      floatingActionButton: s.can('FINANCE_MANAGE') ? FloatingActionButton.extended(isExtended: _extended, backgroundColor: Brand.blue, foregroundColor: Brand.white, onPressed: () => acceptPayment(context), icon: const Icon(Icons.add_card_rounded), label: const Text('Принять оплату')) : null,
      body: NotificationListener<UserScrollNotification>(
        onNotification: (n) {
          final wantExtended = n.direction == ScrollDirection.idle;
          if (wantExtended != _extended) setState(() => _extended = wantExtended);
          return false;
        },
        child: LiveData<Map<String, dynamic>>(
        topics: const {'finance'},
        load: () async => (await s.api.get('/finance')) as Map<String, dynamic>,
        builder: (context, f, refresh) {
          final sm = f['summary'] as Map<String, dynamic>;
          final debtors = (f['residents'] as List).cast<Map<String, dynamic>>().where((r) => (num.tryParse('${r['totalDebt']}') ?? 0) > 0).toList()
            ..sort((a, b) => (num.tryParse('${b['totalDebt']}') ?? 0).compareTo(num.tryParse('${a['totalDebt']}') ?? 0));
          final payments = (f['payments'] as List).cast<Map<String, dynamic>>();
          return PageBody(onRefresh: refresh, children: [
            TileGrid(minTile: 160, max: 4, children: [
              Kpi(icon: Icons.receipt_long_outlined, value: sum(sm['charged']), label: 'Начислено'),
              Kpi(icon: Icons.check_circle_outline_rounded, tone: Tone.green, value: sum(sm['paid']), label: 'Оплачено'),
              Kpi(icon: Icons.error_outline_rounded, tone: Tone.red, value: sum(sm['outstanding']), label: 'Долг'),
              Kpi(icon: Icons.schedule_rounded, tone: Tone.orange, value: sum(sm['overdue']), label: 'Просрочено'),
            ]),
            SectionTitle('Должники · ${debtors.length}'),
            if (debtors.isEmpty) const EmptyState(icon: Icons.celebration_outlined, title: 'Должников нет'),
            for (final r in debtors) Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AppCard(
                onTap: () => openPage(context, ResidentScreen(id: '${r['id']}')),
                child: Row(children: [
                  Avatar('${r['fullName']}', size: 40),
                  const SizedBox(width: 12),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${r['fullName']}', style: manrope(15, FontWeight.w800)),
                    Text(r['accessGranted'] == true ? 'Допуск пока разрешён' : 'Допуск ограничен', style: Theme.of(context).textTheme.bodySmall),
                  ])),
                  Text(sum(r['totalDebt']), style: manrope(15, FontWeight.w800, color: Brand.red)),
                ]),
              ),
            ),
            const SectionTitle('Последние оплаты'),
            if (payments.isEmpty) const EmptyState(icon: Icons.payments_outlined, title: 'Оплат пока нет'),
            for (final p in payments.take(15)) Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AppCard(child: Row(children: [
                const IconChip(Icons.check_rounded, tone: Tone.green),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${(p['resident'] as Map?)?['fullName'] ?? ''}', style: manrope(15, FontWeight.w700)),
                  Text('${dayTime(p['createdAt'])} · ${methodLabel[p['method']] ?? ''}', style: Theme.of(context).textTheme.bodySmall),
                ])),
                Text(sum(p['amount']), style: manrope(15, FontWeight.w800)),
              ])),
            ),
            const Gap(70),
          ]);
        },
      ),
      ),
    );
  }
}

/// Records a cash or transfer payment. The idempotency key is created once per form, so a retry
/// after a lost response never records the payment twice.
Future<void> acceptPayment(BuildContext context, {Map<String, dynamic>? resident}) => showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      // Above the tab bar, not under it: the tab's own navigator left the bar on top of the form.
      useRootNavigator: true,
      builder: (_) => SessionScope(session: SessionScope.of(context), child: _PaymentSheet(resident: resident)),
    );

class _PaymentSheet extends StatefulWidget {
  const _PaymentSheet({this.resident});
  final Map<String, dynamic>? resident;
  @override
  State<_PaymentSheet> createState() => _PaymentSheetState();
}

class _PaymentSheetState extends State<_PaymentSheet> {
  final key = ApiClient.uuid();
  final amount = TextEditingController();
  final comment = TextEditingController();
  String method = 'CASH';
  Map<String, dynamic>? resident;
  List<Map<String, dynamic>> residents = [];
  bool busy = false;
  String? error;

  @override
  void initState() {
    super.initState();
    resident = widget.resident;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (resident != null) return;
      try {
        final all = (await SessionScope.of(context).api.get('/residents') as List).cast<Map<String, dynamic>>();
        if (mounted) setState(() => residents = all.where((r) => (r['occupancies'] as List).any((o) => o['status'] == 'ACTIVE')).toList());
      } on ApiException catch (e) { if (mounted) setState(() => error = e.message); }
    });
  }

  @override
  void dispose() { amount.dispose(); comment.dispose(); super.dispose(); }

  Future<void> save() async {
    final value = amount.text.replaceAll(RegExp(r'[^0-9]'), '');
    if (resident == null || value.isEmpty) { setState(() => error = 'Выберите жильца и укажите сумму.'); return; }
    setState(() { busy = true; error = null; });
    try {
      await SessionScope.of(context).api.post('/finance/payments', {'residentId': resident!['id'], 'amount': value, 'method': method, if (comment.text.trim().isNotEmpty) 'comment': comment.text.trim(), 'idempotencyKey': key});
      if (!mounted) return;
      Navigator.pop(context);
      toast(context, 'Оплата ${sum(value)} зачтена');
    } on ApiException catch (e) {
      setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.viewInsetsOf(context).bottom + 20),
        child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          Text('Принять оплату', style: Theme.of(context).textTheme.headlineSmall),
          const Gap(16),
          if (widget.resident != null)
            AppCard(color: Brand.gray100, child: Row(children: [Avatar('${resident!['fullName']}', size: 36), const SizedBox(width: 10), Text('${resident!['fullName']}', style: manrope(15, FontWeight.w700))]))
          else
            DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: resident?['id'] as String?,
              decoration: const InputDecoration(labelText: 'Жилец'),
              items: [for (final r in residents) DropdownMenuItem(value: '${r['id']}', child: Text('${r['fullName']}', overflow: TextOverflow.ellipsis))],
              onChanged: (v) => setState(() => resident = residents.firstWhere((r) => r['id'] == v)),
            ),
          const Gap(12),
          TextField(controller: amount, keyboardType: TextInputType.number, style: manrope(22, FontWeight.w800), decoration: const InputDecoration(labelText: 'Сумма', suffixText: 'сум')),
          const Gap(12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final m in methodLabel.entries) ChoiceChip(label: Text(m.value), selected: method == m.key, showCheckmark: false, onSelected: (_) => setState(() => method = m.key)),
          ]),
          const Gap(12),
          TextField(controller: comment, maxLength: 2000, decoration: const InputDecoration(labelText: 'Комментарий для сотрудников (необязательно)')),
          const Text('Сумма сначала гасит старые долги, остаток уходит в аванс. Жилец получит уведомление.', style: TextStyle(fontSize: 12, color: Brand.gray500)),
          if (error != null) ...[const Gap(10), Text(error!, style: manrope(14, FontWeight.w600, color: Brand.red))],
          const Gap(16),
          FilledButton(onPressed: busy ? null : save, child: busy ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5)) : const Text('Зачесть оплату')),
        ])),
      );
}

// ---------- Applications ----------
const applicationStatus = {'SUBMITTED': 'Новые', 'UNDER_REVIEW': 'На рассмотрении', 'NEEDS_INFO': 'Нужны данные', 'APPROVED': 'Одобрены', 'REJECTED': 'Отклонены'};

class ApplicationsScreen extends StatefulWidget {
  const ApplicationsScreen({super.key});
  @override
  State<ApplicationsScreen> createState() => _ApplicationsScreenState();
}

class _ApplicationsScreenState extends State<ApplicationsScreen> {
  String status = 'SUBMITTED';
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Заявки')),
      body: LiveData<Map<String, dynamic>>(
        key: ValueKey(status),
        topics: const {'applications'},
        load: () async => (await s.api.get('/applications', {'status': status})) as Map<String, dynamic>,
        builder: (context, d, refresh) {
          final items = (d['items'] as List).cast<Map<String, dynamic>>();
          final counts = (d['counts'] as Map?) ?? {};
          return PageBody(maxWidth: 900, onRefresh: refresh, children: [
            SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(children: [
              for (final e in applicationStatus.entries) Padding(padding: const EdgeInsets.only(right: 8), child: ChoiceChip(label: Text('${e.value} · ${counts[e.key] ?? 0}'), selected: status == e.key, showCheckmark: false, onSelected: (_) => setState(() => status = e.key))),
            ])),
            const Gap(12),
            if (items.isEmpty) EmptyState(icon: Icons.assignment_outlined, title: 'Заявок нет', text: status == 'SUBMITTED' ? 'Новые анкеты появятся здесь сразу после отправки.' : null),
            for (final a in items) Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: AppCard(
                onTap: () => openPage(context, ApplicationScreen(id: '${a['id']}')),
                child: Row(children: [
                  Avatar('${a['fullName'] ?? '?'}'),
                  const SizedBox(width: 12),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${a['fullName'] ?? 'Без имени'}', style: manrope(15, FontWeight.w800)),
                    Text('${a['occupationType'] == 'STUDENT' ? 'Студент' : 'Работает'}${a['organization'] != null ? ' · ${a['organization']}' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall),
                    Text('Заселение с ${day(a['requestedMoveInDate'])}', style: Theme.of(context).textTheme.bodySmall),
                  ])),
                  const Icon(Icons.chevron_right_rounded),
                ]),
              ),
            ),
          ]);
        },
      ),
    );
  }
}

class ApplicationScreen extends StatelessWidget {
  const ApplicationScreen({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Заявка')),
      body: LiveData<Map<String, dynamic>>(
        topics: const {'applications'},
        load: () async => (await s.api.get('/applications/$id')) as Map<String, dynamic>,
        builder: (context, a, refresh) {
          // The questionnaire answers come nested under "profile" (the list endpoint has them flat).
          final p = (a['profile'] as Map<String, dynamic>?) ?? a;
          String? text(String k) => '${p[k] ?? ''}'.trim().isEmpty ? null : '${p[k]}'.trim();
          return PageBody(maxWidth: 760, onRefresh: refresh, children: [
          AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${a['fullName'] ?? 'Без имени'}', style: Theme.of(context).textTheme.titleLarge),
            Text('${a['phone'] ?? ''}${a['phoneVerified'] == true ? ' · подтверждён в Telegram' : ''}', style: Theme.of(context).textTheme.bodySmall),
            const Gap(8),
            StatusPill(applicationStatus[a['status']] ?? '${a['status']}', tone: Tone.blue),
            const Gap(10),
            KeyValue('Занятость', p['occupationType'] == 'STUDENT' ? 'Студент' : 'Работает'),
            if (text('organization') != null) KeyValue(p['occupationType'] == 'STUDENT' ? 'Учёба' : 'Работа', text('organization')!),
            if (text('faculty') != null) KeyValue('Факультет', text('faculty')!),
            if (text('course') != null) KeyValue('Курс', text('course')!),
            if (text('position') != null) KeyValue('Должность', text('position')!),
            KeyValue('Заселение', day(p['requestedMoveInDate'])),
            if (text('plannedDuration') != null) KeyValue('Срок', text('plannedDuration')!),
            if (text('dateOfBirth') != null) KeyValue('Дата рождения', day(p['dateOfBirth'])),
            if (text('passportSeries') != null || text('passportNumber') != null) KeyValue('Паспорт', '${p['passportSeries'] ?? ''} ${p['passportNumber'] ?? ''}'.trim()),
            if (text('pinfl') != null) KeyValue('ПИНФЛ', text('pinfl')!),
            if (text('emergencyName') != null || text('emergencyPhone') != null)
              KeyValue('Экстренный контакт', [text('emergencyName'), if (text('emergencyRelationship') != null) '(${text('emergencyRelationship')})', text('emergencyPhone')].where((x) => x != null).join(' ')),
            if (text('comment') != null) KeyValue('Комментарий', text('comment')!),
          ])),
          const Gap(14),
          _DocumentsCard(applicationId: id, documents: (a['documents'] as List?)?.cast<Map<String, dynamic>>() ?? const [], version: a['version']),
          const Gap(14),
          _DecisionCard(id: id, application: a, refresh: refresh),
        ]);
        },
      ),
    );
  }
}

/// The decision on an application, inside the app (same as the cabinet). SUBMITTED → «Взять в работу»;
/// once UNDER_REVIEW → Одобрить (with the three manual-review confirmations the server requires),
/// Запросить данные or Отклонить. Each button appears only if the viewer has that right.
class _DecisionCard extends StatefulWidget {
  const _DecisionCard({required this.id, required this.application, required this.refresh});
  final String id;
  final Map<String, dynamic> application;
  final Future<void> Function() refresh;
  @override
  State<_DecisionCard> createState() => _DecisionCardState();
}

class _DecisionCardState extends State<_DecisionCard> {
  bool busy = false;

  Future<void> _run(Future<void> Function() fn) async {
    setState(() => busy = true);
    try { await fn(); await widget.refresh(); } on ApiException catch (e) { if (mounted) toast(context, e.message); } finally { if (mounted) setState(() => busy = false); }
  }

  Future<void> _review(Map<String, dynamic> body) => _run(() => SessionScope.of(context).api.post('/applications/${widget.id}/review', {...body, 'version': widget.application['version']}));

  Future<void> _approve() async {
    final extra = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => const _ApproveDialog());
    if (extra == null) return;
    await _review({'status': 'APPROVED', ...extra});
  }

  Future<void> _reject() async {
    final reason = await _promptText(context, title: 'Отклонить заявку', label: 'Причина для заявителя', ok: 'Отклонить');
    if (reason == null || reason.isEmpty) return;
    await _review({'status': 'REJECTED', 'reason': reason});
  }

  Future<void> _needsInfo() async {
    final reason = await _promptText(context, title: 'Запросить данные', label: 'Комментарий для заявителя', ok: 'Далее');
    if (reason == null || reason.isEmpty) return;
    if (!mounted) return;
    final fields = await _promptText(context, title: 'Что нужно дополнить', label: 'Какие данные или фото', ok: 'Отправить');
    if (fields == null || fields.isEmpty) return;
    await _review({'status': 'NEEDS_INFO', 'reason': reason, 'requiredFields': fields});
  }

  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    final status = '${widget.application['status']}';
    final buttons = <Widget>[];
    if (status == 'SUBMITTED' && s.can('APPLICATION_REVIEW')) {
      buttons.add(FilledButton.icon(onPressed: busy ? null : () => _review({'status': 'UNDER_REVIEW'}), icon: const Icon(Icons.play_arrow_rounded), label: const Text('Взять в работу')));
    }
    if (status == 'UNDER_REVIEW') {
      if (s.can('APPLICATION_APPROVE')) buttons.add(FilledButton.icon(style: FilledButton.styleFrom(backgroundColor: Brand.green), onPressed: busy ? null : _approve, icon: const Icon(Icons.check_rounded), label: const Text('Одобрить')));
      if (s.can('APPLICATION_REVIEW')) buttons.add(OutlinedButton.icon(onPressed: busy ? null : _needsInfo, icon: const Icon(Icons.help_outline_rounded), label: const Text('Запросить данные')));
      if (s.can('APPLICATION_REJECT')) buttons.add(OutlinedButton.icon(style: OutlinedButton.styleFrom(foregroundColor: Brand.red), onPressed: busy ? null : _reject, icon: const Icon(Icons.close_rounded), label: const Text('Отклонить')));
    }
    if (buttons.isEmpty) return const SizedBox.shrink();
    return AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Решение по заявке', style: manrope(15, FontWeight.w800)),
      const Gap(4),
      Text(status == 'SUBMITTED' ? 'Возьмите заявку в работу, затем одобрите или отклоните.' : 'Проверьте анкету и документы выше, затем примите решение.', style: Theme.of(context).textTheme.bodySmall),
      const Gap(12),
      Wrap(spacing: 8, runSpacing: 8, children: buttons),
    ]));
  }
}

/// Approval needs three manual-review confirmations (the server rejects approval without them) and, if the
/// server reports a possible duplicate, a note about that check.
class _ApproveDialog extends StatefulWidget {
  const _ApproveDialog();
  @override
  State<_ApproveDialog> createState() => _ApproveDialogState();
}

class _ApproveDialogState extends State<_ApproveDialog> {
  bool identity = false, documents = false, face = false;
  final dup = TextEditingController();
  @override
  void dispose() { dup.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Одобрить заявку'),
        content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
          CheckboxListTile(contentPadding: EdgeInsets.zero, value: identity, onChanged: (v) => setState(() => identity = v ?? false), title: const Text('Проверил анкету и личные данные')),
          CheckboxListTile(contentPadding: EdgeInsets.zero, value: documents, onChanged: (v) => setState(() => documents = v ?? false), title: const Text('Проверил фото паспорта')),
          CheckboxListTile(contentPadding: EdgeInsets.zero, value: face, onChanged: (v) => setState(() => face = v ?? false), title: const Text('Проверил качество фото лица')),
          const Gap(6),
          TextField(controller: dup, minLines: 1, maxLines: 3, decoration: const InputDecoration(labelText: 'Проверка совпадений (если спросит система)')),
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
          FilledButton(
            onPressed: (identity && documents && face)
                ? () => Navigator.pop(context, {'identityReviewed': true, 'documentsReviewed': true, 'faceQualityConfirmed': true, if (dup.text.trim().isNotEmpty) 'duplicateReview': dup.text.trim()})
                : null,
            child: const Text('Одобрить'),
          ),
        ],
      );
}

String docLabel(String kind) => switch (kind) {
      'FACE' => 'Фото лица',
      'PASSPORT_FRONT' => 'Паспорт: лицевая сторона',
      'PASSPORT_BACK' => 'Паспорт: обратная сторона',
      _ => 'Документ',
    };

/// Passport and face photos, shown inside the app. Each image is fetched through the audited endpoint, so a
/// view here is written to the access journal exactly as in the cabinet. The list is already filtered by the
/// viewer's rights on the server, so a staffer without passport rights simply sees nothing to open.
class _DocumentsCard extends StatelessWidget {
  const _DocumentsCard({required this.applicationId, required this.documents, required this.version});
  final String applicationId;
  final List<Map<String, dynamic>> documents;
  final Object? version;
  @override
  Widget build(BuildContext context) => AppCard(
        color: Brand.blueSoft,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Документы и фото', style: manrope(15, FontWeight.w800)),
          const Gap(4),
          Text(documents.isEmpty
              ? 'Нет прав на просмотр паспорта и фото лица, либо документы ещё не загружены.'
              : 'Каждое открытие фиксируется в журнале доступа.'),
          if (documents.isNotEmpty) ...[
            const Gap(12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final d in documents)
                FilledButton.icon(
                  onPressed: () => openPage(context, _DocViewer(applicationId: applicationId, kind: '${d['kind']}', version: version, title: docLabel('${d['kind']}'))),
                  icon: Icon('${d['kind']}' == 'FACE' ? Icons.face_rounded : Icons.badge_outlined, size: 18),
                  label: Text(docLabel('${d['kind']}')),
                ),
            ]),
          ],
        ]),
      );
}

/// Full-screen, zoomable view of one document. The bytes come with the bearer token (ApiClient.bytes).
class _DocViewer extends StatelessWidget {
  const _DocViewer({required this.applicationId, required this.kind, required this.version, required this.title});
  final String applicationId;
  final String kind;
  final Object? version;
  final String title;
  @override
  Widget build(BuildContext context) {
    final api = SessionScope.of(context).api;
    return Scaffold(
      backgroundColor: Brand.ink,
      appBar: AppBar(backgroundColor: Brand.ink, foregroundColor: Brand.white, title: Text(title)),
      body: FutureBuilder<Uint8List>(
        future: api.bytes('/applications/$applicationId/documents/$kind', {'v': '$version'}),
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator(color: Brand.white));
          if (snap.hasError) {
            return Center(child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text('${snap.error}', textAlign: TextAlign.center, style: manrope(14, FontWeight.w600, color: Brand.white)),
            ));
          }
          return InteractiveViewer(minScale: 1, maxScale: 6, child: Center(child: Image.memory(snap.data!)));
        },
      ),
    );
  }
}

// ---------- Tickets (staff) ----------
class StaffTicketsScreen extends StatefulWidget {
  const StaffTicketsScreen({super.key});
  @override
  State<StaffTicketsScreen> createState() => _StaffTicketsScreenState();
}

class _StaffTicketsScreenState extends State<StaffTicketsScreen> {
  String status = 'ACTIVE';
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Обращения')),
      body: LiveData<Map<String, dynamic>>(
        key: ValueKey(status),
        topics: const {'tickets'},
        load: () async => (await s.api.get('/tickets', {if (status.isNotEmpty) 'status': status})) as Map<String, dynamic>,
        builder: (context, d, refresh) {
          final items = (d['items'] as List).cast<Map<String, dynamic>>();
          return PageBody(maxWidth: 900, onRefresh: refresh, children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final f in const [('ACTIVE', 'Активные'), ('OPEN', 'Новые'), ('IN_PROGRESS', 'В работе'), ('CLOSED', 'Закрытые'), ('', 'Все')])
                ChoiceChip(label: Text(f.$2), selected: status == f.$1, showCheckmark: false, onSelected: (_) => setState(() => status = f.$1)),
            ]),
            const Gap(12),
            if (s.role != Role.superAdmin) ...[const StatusPill('Авторы скрыты — их видит только владелец', tone: Tone.gray), const Gap(12)],
            if (items.isEmpty) const EmptyState(icon: Icons.chat_bubble_outline_rounded, title: 'Обращений нет'),
            for (final t in items) Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: TicketTile(t,
                  subtitle: [ticketCategory[t['category']], if (t['room'] != null) 'комната ${t['room']}', if (t['author'] != null) (t['author'] as Map)['fullName'], dayTime(t['updatedAt'])].join(' · '),
                  onTap: () => openPage(context, TicketScreen(id: '${t['id']}'))),
            ),
          ]);
        },
      ),
    );
  }
}

// ---------- More / settings ----------
class TelegramCard extends StatelessWidget {
  const TelegramCard({super.key});
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return LiveData<Map<String, dynamic>>(
      load: () async => (await s.api.get('/auth/telegram')) as Map<String, dynamic>,
      builder: (context, t, refresh) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: AppCard(child: Row(children: [
          IconChip(Icons.send_rounded, tone: t['linked'] == true ? Tone.green : Tone.blue),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Telegram', style: manrope(15, FontWeight.w800)),
            Text(t['linked'] == true ? 'Привязан: уведомления и подтверждение входа' : 'Не привязан. Без него вход из интернета с нового устройства невозможен.', style: Theme.of(context).textTheme.bodySmall),
          ])),
          if (t['linked'] != true) TextButton(onPressed: () async {
            try {
              final r = await s.api.post('/auth/telegram/link') as Map<String, dynamic>;
              await launchUrl(Uri.parse('${r['url']}'), mode: LaunchMode.externalApplication);
              if (context.mounted) toast(context, 'Нажмите «Старт» и «Подтвердить мой телефон» в боте');
            } on ApiException catch (e) { if (context.mounted) toast(context, e.message); }
          }, child: const Text('Привязать')),
        ])),
      ),
    );
  }
}

class StaffListCard extends StatelessWidget {
  const StaffListCard({super.key});
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return LiveData<List<dynamic>>(
      load: () async => (await s.api.get('/users')) as List<dynamic>,
      builder: (context, users, refresh) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SectionTitle('Сотрудники'),
        for (final u in users.cast<Map<String, dynamic>>()) Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: AppCard(child: Row(children: [
            Avatar('${u['fullName']}', size: 38),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${u['fullName']}', style: manrope(15, FontWeight.w700)),
              Text('${u['phone']}', style: Theme.of(context).textTheme.bodySmall),
            ])),
            StatusPill(u['role'] == 'ADMIN' ? (u['active'] == false ? 'Отключён' : 'Администратор') : 'Супер-админ', tone: u['role'] == 'ADMIN' ? (u['active'] == false ? Tone.gray : Tone.blue) : Tone.ink),
            // Only staff (ADMIN) can be disabled or removed; the owner's own row has no menu.
            if (u['role'] == 'ADMIN')
              PopupMenuButton<String>(
                onSelected: (v) => _staffAction(context, s.api, u, v, refresh),
                itemBuilder: (_) => [
                  PopupMenuItem(value: 'toggle', child: Text(u['active'] == false ? 'Включить' : 'Отключить')),
                  const PopupMenuItem(value: 'delete', child: Text('Удалить', style: TextStyle(color: Brand.red))),
                ],
              ),
          ])),
        ),
        Text('Права сотрудников меняются в кабинете на компьютере: Настройки → Права сотрудников.', style: Theme.of(context).textTheme.bodySmall),
      ]),
    );
  }
}

Future<void> _staffAction(BuildContext context, ApiClient api, Map<String, dynamic> u, String action, Future<void> Function() refresh) async {
  try {
    switch (action) {
      case 'toggle':
        final enable = u['active'] == false;
        await api.patch('/users/${u['id']}', {'active': enable});
        await refresh();
        if (context.mounted) toast(context, enable ? 'Сотрудник включён' : 'Сотрудник отключён');
      case 'delete':
        if (!await _confirmAction(context, title: 'Удалить сотрудника?', message: 'Удалить можно только сотрудника, который ещё не входил и не работал в системе. Иначе его можно отключить.')) return;
        await api.delete('/users/${u['id']}');
        await refresh();
        if (context.mounted) toast(context, 'Сотрудник удалён');
    }
  } on ApiException catch (e) {
    if (context.mounted) toast(context, e.message);
  }
}
