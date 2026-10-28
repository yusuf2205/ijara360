import 'package:flutter/material.dart';

import '../theme.dart';
import '../ui/kit.dart';
import '../ui/shell.dart';
import 'common.dart';

/// Tab order in the tenant app (used by tiles that jump between tabs).
class TenantTab { static const home = 0, payments = 1, tickets = 2, feed = 3, profile = 4; }

class TenantHome extends StatelessWidget {
  const TenantHome({super.key});
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return LiveData<List<dynamic>>(
      topics: const {'finance', 'notifications', 'tickets'},
      load: () => Future.wait([s.api.get('/tenant/me'), s.api.get('/tenant/finance'), s.api.get('/tenant/notifications')]),
      builder: (context, d, refresh) {
        final me = d[0] as Map<String, dynamic>, fin = d[1] as Map<String, dynamic>, feed = d[2] as Map<String, dynamic>;
        final occ = me['occupancy'] as Map<String, dynamic>?;
        final debt = num.tryParse('${fin['totalDebt']}') ?? 0;
        final next = fin['nextCharge'] as Map<String, dynamic>?;
        final access = fin['access'] as Map<String, dynamic>;
        final granted = access['granted'] == true;
        final t = Theme.of(context).textTheme;
        return PageBody(onRefresh: refresh, children: [
          Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Semantics(header: true, child: Text('${greetingL(context)}, ${s.firstName}!', style: t.headlineMedium)),
              Text(s.propertyName, style: t.bodySmall),
            ])),
            BellButton(unread: feed['unread'] as int? ?? 0, onTap: () => AppShell.go(context, TenantTab.feed)),
          ]),
          const Gap(18),
          // The place card is the hero: who you are in this house.
          AppCard(
            color: Brand.navy,
            padding: const EdgeInsets.all(20),
            semanticLabel: occ == null ? 'Сейчас вы не заселены' : 'Моё место: комната ${occ['room']}, место ${occ['room']}-${occ['bed']}',
            child: ExcludeSemantics(child: Row(children: [
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(L(context, 'МОЁ МЕСТО'), style: manrope(11, FontWeight.w800, color: Brand.blueLight, spacing: 1.4)),
                const Gap(8),
                Text(occ == null ? L(context, 'Не заселён') : '${L(context, 'Комната')} ${occ['room']}', style: manrope(26, FontWeight.w800, color: Brand.white)),
                if (occ != null) Text('${L(context, 'Место')} ${occ['room']}-${occ['bed']} · ${dayL(context, occ['moveInDate'])}', style: manrope(14, FontWeight.w600, color: const Color(0xFFB9B9BE))),
                const Gap(12),
                StatusPill(occ == null ? L(context, 'Нет проживания') : L(context, 'Проживаю'), tone: occ == null ? Tone.gray : Tone.blue),
              ])),
              Container(
                width: 92, height: 92,
                decoration: BoxDecoration(color: const Color(0xFF1F1F22), borderRadius: BorderRadius.circular(22)),
                child: const Icon(Icons.bed_rounded, color: Brand.blueLight, size: 48),
              ),
            ])),
          ),
          const Gap(12),
          if (debt > 0) ...[
            AppCard(
              color: Brand.redSoft,
              onTap: () => AppShell.go(context, TenantTab.payments),
              child: Row(children: [
                const IconChip(Icons.error_outline_rounded, tone: Tone.red),
                const SizedBox(width: 12),
                Expanded(child: Text('${L(context, 'Долг')} ${sum(debt)}. ${L(context, 'Оплатите у администратора, чтобы сохранить доступ.')}', style: manrope(14, FontWeight.w700, color: const Color(0xFF9B342E)))),
              ]),
            ),
            const Gap(12),
          ],
          LayoutBuilder(builder: (context, c) {
            final pay = AppCard(
              onTap: () => AppShell.go(context, TenantTab.payments),
              semanticLabel: next == null ? 'Платежей к оплате нет' : 'Следующая оплата ${sum(next['dueAmount'])} до ${day(next['dueDate'])}',
              child: ExcludeSemantics(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(L(context, 'Следующая оплата'), style: t.bodySmall),
                const Gap(6),
                Text(next == null ? L(context, 'Нет долга') : sum(next['dueAmount']), style: manrope(20, FontWeight.w800)),
                const Gap(4),
                Text(next == null ? L(context, 'Всё оплачено') : dueBy(context, next['dueDate']), style: t.bodySmall),
                const Gap(12),
                if (next != null) dueBadge(context, next),
              ])),
            );
            final acc = AppCard(
              semanticLabel: granted ? 'Доступ разрешён' : 'Доступ ограничен',
              child: ExcludeSemantics(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(L(context, 'Доступ'), style: t.bodySmall),
                const Gap(6),
                // One line on narrow phones ("Разрешён" broke mid-word): shrink instead of wrapping.
                FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(granted ? L(context, 'Разрешён') : L(context, 'Ограничен'), maxLines: 1, style: manrope(20, FontWeight.w800, color: granted ? Brand.green : Brand.red))),
                const Gap(4),
                Text(granted ? (debt > 0 ? L(context, 'Есть долг') : L(context, 'Долга нет')) : L(context, 'Есть просрочка'), style: t.bodySmall),
                const Gap(12),
                IconChip(granted ? Icons.verified_user_rounded : Icons.gpp_bad_outlined, tone: granted ? Tone.green : Tone.red, size: 34),
              ])),
            );
            return IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Expanded(child: pay), const SizedBox(width: 12), Expanded(child: acc)]));
          }),
          SectionTitle(L(context, 'Разделы')),
          TileGrid(minTile: 104, max: 6, children: [
            QuickTile(icon: Icons.account_balance_wallet_outlined, label: L(context, 'Мои платежи'), onTap: () => AppShell.go(context, TenantTab.payments)),
            QuickTile(icon: Icons.chat_bubble_outline_rounded, label: L(context, 'Обращения'), onTap: () => AppShell.go(context, TenantTab.tickets)),
            QuickTile(icon: Icons.notifications_none_rounded, label: L(context, 'Уведомления'), badge: feed['unread'] as int? ?? 0, onTap: () => AppShell.go(context, TenantTab.feed)),
            QuickTile(icon: Icons.person_outline_rounded, label: L(context, 'Профиль'), onTap: () => AppShell.go(context, TenantTab.profile)),
            QuickTile(icon: Icons.group_outlined, label: L(context, 'Мои гости'), soon: true),
            QuickTile(icon: Icons.campaign_outlined, label: L(context, 'Объявления'), soon: true),
          ]),
          if ((feed['items'] as List).isNotEmpty) ...[
            SectionTitle(L(context, 'Последнее'), action: L(context, 'Все'), onAction: () => AppShell.go(context, TenantTab.feed)),
            for (final n in (feed['items'] as List).take(3)) Padding(padding: const EdgeInsets.only(bottom: 10), child: NoticeTile(n as Map<String, dynamic>)),
          ],
        ]);
      },
    );
  }
}

