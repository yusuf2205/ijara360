import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../api/client.dart';
import '../session.dart';
import '../theme.dart';
import '../ui/kit.dart';
import '../update.dart';

String monthName(Object? iso) => iso == null ? '' : DateFormat('LLLL', 'ru').format(DateTime.parse('$iso').toUtc());

class BellButton extends StatelessWidget {
  const BellButton({super.key, required this.unread, required this.onTap});
  final int unread;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => IconButton.outlined(
        tooltip: unread > 0 ? 'Уведомления: $unread новых' : 'Уведомления',
        style: IconButton.styleFrom(backgroundColor: Brand.white, side: const BorderSide(color: Brand.line), minimumSize: const Size(48, 48)),
        onPressed: onTap,
        icon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), backgroundColor: Brand.red, textColor: Brand.white, child: const Icon(Icons.notifications_none_rounded)),
      );
}

class QuickTile extends StatelessWidget {
  const QuickTile({super.key, required this.icon, required this.label, this.onTap, this.soon = false, this.badge = 0});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool soon;
  final int badge;
  @override
  Widget build(BuildContext context) => Opacity(
        opacity: soon ? .55 : 1,
        child: AppCard(
          padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 8),
          onTap: soon ? () => toast(context, '$label появятся в следующих версиях') : onTap,
          semanticLabel: soon ? '$label, скоро' : label,
          child: ExcludeSemantics(child: Column(children: [
            Badge(isLabelVisible: badge > 0, label: Text('$badge'), backgroundColor: Brand.ink, child: IconChip(icon, size: 46)),
            const Gap(10),
            Text(label, textAlign: TextAlign.center, maxLines: 2, style: manrope(12.5, FontWeight.w700)),
            if (soon) Text('скоро', style: manrope(10, FontWeight.w700, color: Brand.gray500)),
          ])),
        ),
      );
}

IconData noticeIcon(String kind) => kind.startsWith('TICKET') ? Icons.chat_bubble_outline_rounded : kind.startsWith('APPLICATION') ? Icons.assignment_outlined : kind.startsWith('PAYMENT') ? Icons.check_circle_outline_rounded : kind.startsWith('CHARGE') ? Icons.receipt_long_outlined : Icons.notifications_none_rounded;

class NoticeTile extends StatelessWidget {
  const NoticeTile(this.n, {super.key, this.onTap});
  final Map<String, dynamic> n;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final unread = n['readAt'] == null;
    return AppCard(
      onTap: onTap,
      color: unread ? Brand.white : Brand.white,
      semanticLabel: '${unread ? 'Новое. ' : ''}${n['title']}. ${n['body']}',
      child: ExcludeSemantics(child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        IconChip(noticeIcon('${n['kind']}'), tone: unread ? Tone.blue : Tone.gray),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${n['title']}', style: manrope(15, FontWeight.w800)),
          const Gap(2),
          Text('${n['body']}', style: manrope(13.5, FontWeight.w500, color: const Color(0xFF3A3A40), height: 1.45)),
          const Gap(6),
          Text(dayTime(n['createdAt']), style: Theme.of(context).textTheme.bodySmall),
        ])),
        if (unread) Container(width: 10, height: 10, margin: const EdgeInsets.only(top: 6), decoration: const BoxDecoration(color: Brand.blue, shape: BoxShape.circle)),
      ])),
    );
  }
}

