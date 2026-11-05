import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:share_plus/share_plus.dart';

import '../api/client.dart';
import '../theme.dart';
import '../ui/kit.dart';

/// Parent access in the staff resident card. Staff add a parent and pass on a one-time Telegram link; the parent
/// then gets payment reminders, payments with the receipt number, new charges and stay changes in the bot.
/// The list comes with the resident card (LiveData on 'house'), so it follows the bot live.
class GuardiansSection extends StatelessWidget {
  const GuardiansSection({super.key, required this.api, required this.residentId, required this.guardians, required this.living, required this.canManage, required this.refresh});
  final ApiClient api;
  final String residentId;
  final List<Map<String, dynamic>> guardians;
  final bool living;
  final bool canManage;
  final Future<void> Function() refresh;

  static String _when(String iso) {
    final d = DateTime.parse(iso).toUtc().add(const Duration(hours: 5));
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(d.day)}.${two(d.month)} ${two(d.hour)}:${two(d.minute)}';
  }

  Future<void> _run(BuildContext context, Future<void> Function() fn) async {
    try { await fn(); await refresh(); } on ApiException catch (e) { if (context.mounted) toast(context, e.message); }
  }

  Future<void> _add(BuildContext context) async {
    final res = await showDialog<(String, String)>(context: context, builder: (_) => const _AddGuardianDialog());
    if (res == null || !context.mounted) return;
    await _run(context, () async {
      final r = await api.post('/residents/$residentId/guardians', {'name': res.$1, 'phone': res.$2}) as Map<String, dynamic>;
      if (context.mounted) await showGuardianLink(context, res.$1, '${r['link']}', '${r['expiresAt']}');
    });
  }

  Future<void> _relink(BuildContext context, Map<String, dynamic> g) => _run(context, () async {
        final r = await api.post('/residents/$residentId/guardians/${g['id']}/link', {}) as Map<String, dynamic>;
        if (context.mounted) await showGuardianLink(context, '${g['name']}', '${r['link']}', '${r['expiresAt']}');
      });

  Future<void> _remove(BuildContext context, Map<String, dynamic> g) async {
    final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
          title: const Text('Отключить родителя?'),
          content: Text('${g['name']} перестанет получать сведения в Telegram. Подключить снова можно новой ссылкой.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Отмена')),
            FilledButton(style: FilledButton.styleFrom(backgroundColor: Brand.red), onPressed: () => Navigator.pop(d, true), child: const Text('Отключить')),
          ],
        ));
    if (ok != true || !context.mounted) return;
    await _run(context, () async {
      await api.delete('/residents/$residentId/guardians/${g['id']}');
      if (context.mounted) toast(context, 'Родитель отключён');
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!living && guardians.isEmpty) return const SizedBox.shrink();
    final small = Theme.of(context).textTheme.bodySmall;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SectionTitle('Родители'),
      AppCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('В Telegram приходят напоминания об оплате, оплаты с номером чека, начисления, переселение, срок проживания и выезд. Местоположение и документы не видны.', style: small),
        for (final g in guardians) ...[
          const Divider(height: 24),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${g['name']}', style: manrope(15, FontWeight.w800)),
              if (g['phone'] != null) Text('${g['phone']}', style: small),
              Text(g['status'] == 'LINKED'
                  ? 'Подключён ${_when('${g['linkedAt']}')}'
                  : g['linkExpiresAt'] != null ? 'Ждём, ссылка до ${_when('${g['linkExpiresAt']}')}' : 'Ссылка истекла', style: small),
            ])),
            const SizedBox(width: 8),
            StatusPill(g['status'] == 'LINKED' ? 'В Telegram' : 'Не подключён', tone: g['status'] == 'LINKED' ? Tone.green : Tone.gray),
          ]),
          if (canManage) Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(spacing: 8, runSpacing: 4, children: [
              if (living && g['status'] != 'LINKED') OutlinedButton(onPressed: () => _relink(context, g), child: const Text('Новая ссылка')),
              TextButton(onPressed: () => _remove(context, g), style: TextButton.styleFrom(foregroundColor: Brand.red), child: const Text('Отключить')),
            ]),
          ),
        ],
        if (canManage && living && guardians.length < 3) ...[
          const Gap(12),
          FilledButton.icon(onPressed: () => _add(context), icon: const Icon(Icons.family_restroom_rounded), label: const Text('Подключить родителя')),
        ],
      ])),
    ]);
  }
}

/// The one-time link: share it straight to the parent (Telegram, SMS) or copy it.
Future<void> showGuardianLink(BuildContext context, String name, String link, String expiresAt) => showDialog<void>(context: context, builder: (d) => AlertDialog(
      title: const Text('Ссылка для родителя'),
      content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Отправьте ссылку: $name. Родитель откроет её в Telegram и сразу будет подключён. Ссылка одноразовая и действует 7 дней.'),
        const Gap(10),
        SelectableText(link, style: manrope(13, FontWeight.w600, color: Brand.blue)),
      ])),
      actions: [
        TextButton(onPressed: () { Clipboard.setData(ClipboardData(text: link)); Navigator.pop(d); toast(context, 'Ссылка скопирована'); }, child: const Text('Копировать')),
        FilledButton.icon(
          onPressed: () { Navigator.pop(d); SharePlus.instance.share(ShareParams(text: 'Ссылка для сведений об оплате проживания в Telegram: $link')); },
          icon: const Icon(Icons.send_rounded, size: 18), label: const Text('Отправить'),
        ),
      ],
    ));

class _AddGuardianDialog extends StatefulWidget {
  const _AddGuardianDialog();
  @override
  State<_AddGuardianDialog> createState() => _AddGuardianDialogState();
}

class _AddGuardianDialogState extends State<_AddGuardianDialog> {
  final name = TextEditingController();
  final phone = TextEditingController();
  String? error;
  @override
  void dispose() { name.dispose(); phone.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Подключить родителя'),
        content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, maxLength: 80, textCapitalization: TextCapitalization.sentences, decoration: InputDecoration(labelText: 'Кто это', hintText: 'Мама, Дилноза', errorText: error)),
          TextField(controller: phone, keyboardType: TextInputType.phone, maxLength: 30, decoration: const InputDecoration(labelText: 'Телефон (необязательно)', hintText: '+998 90 123 45 67')),
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
          FilledButton(onPressed: () {
            if (name.text.trim().length < 2) { setState(() => error = 'Укажите, кто это'); return; }
            Navigator.pop(context, (name.text.trim(), phone.text.trim()));
          }, child: const Text('Получить ссылку')),
        ],
      );
}