Widget dueBadge(BuildContext context, Map<String, dynamic> c) {
  if (c['status'] == 'OVERDUE') return StatusPill(L(context, 'Просрочено'), tone: Tone.red);
  final due = DateTime.parse('${c['dueDate']}').toUtc();
  final days = due.difference(DateTime.now().toUtc()).inDays;
  return StatusPill(days <= 0 ? L(context, 'Сегодня') : (isUz(context) ? '$days kundan keyin' : 'Через $days дн.'), tone: days <= 3 ? Tone.orange : Tone.blue);
}

const chargeType = {'RENT': 'Аренда', 'DEPOSIT': 'Залог', 'PENALTY': 'Штраф', 'UTILITIES': 'Коммунальные', 'OTHER': 'Начисление'};
const methodLabel = {'CASH': 'наличные', 'CARD_TRANSFER': 'перевод на карту', 'BANK_TRANSFER': 'банковский перевод', 'OTHER': 'другое'};
(String, Tone) chargeStatus(String s) => switch (s) { 'PAID' => ('Оплачено', Tone.green), 'PARTIALLY_PAID' => ('Частично', Tone.orange), 'OVERDUE' => ('Просрочено', Tone.red), _ => ('К оплате', Tone.blue) };
String period(BuildContext ctx, Map c) => c['type'] == 'RENT' ? '${L(ctx, 'Аренда за')} ${monthNameL(ctx, c['billingPeriodStart'])}' : L(ctx, chargeType[c['type']] ?? 'Начисление');

class TenantPayments extends StatefulWidget {
  const TenantPayments({super.key});
  @override
  State<TenantPayments> createState() => _TenantPaymentsState();
}