/// Notification feed for both audiences. Opening an item marks it read.
class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key, this.onOpen});
  final void Function(BuildContext context, Map<String, dynamic> n)? onOpen;
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    final base = s.isStaff ? '/notifications' : '/tenant/notifications';
    return Scaffold(
      appBar: AppBar(title: Text(L(context, 'Уведомления'))),
      floatingActionButton: (s.isStaff && s.role == Role.superAdmin)
          ? FloatingActionButton.extended(backgroundColor: Brand.blue, foregroundColor: Brand.white, onPressed: () => _announce(context), icon: const Icon(Icons.campaign_outlined), label: const Text('Объявление'))
          : null,
      body: LiveData<Map<String, dynamic>>(
        topics: const {'notifications'},
        load: () async => (await s.api.get(base)) as Map<String, dynamic>,
        builder: (context, feed, refresh) {
          final items = (feed['items'] as List).cast<Map<String, dynamic>>();
          return PageBody(maxWidth: 760, onRefresh: refresh, children: [
            if ((feed['unread'] as int? ?? 0) > 0)
              Align(alignment: Alignment.centerRight, child: TextButton.icon(onPressed: () async { await s.api.post('$base/read', {}); await refresh(); }, icon: const Icon(Icons.done_all_rounded), label: Text(L(context, 'Прочитать все')))),
            if (items.isEmpty) EmptyState(icon: Icons.notifications_none_rounded, title: L(context, 'Уведомлений пока нет'), text: L(context, 'Здесь появятся оплаты, начисления и ответы на обращения.')),
            for (final n in items) Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: NoticeTile(n, onTap: () async {
                if (n['readAt'] == null) { await s.api.post('$base/read', {'ids': [n['id']]}); await refresh(); }
                if (onOpen != null && context.mounted) onOpen!(context, n);
              }),
            ),
          ]);
        },
      ),
    );
  }
}

/// Owner-only: broadcast an announcement to every resident who uses the app.
Future<void> _announce(BuildContext context) => showModalBottomSheet<void>(
      context: context, useRootNavigator: true, isScrollControlled: true,
      builder: (_) => _AnnounceSheet(api: SessionScope.of(context).api),
    );

class _AnnounceSheet extends StatefulWidget {
  const _AnnounceSheet({required this.api});
  final ApiClient api;
  @override
  State<_AnnounceSheet> createState() => _AnnounceSheetState();
}

class _AnnounceSheetState extends State<_AnnounceSheet> {
  final title = TextEditingController(), body = TextEditingController();
  bool busy = false;
  @override
  void dispose() { title.dispose(); body.dispose(); super.dispose(); }
  Future<void> send() async {
    if (title.text.trim().isEmpty || body.text.trim().isEmpty) { toast(context, 'Заполните заголовок и текст'); return; }
    setState(() => busy = true);
    try {
      final r = await widget.api.post('/notifications/announce', {'title': title.text.trim(), 'body': body.text.trim()}) as Map<String, dynamic>;
      if (mounted) { Navigator.of(context).pop(); toast(context, 'Отправлено: ${r['recipients']} жильцам'); }
    } on ApiException catch (e) { if (mounted) { setState(() => busy = false); toast(context, e.message); } }
  }
  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Объявление всем жильцам', style: manrope(17, FontWeight.w800)),
          const Gap(4),
          Text('Придёт в приложение каждому жильцу и в Telegram, если привязан.', style: Theme.of(context).textTheme.bodySmall),
          const Gap(14),
          TextField(controller: title, maxLength: 160, decoration: const InputDecoration(labelText: 'Заголовок')),
          const Gap(6),
          TextField(controller: body, maxLength: 1000, maxLines: 4, minLines: 2, decoration: const InputDecoration(labelText: 'Текст')),
          const Gap(12),
          FilledButton.icon(onPressed: busy ? null : send, icon: const Icon(Icons.campaign_outlined), label: Text(busy ? 'Отправляем…' : 'Отправить')),
        ]),
      );
}

// ---------- Tickets (complaints, ideas, repairs) ----------
const ticketCategory = {'COMPLAINT': 'Жалоба', 'SUGGESTION': 'Предложение', 'REPAIR': 'Поломка'};
(String, Tone) ticketStatus(String s) => switch (s) { 'OPEN' => ('Новое', Tone.orange), 'IN_PROGRESS' => ('В работе', Tone.blue), 'RESOLVED' => ('Решено', Tone.green), _ => ('Отклонено', Tone.gray) };
IconData ticketIcon(String c) => c == 'REPAIR' ? Icons.build_outlined : c == 'COMPLAINT' ? Icons.report_gmailerrorred_rounded : Icons.lightbulb_outline_rounded;

