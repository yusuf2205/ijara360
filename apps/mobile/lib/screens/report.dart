import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:share_plus/share_plus.dart';

import '../api/client.dart';
import '../theme.dart';
import '../ui/kit.dart';
import 'receipt.dart';
import 'tenant.dart' show chargeType, methodLabel;

String _ym(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}';
String _monthTitle(String ym) {
  final t = DateFormat('LLLL y', 'ru').format(DateTime.parse('$ym-01'));
  return t[0].toUpperCase() + t.substring(1);
}

/// The month's money for staff: what came in (by method and by who accepted it, to reconcile cash),
/// what was charged, the month's rent by resident, today's debt, and every payment with its receipt.
/// Live: a payment recorded elsewhere shows up at once. Files for Excel can be shared from the menu.
class MonthReportScreen extends StatefulWidget {
  const MonthReportScreen({super.key});
  @override
  State<MonthReportScreen> createState() => _MonthReportScreenState();
}

class _MonthReportScreenState extends State<MonthReportScreen> {
  final current = _ym(DateTime.now().toUtc().add(const Duration(hours: 5)));
  late String month = current;
  bool exporting = false;

  void shift(int by) {
    final d = DateTime.parse('$month-01');
    setState(() => month = _ym(DateTime(d.year, d.month + by)));
  }

  Future<void> export(String type, String title) async {
    final s = SessionScope.of(context);
    final first = DateTime.parse('$month-01'), last = DateTime(first.year, first.month + 1, 0);
    final to = '$month-${last.day.toString().padLeft(2, '0')}';
    setState(() => exporting = true);
    try {
      final bytes = await s.api.bytes('/finance/report', {'type': type, if (type != 'debtors') 'from': '$month-01', if (type != 'debtors') 'to': to});
      final name = type == 'debtors' ? 'ijara360-dolzhniki.csv' : 'ijara360-$type-$month.csv';
      await SharePlus.instance.share(ShareParams(files: [XFile.fromData(bytes, mimeType: 'text/csv', name: name)], subject: '$title · ${_monthTitle(month)}'));
    } on ApiException catch (e) {
      if (mounted) toast(context, e.message);
    } catch (_) {
      if (mounted) toast(context, 'Не удалось подготовить файл. Попробуйте ещё раз.');
    } finally {
      if (mounted) setState(() => exporting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Отчёт за месяц'), actions: [
        PopupMenuButton<String>(
          tooltip: 'Выгрузить для Excel',
          enabled: !exporting,
          icon: exporting ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.ios_share_rounded),
          onSelected: (v) => export(v, {'payments': 'Оплаты', 'charges': 'Начисления', 'debtors': 'Должники'}[v]!),
          itemBuilder: (_) => const [
            PopupMenuItem(value: 'payments', child: Text('Оплаты за месяц (Excel)')),
            PopupMenuItem(value: 'charges', child: Text('Начисления за месяц (Excel)')),
            PopupMenuItem(value: 'debtors', child: Text('Должники сейчас (Excel)')),
          ],
        ),
      ]),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
          child: Row(children: [
            IconButton(tooltip: 'Предыдущий месяц', onPressed: () => shift(-1), icon: const Icon(Icons.chevron_left_rounded)),
            Expanded(child: Text(_monthTitle(month), textAlign: TextAlign.center, style: manrope(17, FontWeight.w800))),
            IconButton(tooltip: 'Следующий месяц', onPressed: month == current ? null : () => shift(1), icon: const Icon(Icons.chevron_right_rounded)),
          ]),
        ),
        Expanded(child: LiveData<Map<String, dynamic>>(
          key: ValueKey(month),
          topics: const {'finance'},
          load: () async => (await s.api.get('/finance/month-report', {'month': month})) as Map<String, dynamic>,
          builder: (context, r, refresh) => _Report(r, onRefresh: refresh),
        )),
      ]),
    );
  }
}