class _TenantPaymentsState extends State<TenantPayments> {
  bool showPayments = false;
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(L(context, 'Платежи'))),
      body: LiveData<List<dynamic>>(
        topics: const {'finance'},
        load: () => Future.wait([s.api.get('/tenant/finance'), s.api.get('/tenant/charges'), s.api.get('/tenant/payments')]),
        builder: (context, d, refresh) {
          final fin = d[0] as Map<String, dynamic>;
          final charges = (d[1] as Map)['items'] as List, payments = (d[2] as Map)['items'] as List;
          final rent = fin['rent'] as Map<String, dynamic>?;
          return PageBody(onRefresh: refresh, children: [
            TileGrid(minTile: 150, max: 3, children: [
              Kpi(icon: Icons.error_outline_rounded, tone: (num.tryParse('${fin['totalDebt']}') ?? 0) > 0 ? Tone.red : Tone.green, value: sum(fin['totalDebt']), label: L(context, 'Долг')),
              Kpi(icon: Icons.savings_outlined, tone: Tone.blue, value: sum(fin['creditBalance']), label: L(context, 'Аванс')),
              if (rent != null) Kpi(icon: Icons.event_repeat_rounded, tone: Tone.gray, value: '${rent['paymentDay']}', label: '${L(context, 'День оплаты')} · ${sum(rent['monthlyPrice'])} ${L(context, 'в месяц')}'),
            ]),
            const Gap(16),
            AppCard(
              color: Brand.blueSoft,
              child: Row(children: [
                const Icon(Icons.info_outline_rounded),
                const SizedBox(width: 12),
                Expanded(child: Text(L(context, 'Оплата принимается у администратора. После оплаты здесь появится чек, а в Telegram придёт уведомление.'), style: manrope(13, FontWeight.w600))),
              ]),
            ),
            const Gap(16),
            SegmentedButton<bool>(
              showSelectedIcon: false,
              segments: [ButtonSegment(value: false, label: Text(L(context, 'Начисления'))), ButtonSegment(value: true, label: Text(L(context, 'Оплаты')))],
              selected: {showPayments},
              onSelectionChanged: (v) => setState(() => showPayments = v.first),
            ),
            const Gap(14),
            if (!showPayments)
              if (charges.isEmpty) EmptyState(icon: Icons.receipt_long_outlined, title: L(context, 'Начислений пока нет'))
              else for (final c in charges.cast<Map<String, dynamic>>()) Padding(padding: const EdgeInsets.only(bottom: 10), child: _ChargeTile(c))
            else if (payments.isEmpty) EmptyState(icon: Icons.payments_outlined, title: L(context, 'Оплат пока нет'))
            else for (final p in payments.cast<Map<String, dynamic>>()) Padding(padding: const EdgeInsets.only(bottom: 10), child: _PaymentTile(p)),
          ]);
        },
      ),
    );
  }
}

class _ChargeTile extends StatelessWidget {
  const _ChargeTile(this.c);
  final Map<String, dynamic> c;
  @override
  Widget build(BuildContext context) {
    final (label, tone) = chargeStatus(c['status'] as String);
    final due = num.tryParse('${c['dueAmount']}') ?? 0;
    return AppCard(
      semanticLabel: '${period(context, c)}: ${sum(c['amount'])}, ${L(context, label)}',
      child: ExcludeSemantics(child: Row(children: [
        IconChip(Icons.receipt_long_rounded, tone: tone),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(period(context, c), style: manrope(15, FontWeight.w700)),
          Text(due > 0 ? '${L(context, 'Осталось')} ${sum(due)} · ${dueBy(context, c['dueDate'])}' : '${L(context, 'Срок')} ${dayL(context, c['dueDate'])}', style: Theme.of(context).textTheme.bodySmall),
        ])),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Text(sum(c['amount']), style: manrope(15, FontWeight.w800)), const Gap(4), StatusPill(L(context, label), tone: tone)]),
      ])),
    );
  }
}

class _PaymentTile extends StatelessWidget {
  const _PaymentTile(this.p);
  final Map<String, dynamic> p;
  @override
  Widget build(BuildContext context) {
    final extra = num.tryParse('${p['unallocatedAmount']}') ?? 0;
    final parts = (p['allocations'] as List).cast<Map<String, dynamic>>();
    return AppCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const IconChip(Icons.check_rounded, tone: Tone.green),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(sum(p['amount']), style: manrope(17, FontWeight.w800)),
            Text('${dayTime(p['createdAt'])} · ${L(context, methodLabel[p['method']] ?? '')}', style: Theme.of(context).textTheme.bodySmall),
          ])),
        ]),
        if (parts.isNotEmpty || extra > 0) ...[
          const Gap(10),
          const Divider(),
          for (final a in parts) KeyValue(period(context, a['charge'] as Map), sum(a['amount'])),
          if (extra > 0) KeyValue(L(context, 'В аванс'), sum(extra), valueColor: Brand.green),
        ],
      ]),
    );
  }
}