class TicketTile extends StatelessWidget {
  const TicketTile(this.t, {super.key, required this.onTap, this.subtitle});
  final Map<String, dynamic> t;
  final VoidCallback onTap;
  final String? subtitle;
  @override
  Widget build(BuildContext context) {
    final (label, tone) = ticketStatus('${t['status']}');
    return AppCard(
      onTap: onTap,
      semanticLabel: '${t['title']}, $label',
      child: ExcludeSemantics(child: Row(children: [
        IconChip(ticketIcon('${t['category']}'), tone: Tone.gray),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${t['title']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: manrope(15, FontWeight.w800)),
          const Gap(2),
          Text(subtitle ?? '${L(context, ticketCategory[t['category']] ?? '')} · ${dayTime(t['updatedAt'])}', style: Theme.of(context).textTheme.bodySmall),
        ])),
        const SizedBox(width: 8),
        StatusPill(L(context, label), tone: tone),
      ])),
    );
  }
}

class TenantTickets extends StatelessWidget {
  const TenantTickets({super.key});
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(L(context, 'Обращения'))),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: Brand.blue,
        foregroundColor: Brand.white,
        onPressed: () => openPage(context, const NewTicketScreen()),
        icon: const Icon(Icons.add_rounded),
        label: Text(L(context, 'Новое обращение')),
      ),
      body: LiveData<Map<String, dynamic>>(
        topics: const {'tickets'},
        load: () async => (await s.api.get('/tenant/tickets')) as Map<String, dynamic>,
        builder: (context, d, refresh) {
          final items = (d['items'] as List).cast<Map<String, dynamic>>();
          return PageBody(maxWidth: 760, onRefresh: refresh, children: [
            AppCard(color: Brand.blueSoft, child: Row(children: [
              const Icon(Icons.shield_outlined),
              const SizedBox(width: 12),
              Expanded(child: Text(L(context, 'Ваше имя видит только владелец дома. Сотрудникам — только суть, а для поломок ещё и комната.'), style: manrope(13, FontWeight.w600))),
            ])),
            const Gap(14),
            if (items.isEmpty) EmptyState(icon: Icons.chat_bubble_outline_rounded, title: L(context, 'Обращений пока нет'), text: L(context, 'Сломалось что-то, мешают соседи или есть идея? Напишите — администрация ответит здесь.')),
            for (final t in items) Padding(padding: const EdgeInsets.only(bottom: 10), child: TicketTile(t, onTap: () => openPage(context, TicketScreen(id: '${t['id']}')))),
            const Gap(70),
          ]);
        },
      ),
    );
  }
}

class NewTicketScreen extends StatefulWidget {
  const NewTicketScreen({super.key});
  @override
  State<NewTicketScreen> createState() => _NewTicketScreenState();
}

class _NewTicketScreenState extends State<NewTicketScreen> {
  String category = 'REPAIR';
  final title = TextEditingController();
  final body = TextEditingController();
  bool busy = false;
  String? error;
  @override
  void dispose() { title.dispose(); body.dispose(); super.dispose(); }

