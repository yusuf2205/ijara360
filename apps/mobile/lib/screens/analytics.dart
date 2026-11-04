import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../theme.dart';
import '../ui/kit.dart';

String _mShort(String ym) => DateFormat('LLL', 'ru').format(DateTime.parse('$ym-01')).replaceAll('.', '');
String _mLong(String ym) => DateFormat('LLLL y', 'ru').format(DateTime.parse('$ym-01'));
String _pct(Object? v) {
  if (v == null) return '—';
  final n = v as num;
  return '${n.toStringAsFixed(n % 1 == 0 ? 0 : 1).replaceAll('.', ',')}%';
}
String _short(Object? v) {
  final n = num.tryParse('${v ?? 0}') ?? 0;
  if (n >= 1e6) return '${(n / 1e6).toStringAsFixed(1).replaceAll('.', ',')} млн';
  if (n >= 1e3) return '${(n / 1e3).round()} тыс';
  return '${n.round()}';
}
String _stay(Object? days) {
  if (days == null) return '—';
  final d = days as num;
  return d < 60 ? '$d дн.' : '${(d / 30.4).toStringAsFixed(1).replaceAll('.', ',')} мес.';
}
const _method = {'CASH': 'Наличные', 'CARD_TRANSFER': 'Перевод на карту', 'BANK_TRANSFER': 'Банковский перевод', 'OTHER': 'Другое'};

/// Owner analytics in the app: the same figures as the web page — occupancy, money in, rent paid on time,
/// debt by month, next month's forecast, empty beds and rooms. Updates live on finance and house events.
class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key});
  @override
  State<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

class _AnalyticsScreenState extends State<AnalyticsScreen> {
  int months = 12;
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Аналитика')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
          child: SegmentedButton<int>(
            showSelectedIcon: false,
            segments: const [ButtonSegment(value: 6, label: Text('6 мес.')), ButtonSegment(value: 12, label: Text('12 мес.')), ButtonSegment(value: 24, label: Text('24 мес.'))],
            selected: {months},
            onSelectionChanged: (v) => setState(() => months = v.first),
          ),
        ),
        Expanded(child: LiveData<Map<String, dynamic>>(
          key: ValueKey(months),
          topics: const {'finance', 'house'},
          load: () async => (await s.api.get('/analytics', {'months': '$months'})) as Map<String, dynamic>,
          builder: (context, d, refresh) => _Analytics(d, months: months, onRefresh: refresh),
        )),
      ]),
    );
  }
}