class _Report extends StatelessWidget {
  const _Report(this.r, {required this.onRefresh});
  final Map<String, dynamic> r;
  final Future<void> Function() onRefresh;
  @override
  Widget build(BuildContext context) {
    final received = r['received'] as Map<String, dynamic>, charged = r['charged'] as Map<String, dynamic>;
    final rent = r['rent'] as Map<String, dynamic>, now = r['now'] as Map<String, dynamic>;
    final byMethod = (received['byMethod'] as Map).cast<String, dynamic>(), byType = (charged['byType'] as Map).cast<String, dynamic>();
    final staff = (received['byStaff'] as List).cast<Map<String, dynamic>>(), payments = (r['payments'] as List).cast<Map<String, dynamic>>();
    String count(Map g) => '${g['residents']}';
    String cap(String t) => t.isEmpty ? t : t[0].toUpperCase() + t.substring(1);
    return PageBody(onRefresh: onRefresh, children: [
      TileGrid(minTile: 160, max: 4, children: [
        Kpi(icon: Icons.payments_outlined, tone: Tone.green, value: sum(received['total']), label: 'Получено · ${received['count']} опл.'),
        Kpi(icon: Icons.receipt_long_outlined, value: sum(charged['total']), label: 'Начислено за месяц'),
        Kpi(icon: Icons.error_outline_rounded, tone: Tone.red, value: sum(now['debt']), label: 'Долг сейчас'),
        Kpi(icon: Icons.schedule_rounded, tone: Tone.orange, value: sum(now['overdue']), label: 'Просрочено сейчас'),
      ]),
      const SectionTitle('Аренда за месяц'),
      TileGrid(minTile: 140, max: 3, children: [
        ColorTile(icon: Icons.verified_outlined, tone: Tone.green, value: count(rent['paid']), label: 'Оплатили'),
        ColorTile(icon: Icons.timelapse_rounded, tone: Tone.orange, value: count(rent['partial']), label: 'Частично · ${sum(rent['partial']['amount'])}'),
        ColorTile(icon: Icons.error_outline_rounded, tone: Tone.red, value: count(rent['unpaid']), label: 'Не оплатили · ${sum(rent['unpaid']['amount'])}'),
      ]),
      const SectionTitle('Получено'),
      AppCard(child: Column(children: [
        if (byMethod.isEmpty) const KeyValue('Оплат за месяц нет', '—'),
        for (final e in byMethod.entries) KeyValue(cap(methodLabel[e.key] ?? e.key), sum(e.value)),
      ])),
      const SectionTitle('Кто принимал оплату'),
      if (staff.isEmpty) const EmptyState(icon: Icons.person_outline_rounded, title: 'Оплат за месяц нет')
      else AppCard(child: Column(children: [
        for (final p in staff) Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(children: [
            Avatar('${p['name']}', size: 36),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${p['name']}', style: manrope(14, FontWeight.w700)),
              Text('${p['count']} опл. · наличными ${sum(p['cash'])}', style: Theme.of(context).textTheme.bodySmall),
            ])),
            Text(sum(p['total']), style: manrope(14, FontWeight.w800)),
          ]),
        ),
      ])),
      const SectionTitle('Начислено'),
      AppCard(child: Column(children: [
        if (byType.isEmpty) const KeyValue('Начислений за месяц нет', '—'),
        for (final e in byType.entries) KeyValue(chargeType[e.key] ?? e.key, sum(e.value)),
        if (byType.isNotEmpty) ...[
          const Divider(),
          KeyValue('Из них оплачено', sum(charged['paid']), valueColor: Brand.green),
          KeyValue('Осталось оплатить', sum(charged['due']), valueColor: (num.tryParse('${charged['due']}') ?? 0) > 0 ? Brand.red : Brand.green),
        ],
      ])),
      SectionTitle('Оплаты · ${payments.length}'),
      if (payments.isEmpty) const EmptyState(icon: Icons.payments_outlined, title: 'Оплат за месяц нет'),
      for (final p in payments) Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: AppCard(
          onTap: () => openPage(context, ReceiptScreen(id: '${p['id']}')),
          child: Row(children: [
            const IconChip(Icons.receipt_long_rounded, tone: Tone.green),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${(p['resident'] as Map)['fullName']}', style: manrope(15, FontWeight.w700)),
              Text('${dayTime(p['createdAt'])} · ${methodLabel[p['method']] ?? ''} · ${receiptNo(p['receiptNumber'])}', style: Theme.of(context).textTheme.bodySmall),
            ])),
            Text(sum(p['amount']), style: manrope(15, FontWeight.w800)),
          ]),
        ),
      ),
    ]);
  }
}