  Future<void> send() async {
    setState(() { busy = true; error = null; });
    final s = SessionScope.of(context);
    try {
      final t = await s.api.post('/tenant/tickets', {'category': category, 'title': title.text.trim(), 'body': body.text.trim()}) as Map<String, dynamic>;
      if (!mounted) return;
      toast(context, L(context, 'Обращение отправлено'));
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => TicketScreen(id: '${t['id']}')));
    } on ApiException catch (e) {
      setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(L(context, 'Новое обращение'))),
        body: PageBody(maxWidth: 640, children: [
          Text(L(context, 'Что случилось?'), style: Theme.of(context).textTheme.titleMedium),
          const Gap(10),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in ticketCategory.entries)
              ChoiceChip(
                avatar: Icon(ticketIcon(e.key), size: 18),
                label: Text(L(context, e.value)),
                selected: category == e.key,
                showCheckmark: false,
                onSelected: (_) => setState(() => category = e.key),
              ),
          ]),
          const Gap(18),
          TextField(controller: title, maxLength: 120, textInputAction: TextInputAction.next, decoration: InputDecoration(labelText: L(context, 'Коротко'), hintText: category == 'REPAIR' ? L(context, 'Например: течёт кран в ванной') : L(context, 'О чём обращение'))),
          const Gap(6),
          TextField(controller: body, maxLength: 4000, minLines: 5, maxLines: 10, decoration: InputDecoration(labelText: L(context, 'Подробнее'), alignLabelWithHint: true, hintText: L(context, 'Где, когда, что уже пробовали'))),
          const Gap(6),
          Text(category == 'REPAIR' ? L(context, 'Сотрудники увидят вашу комнату, чтобы прийти починить, но не ваше имя.') : L(context, 'Сотрудники не увидят ваше имя и комнату.'), style: Theme.of(context).textTheme.bodySmall),
          if (error != null) ...[const Gap(12), Text(error!, style: manrope(14, FontWeight.w600, color: Brand.red))],
          const Gap(18),
          FilledButton.icon(onPressed: busy ? null : send, icon: const Icon(Icons.send_rounded), label: Text(L(context, 'Отправить'))),
        ]),
      );
}

/// Version line plus a manual "Проверить обновления" button. The app also updates itself in the background;
/// this is for when that has not happened yet (the owner asked for a manual check as a fallback).
class _AppVersionCard extends StatefulWidget {
  const _AppVersionCard();
  @override
  State<_AppVersionCard> createState() => _AppVersionCardState();
}

class _AppVersionCardState extends State<_AppVersionCard> {
  bool busy = false;
  Future<void> _check() async {
    setState(() => busy = true);
    try { await checkForUpdateNow(context); } finally { if (mounted) setState(() => busy = false); }
  }

  @override
  Widget build(BuildContext context) => AppCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            const IconChip(Icons.info_outline_rounded, tone: Tone.gray),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Ijara360', style: manrope(15, FontWeight.w700)),
              Text('${L(context, 'Версия')} $appVersionLabel', maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall),
            ])),
          ]),
          if (updatesSupported) ...[
            const Gap(12),
            OutlinedButton.icon(
              onPressed: busy ? null : _check,
              icon: busy
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.4))
                  : const Icon(Icons.system_update_rounded, size: 20),
              label: Text(busy ? L(context, 'Проверяем…') : L(context, 'Проверить обновления')),
            ),
          ],
        ]),
      );
}

