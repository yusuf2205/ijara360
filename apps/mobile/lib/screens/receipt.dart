import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:share_plus/share_plus.dart';

import '../theme.dart';
import '../ui/kit.dart';
import 'tenant.dart' show methodLabel, period;

/// "№ 000123": the payment's place in the house's sequence of payments.
String receiptNo(Object? n) => '№ ${'${n ?? ''}'.padLeft(6, '0')}';

/// The receipt for one payment — cash or transfer. The resident opens it from "Платежи", staff from
/// "Оплаты" or right after accepting a payment; both can share it as a picture (for parents, for a chat).
/// It is the house's proof that the money was accepted, not a fiscal cheque, and says so.
class ReceiptScreen extends StatefulWidget {
  const ReceiptScreen({super.key, required this.id, this.tenant = false});
  final String id;
  final bool tenant;
  @override
  State<ReceiptScreen> createState() => _ReceiptScreenState();
}

class _ReceiptScreenState extends State<ReceiptScreen> {
  final _shot = GlobalKey();
  bool sharing = false;

  Future<void> share(Map<String, dynamic> r) async {
    setState(() => sharing = true);
    try {
      final boundary = _shot.currentContext!.findRenderObject() as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 3);
      final png = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      if (!mounted) return;
      final text = '${L(context, 'Чек')} ${receiptNo(r['number'])} · ${sum(r['amount'])} · ${r['property']['name']}';
      await SharePlus.instance.share(ShareParams(
        files: [XFile.fromData(png, mimeType: 'image/png', name: 'ijara360-chek-${r['number']}.png')],
        text: text,
        subject: text,
      ));
    } catch (_) {
      if (mounted) toast(context, L(context, 'Не удалось поделиться чеком. Попробуйте ещё раз.'));
    } finally {
      if (mounted) setState(() => sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(L(context, 'Чек'))),
      body: LiveData<Map<String, dynamic>>(
        topics: const {'finance'},
        load: () async => (await s.api.get(widget.tenant ? '/tenant/payments/${widget.id}/receipt' : '/finance/payments/${widget.id}/receipt')) as Map<String, dynamic>,
        builder: (context, r, refresh) => PageBody(maxWidth: 520, onRefresh: refresh, children: [
          RepaintBoundary(key: _shot, child: ReceiptCard(r)),
          const Gap(16),
          FilledButton.icon(
            onPressed: sharing ? null : () => share(r),
            icon: sharing ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.ios_share_rounded),
            label: Text(L(context, 'Поделиться чеком')),
          ),
        ]),
      ),
    );
  }
}

class ReceiptCard extends StatelessWidget {
  const ReceiptCard(this.r, {super.key});
  final Map<String, dynamic> r;
  @override
  Widget build(BuildContext context) {
    final items = (r['items'] as List).cast<Map<String, dynamic>>();
    final resident = r['resident'] as Map<String, dynamic>, after = r['after'] as Map<String, dynamic>;
    final toCredit = num.tryParse('${r['toCredit']}') ?? 0, debt = num.tryParse('${after['debt']}') ?? 0, credit = num.tryParse('${after['credit']}') ?? 0;
    final when = DateTime.parse('${r['createdAt']}');
    final place = [if (resident['room'] != null) '${L(context, 'Комната')} ${resident['room']}', if (resident['bed'] != null) '${L(context, 'Место')} ${resident['bed']}'].join(' · ');
    final small = manrope(12, FontWeight.w600, color: Brand.gray500);
    return Material(
      color: Brand.white,
      borderRadius: BorderRadius.circular(18),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('${r['property']['name']}', style: manrope(16, FontWeight.w800)),
          if (r['property']['address'] != null) Text('${r['property']['address']}', style: small),
          const Gap(14),
          Row(children: [
            Expanded(child: Text(L(context, 'Квитанция об оплате'), style: manrope(13, FontWeight.w700, color: Brand.gray500))),
            Text(receiptNo(r['number']), style: manrope(13, FontWeight.w800)),
          ]),
          Text('${longDateL(context, when)}, ${dayTime(r['createdAt']).split(', ').last}', style: small),
          const Gap(18),
          Center(child: Text(sum(r['amount']), style: manrope(30, FontWeight.w800))),
          const Gap(6),
          Center(child: StatusPill('${L(context, 'Оплата принята')} · ${L(context, methodLabel[r['method']] ?? '')}', tone: Tone.green)),
          const Gap(16),
          const Divider(),
          KeyValue(L(context, 'Жилец'), '${resident['fullName']}'),
          if (place.isNotEmpty) KeyValue(L(context, 'Где живёт'), place),
          KeyValue(L(context, 'Принял'), '${r['acceptedBy']}'),
          if (items.isNotEmpty || toCredit > 0) ...[
            const Divider(),
            for (final i in items) KeyValue(period(context, i), sum(i['amount'])),
            if (toCredit > 0) KeyValue(L(context, 'В аванс'), sum(toCredit), valueColor: Brand.green),
          ],
          const Divider(),
          if (credit > 0) KeyValue(L(context, 'Аванс после оплаты'), sum(credit), valueColor: Brand.green)
          else KeyValue(L(context, 'Долг после оплаты'), debt > 0 ? sum(debt) : L(context, 'Нет долга'), valueColor: debt > 0 ? Brand.red : Brand.green),
          const Gap(10),
          Text(L(context, 'Квитанция дома о приёме оплаты. Не является фискальным чеком.'), textAlign: TextAlign.center, style: manrope(11, FontWeight.w500, color: Brand.gray500)),
          const Gap(2),
          Text('ijara360', textAlign: TextAlign.center, style: manrope(11, FontWeight.w800, color: Brand.blue)),
        ]),
      ),
    );
  }
}