class _Analytics extends StatelessWidget {
  const _Analytics(this.d, {required this.months, required this.onRefresh});
  final Map<String, dynamic> d;
  final int months;
  final Future<void> Function() onRefresh;
  @override
  Widget build(BuildContext context) {
    final ms = (d['months'] as List).cast<Map<String, dynamic>>();
    final cur = ms.last, prev = ms.length > 1 ? ms[ms.length - 2] : null;
    final now = d['now'] as Map<String, dynamic>, w = d['window'] as Map<String, dynamic>, f = now['forecast'] as Map<String, dynamic>;
    final ending = now['endingIn30Days'] as Map<String, dynamic>;
    final rooms = (d['rooms'] as List).cast<Map<String, dynamic>>(), methods = (w['methods'] as List).cast<Map<String, dynamic>>();
    final onTime = cur['onTimePct'] ?? prev?['onTimePct'];
    final small = Theme.of(context).textTheme.bodySmall;
    return PageBody(onRefresh: onRefresh, children: [
      TileGrid(minTile: 160, max: 4, children: [
        Kpi(icon: Icons.bed_outlined, value: _pct(cur['occupancyPct']), label: 'Заполняемость в этом месяце · ${now['occupied']} из ${now['beds']}'),
        Kpi(icon: Icons.payments_outlined, tone: Tone.green, value: _short(w['received']), label: 'Получено за $months мес.'),
        Kpi(icon: Icons.percent_rounded, value: _pct(w['collectionPct']), label: 'Собрано от начисленного'),
        Kpi(icon: Icons.schedule_rounded, tone: Tone.orange, value: _pct(onTime), label: 'Аренда оплачена в срок'),
      ]),
      const SectionTitle('Что дальше'),
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Прогноз на ${_mLong('${f['month']}')}', style: manrope(13, FontWeight.w700, color: Brand.gray500)),
        Text(sum(f['rent']), style: manrope(24, FontWeight.w800)),
        Text('Аренда от ${f['staying']} жильцов, которые остаются.${(f['leaving'] as num) > 0 ? ' Минус ${f['leaving']} выезжающих (${sum(f['leavingRent'])}).' : ''}', style: small),
        if ((ending['residents'] as num) > 0) ...[const Gap(8), Text('В ближайшие 30 дней заканчивается проживание у ${ending['residents']}: ${sum(ending['rent'])} в месяц.', style: manrope(13, FontWeight.w600, color: Brand.orange))],
        const Divider(height: 24),
        KeyValue('Свободных мест', '${now['free']} из ${now['beds']}'),
        if ((num.tryParse('${now['lostPerMonth']}') ?? 0) > 0) KeyValue('Недополучено в месяц', '≈ ${sum(now['lostPerMonth'])}', valueColor: Brand.red),
        KeyValue('Нынешние жильцы живут в среднем', _stay(now['avgTenureDays'])),
        if ((now['closedStays'] as num) > 0) KeyValue('Выехавшие прожили в среднем', _stay(now['avgStayDays'])),
      ])),
      const SectionTitle('Начислено и получено'),
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [_Dot(Brand.gray300), const Text(' Начислено   '), _Dot(Brand.green), const Text(' Получено')]),
        const Gap(10),
        _Pairs(ms),
      ])),
      const SectionTitle('Заполняемость'),
      AppCard(child: _Bars(ms, (m) => m['occupancyPct'] as num?, (m) => _pct(m['occupancyPct']), max: 100, color: Brand.blue)),
      const SectionTitle('Долг на конец месяца'),
      AppCard(child: _Bars(ms, (m) => num.tryParse('${m['debt']}'), (m) => _short(m['debt']), color: Brand.red)),
      const SectionTitle('Аренда в срок'),
      AppCard(child: _Bars(ms, (m) => m['onTimePct'] as num?, (m) => _pct(m['onTimePct']), max: 100, color: Brand.orange)),
      const SectionTitle('Заезды и выезды'),
      AppCard(child: Column(children: [
        for (final m in ms.reversed.where((m) => (m['moveIns'] as num) > 0 || (m['moveOuts'] as num) > 0)) Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(children: [
            Expanded(child: Text(_mLong('${m['month']}'), style: manrope(14, FontWeight.w600))),
            Text('+${m['moveIns']}', style: manrope(14, FontWeight.w800, color: Brand.green)),
            const SizedBox(width: 14),
            Text('−${m['moveOuts']}', style: manrope(14, FontWeight.w800, color: Brand.red)),
          ]),
        ),
        if (ms.every((m) => (m['moveIns'] as num) == 0 && (m['moveOuts'] as num) == 0)) const KeyValue('За период', 'не было'),
      ])),
      SectionTitle('Комнаты за $months мес.'),
      if (rooms.isEmpty) const EmptyState(icon: Icons.meeting_room_outlined, title: 'Комнат пока нет'),
      for (final r in rooms) Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: AppCard(padding: const EdgeInsets.all(14), child: Row(children: [
          IconChip(Icons.meeting_room_outlined, size: 36),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Комната ${r['number']}', style: manrope(15, FontWeight.w700)),
            Text('${r['occupied']} из ${r['beds']} мест · заполняемость ${_pct(r['occupancyPct'])}', style: small),
          ])),
          Text(_short(r['received']), style: manrope(14, FontWeight.w800)),
        ])),
      ),
      const SectionTitle('Как платят'),
      AppCard(child: Column(children: [
        if (methods.isEmpty) const KeyValue('Оплат за период', 'нет'),
        for (final m in methods) KeyValue('${_method[m['method']] ?? m['method']} · ${m['count']} опл.', sum(m['amount'])),
      ])),
      const Gap(8),
      Text('Месяцы — по ташкентскому времени. «В срок» — аренда, полностью оплаченная до дня оплаты с учётом отсрочки.', style: small),
    ]);
  }
}