/// A ticket thread. Tenants and staff use the same screen; staff with TICKETS_MANAGE get status buttons.
class TicketScreen extends StatefulWidget {
  const TicketScreen({super.key, required this.id});
  final String id;
  @override
  State<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends State<TicketScreen> {
  final reply = TextEditingController();
  bool busy = false;
  @override
  void dispose() { reply.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    final path = s.isStaff ? '/tickets/${widget.id}' : '/tenant/tickets/${widget.id}';
    return Scaffold(
      appBar: AppBar(title: Text(L(context, 'Обращение'))),
      body: LiveData<Map<String, dynamic>>(
        topics: const {'tickets'},
        load: () async => (await s.api.get(path)) as Map<String, dynamic>,
        builder: (context, t, refresh) {
          final open = t['status'] == 'OPEN' || t['status'] == 'IN_PROGRESS';
          final thread = ((s.isStaff ? t['thread'] : t['messages']) as List).cast<Map<String, dynamic>>();
          final canReply = s.isStaff ? s.can('TICKETS_MANAGE') : true;
          final (label, tone) = ticketStatus('${t['status']}');
          Future<void> run(Future<void> Function() fn) async {
            setState(() => busy = true);
            try { await fn(); await refresh(); } on ApiException catch (e) { if (context.mounted) toast(context, e.message); } finally { if (mounted) setState(() => busy = false); }
          }
          return Column(children: [
            Expanded(child: PageBody(maxWidth: 760, onRefresh: refresh, children: [
              Row(children: [StatusPill(L(context, label), tone: tone), const SizedBox(width: 8), Text('${L(context, ticketCategory[t['category']] ?? '')}${t['room'] != null ? ' · ${L(context, 'комната')} ${t['room']}' : ''}', style: Theme.of(context).textTheme.bodySmall)]),
              const Gap(10),
              Text('${t['title']}', style: Theme.of(context).textTheme.headlineSmall),
              if (s.isStaff) ...[
                const Gap(8),
                t['author'] != null
                    ? Text('Автор: ${(t['author'] as Map)['fullName']}', style: manrope(14, FontWeight.w700))
                    : const StatusPill('Автор скрыт — его видит только владелец', tone: Tone.gray),
              ],
              const Gap(16),
              for (final m in thread) _Bubble(m),
              if (s.isStaff && s.can('TICKETS_MANAGE')) ...[
                const Gap(8),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  if (t['status'] == 'OPEN') OutlinedButton(onPressed: busy ? null : () => run(() async { await s.api.patch(path, {'status': 'IN_PROGRESS', 'version': t['version']}); }), child: const Text('Взять в работу')),
                  if (open) OutlinedButton(onPressed: busy ? null : () => run(() async { await s.api.patch(path, {'status': 'RESOLVED', 'version': t['version']}); }), child: const Text('Решено')),
                  if (open) OutlinedButton(onPressed: busy ? null : () => run(() async { await s.api.patch(path, {'status': 'REJECTED', 'version': t['version']}); }), child: const Text('Отклонить')),
                  if (!open) OutlinedButton(onPressed: busy ? null : () => run(() async { await s.api.patch(path, {'status': 'OPEN', 'version': t['version']}); }), child: const Text('Открыть снова')),
                ]),
              ],
              if (!open) ...[const Gap(12), Text(s.isStaff ? 'Обращение закрыто.' : L(context, 'Обращение закрыто. Если вопрос остался — создайте новое.'), style: Theme.of(context).textTheme.bodySmall)],
            ])),
            if (open && canReply)
              SafeArea(top: false, child: Container(
                color: Brand.white,
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                child: Row(children: [
                  Expanded(child: TextField(controller: reply, minLines: 1, maxLines: 4, maxLength: 4000, decoration: InputDecoration(counterText: '', hintText: s.isStaff ? 'Ответ жильцу' : L(context, 'Сообщение')))),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    tooltip: L(context, 'Отправить'),
                    style: IconButton.styleFrom(backgroundColor: Brand.blue, foregroundColor: Brand.white, minimumSize: const Size(52, 52)),
                    onPressed: busy ? null : () { final text = reply.text.trim(); if (text.isEmpty) return; run(() async { await s.api.post('$path/messages', {'body': text}); reply.clear(); }); },
                    icon: const Icon(Icons.send_rounded),
                  ),
                ]),
              )),
          ]);
        },
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble(this.m);
  final Map<String, dynamic> m;
  @override
  Widget build(BuildContext context) {
    final staff = m['author'] == 'STAFF';
    final mine = SessionScope.of(context).isStaff ? staff : !staff;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * .78),
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
          decoration: BoxDecoration(
            color: mine ? Brand.blue : Brand.white,
            borderRadius: BorderRadius.only(topLeft: const Radius.circular(18), topRight: const Radius.circular(18), bottomLeft: Radius.circular(mine ? 18 : 4), bottomRight: Radius.circular(mine ? 4 : 18)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${m['name']} · ${dayTime(m['createdAt'])}', style: manrope(11.5, FontWeight.w700, color: mine ? const Color(0xFFDCE6FF) : Brand.gray500)),
            const Gap(4),
            Text('${m['body']}', style: manrope(15, FontWeight.w500, height: 1.45, color: mine ? Brand.white : Brand.ink)),
          ]),
        ),
      ),
    );
  }
}

// ---------- Profile and devices ----------
const platformLabel = {'WEB': 'Браузер', 'ANDROID': 'Android', 'IOS': 'iPhone', 'WINDOWS': 'Windows'};

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, this.extra = const []});
  final List<Widget> extra;
  @override
  Widget build(BuildContext context) {
    final s = SessionScope.of(context);
    final sessions = s.isStaff ? '/auth/sessions' : '/tenant/sessions';
    return Scaffold(
      appBar: AppBar(title: Text(L(context, 'Профиль'))),
      body: LiveData<List<dynamic>>(
        load: () async => (await s.api.get(sessions)) as List<dynamic>,
        builder: (context, list, refresh) => PageBody(maxWidth: 760, onRefresh: refresh, children: [
          AppCard(child: Row(children: [
            Avatar(s.fullName, size: 58),
            const SizedBox(width: 14),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s.fullName, style: Theme.of(context).textTheme.titleLarge),
              Text(s.phone, style: Theme.of(context).textTheme.bodySmall),
              const Gap(6),
              StatusPill(L(context, s.roleLabel), tone: s.role == Role.superAdmin ? Tone.ink : Tone.blue),
            ])),
          ])),
          // Residents choose the app language; staff always see Russian.
          if (s.role == Role.tenant) ...[
            const Gap(12),
            AppCard(child: Row(children: [
              const IconChip(Icons.language_rounded, tone: Tone.blue),
              const SizedBox(width: 12),
              Expanded(child: Text(L(context, 'Язык'), style: manrope(15, FontWeight.w700))),
              SegmentedButton<String>(
                showSelectedIcon: false,
                segments: const [ButtonSegment(value: 'ru', label: Text('RU')), ButtonSegment(value: 'uz', label: Text('UZ'))],
                selected: {s.lang},
                onSelectionChanged: (v) => s.setLang(v.first),
              ),
            ])),
          ],
          ...extra,
          SectionTitle(L(context, 'Мои устройства')),
          for (final d in list.cast<Map<String, dynamic>>()) Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: AppCard(child: Row(children: [
              IconChip(d['platform'] == 'WEB' ? Icons.laptop_rounded : Icons.phone_android_rounded, tone: d['current'] == true ? Tone.blue : Tone.gray),
              const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${d['deviceName'] ?? L(context, platformLabel[d['platform']] ?? '')}', maxLines: 1, overflow: TextOverflow.ellipsis, style: manrope(15, FontWeight.w700)),
                Text(d['current'] == true ? L(context, 'Это устройство') : '${L(context, 'Активность')} ${dayTime(d['lastSeenAt'] ?? d['createdAt'])}', maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall),
              ])),
              if (d['current'] != true) TextButton(onPressed: () async {
                try { await s.api.delete('${s.isStaff ? '/auth/sessions' : '/tenant/sessions'}/${d['id']}'); await refresh(); if (context.mounted) toast(context, L(context, 'Устройство вышло из приложения')); }
                on ApiException catch (e) { if (context.mounted) toast(context, e.message); }
              }, child: Text(L(context, 'Завершить'))),
            ])),
          ),
          const Gap(20),
          SectionTitle(L(context, 'О приложении')),
          const _AppVersionCard(),
          const Gap(20),
          OutlinedButton.icon(
            onPressed: () async {
              final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
                title: Text(L(context, 'Выйти из приложения?')),
                actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: Text(L(context, 'Отмена'))), FilledButton(onPressed: () => Navigator.pop(d, true), child: Text(L(context, 'Выйти')))],
              ));
              if (ok == true) await s.logout();
            },
            icon: const Icon(Icons.logout_rounded),
            label: Text(L(context, 'Выйти')),
          ),
          const Gap(16),
          Center(child: Image.asset('assets/brand/logo.png', height: 26, semanticLabel: 'ijara360')),
        ]),
      ),
    );
  }
}