class _Dot extends StatelessWidget {
  const _Dot(this.color);
  final Color color;
  @override
  Widget build(BuildContext context) => Container(width: 10, height: 10, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3)));
}

/// Month bars that scroll sideways when there are many months; the current month is drawn solid.
class _Bars extends StatelessWidget {
  const _Bars(this.ms, this.value, this.text, {this.max, required this.color});
  final List<Map<String, dynamic>> ms;
  final num? Function(Map<String, dynamic>) value;
  final String Function(Map<String, dynamic>) text;
  final num? max;
  final Color color;
  @override
  Widget build(BuildContext context) {
    final peak = max ?? ms.map((m) => value(m) ?? 0).fold<num>(1, (a, b) => b > a ? b : a);
    return Semantics(
      label: ms.map((m) => '${_mShort('${m['month']}')} ${text(m)}').join(', '),
      child: ExcludeSemantics(child: SizedBox(height: 170, child: ListView(
        scrollDirection: Axis.horizontal,
        reverse: true,
        children: [for (final m in ms.reversed) SizedBox(width: 44, child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
          Text(value(m) == null || (value(m) == 0 && m['current'] != true) ? '' : text(m), maxLines: 1, style: manrope(9.5, FontWeight.w700)),
          const SizedBox(height: 4),
          Container(
            width: 20,
            height: (value(m) ?? 0) == 0 ? 0 : (120 * (value(m)! / peak)).clamp(2, 120).toDouble(),
            decoration: BoxDecoration(color: m['current'] == true ? color : color.withValues(alpha: .35), borderRadius: const BorderRadius.vertical(top: Radius.circular(6), bottom: Radius.circular(3))),
          ),
          const SizedBox(height: 6),
          Text(_mShort('${m['month']}'), style: manrope(10.5, FontWeight.w500, color: Brand.gray500)),
        ]))],
      ))),
    );
  }
}

class _Pairs extends StatelessWidget {
  const _Pairs(this.ms);
  final List<Map<String, dynamic>> ms;
  @override
  Widget build(BuildContext context) {
    num v(Object? x) => num.tryParse('${x ?? 0}') ?? 0;
    final peak = ms.expand((m) => [v(m['charged']), v(m['received'])]).fold<num>(1, (a, b) => b > a ? b : a);
    double h(num x) => x == 0 ? 0 : (120 * x / peak).clamp(2, 120).toDouble();
    return Semantics(
      label: ms.map((m) => '${_mShort('${m['month']}')}: начислено ${sum(m['charged'])}, получено ${sum(m['received'])}').join('; '),
      child: ExcludeSemantics(child: SizedBox(height: 170, child: ListView(
        scrollDirection: Axis.horizontal,
        reverse: true,
        children: [for (final m in ms.reversed) SizedBox(width: 48, child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
          Text(v(m['received']) == 0 ? '' : _short(m['received']), maxLines: 1, style: manrope(9.5, FontWeight.w700)),
          const SizedBox(height: 4),
          Row(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
            Container(width: 12, height: h(v(m['charged'])), decoration: BoxDecoration(color: Brand.gray300, borderRadius: BorderRadius.circular(3))),
            const SizedBox(width: 3),
            Container(width: 12, height: h(v(m['received'])), decoration: BoxDecoration(color: m['current'] == true ? Brand.green : Brand.green.withValues(alpha: .45), borderRadius: BorderRadius.circular(3))),
          ]),
          const SizedBox(height: 6),
          Text(_mShort('${m['month']}'), style: manrope(10.5, FontWeight.w500, color: Brand.gray500)),
        ]))],
      ))),
    );
  }
}
