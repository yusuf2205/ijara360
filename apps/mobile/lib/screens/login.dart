import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/client.dart';
import '../session.dart';
import '../theme.dart';
import '../ui/kit.dart';

/// One door for everyone: residents and staff pick who they are, then phone and password.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final phone = TextEditingController();
  final password = TextEditingController();
  Audience who = Audience.tenant;
  bool remember = true;
  bool hidden = true;
  bool busy = false;
  String? error;

  @override
  void dispose() { phone.dispose(); password.dispose(); super.dispose(); }

  Future<void> submit() async {
    if (phone.text.trim().isEmpty || password.text.isEmpty) { setState(() => error = 'Введите телефон и пароль.'); return; }
    setState(() { busy = true; error = null; });
    final session = SessionScope.of(context);
    try {
      final approval = who == Audience.tenant
          ? await session.loginTenant(phone.text.trim(), password.text, remember: remember)
          : await session.loginStaff(phone.text.trim(), password.text, remember: remember);
      if (approval != null && mounted) {
        final ok = await Navigator.of(context).push<bool>(MaterialPageRoute(fullscreenDialog: true, builder: (_) => ApprovalScreen(approval: approval)));
        if (ok != true && mounted) setState(() => error = 'Вход не подтверждён. Попробуйте снова.');
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final form = _form(context);
    return Scaffold(
      backgroundColor: wide ? Brand.navy : Brand.bg,
      body: SafeArea(
        child: wide
            ? Row(children: [
                Expanded(child: _story()),
                Expanded(child: Container(color: Brand.bg, child: Center(child: SingleChildScrollView(padding: const EdgeInsets.all(40), child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 420), child: form))))),
              ])
            : Center(child: SingleChildScrollView(padding: const EdgeInsets.fromLTRB(20, 24, 20, 24), child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 440), child: form))),
      ),
    );
  }

  Widget _story() => Padding(
        padding: const EdgeInsets.all(48),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Image.asset('assets/brand/logo-light.png', height: 58, semanticLabel: 'ijara360'),
          const Spacer(),
          Text('ВАШ ДОМ. ВСЁ НА СВОИХ МЕСТАХ.', style: manrope(12, FontWeight.w800, color: Brand.blueLight, spacing: 1.6)),
          const Gap(16),
          Text('Меньше записей.\nБольше порядка.', style: manrope(44, FontWeight.w800, color: Brand.white, height: 1.15, spacing: -1.2)),
          const Gap(16),
          Text('Жильцы видят оплаты и обращения, сотрудники — весь дом. С телефона, планшета или компьютера.', style: manrope(16, FontWeight.w500, color: const Color(0xFFB9B9BE), height: 1.6)),
          const Spacer(flex: 2),
        ]),
      );

  Widget _form(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return AutofillGroup(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Align(alignment: Alignment.centerLeft, child: Image.asset('assets/brand/logo.png', height: 46, semanticLabel: 'ijara360')),
        const Gap(28),
        Text('Вход', style: t.headlineLarge),
        const Gap(6),
        Text(who == Audience.tenant ? 'Для жильцов: номер телефона и пароль, который вы задали по ссылке-приглашению.' : 'Для владельца и администраторов дома.', style: t.bodyMedium?.copyWith(color: Brand.gray500)),
        const Gap(22),
        SegmentedButton<Audience>(
          showSelectedIcon: false,
          segments: const [
            ButtonSegment(value: Audience.tenant, label: Text('Я жилец'), icon: Icon(Icons.bed_outlined)),
            ButtonSegment(value: Audience.staff, label: Text('Я сотрудник'), icon: Icon(Icons.badge_outlined)),
          ],
          selected: {who},
          onSelectionChanged: (s) => setState(() { who = s.first; error = null; }),
        ),
        const Gap(18),
        TextField(
          controller: phone,
          keyboardType: TextInputType.phone,
          autofillHints: const [AutofillHints.telephoneNumber, AutofillHints.username],
          textInputAction: TextInputAction.next,
          decoration: const InputDecoration(labelText: 'Телефон', hintText: '+998 90 123 45 67', prefixIcon: Icon(Icons.phone_iphone_rounded)),
        ),
        const Gap(12),
        TextField(
          controller: password,
          obscureText: hidden,
          autofillHints: const [AutofillHints.password],
          onSubmitted: (_) => submit(),
          decoration: InputDecoration(
            labelText: 'Пароль',
            prefixIcon: const Icon(Icons.lock_outline_rounded),
            suffixIcon: IconButton(tooltip: hidden ? 'Показать пароль' : 'Скрыть пароль', onPressed: () => setState(() => hidden = !hidden), icon: Icon(hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined)),
          ),
        ),
        const Gap(6),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          value: remember,
          activeTrackColor: Brand.blue,
          onChanged: (v) => setState(() => remember = v),
          title: Text('Запомнить меня на 30 дней', style: manrope(14, FontWeight.w600)),
        ),
        if (error != null) ...[
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: Brand.redSoft, borderRadius: BorderRadius.circular(14)),
            child: Semantics(liveRegion: true, child: Text(error!, style: manrope(14, FontWeight.w600, color: const Color(0xFF9B342E)))),
          ),
          const Gap(12),
        ],
        FilledButton(onPressed: busy ? null : submit, child: busy ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5)) : const Text('Войти')),
        const Gap(22),
        if (who == Audience.tenant)
          AppCard(
            color: Brand.blueSoft,
            onTap: () => launchUrl(Uri.parse('${apiOrigin()}/apply'), mode: LaunchMode.externalApplication),
            semanticLabel: 'Хочу заселиться: подать заявку',
            child: Row(children: [
              const IconChip(Icons.home_work_outlined, tone: Tone.ink),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Хочу заселиться', style: manrope(15, FontWeight.w800)),
                Text('Подайте заявку — это займёт 5 минут', style: t.bodySmall),
              ])),
              const Icon(Icons.arrow_forward_rounded),
            ]),
          )
        else
          const SizedBox.shrink(),
        if (kIsWeb) ...[
          const Gap(12),
          // The download page picks the device: APK on Android, home-screen install on iPhone/iPad, browser install on a computer.
          OutlinedButton.icon(
            onPressed: () => launchUrl(Uri.parse('${apiOrigin()}/download')),
            icon: const Icon(Icons.install_mobile_rounded),
            label: const Text('Установить приложение'),
          ),
        ],
        const Gap(14),
        Text(who == Audience.tenant ? 'Нет пароля? Попросите администрацию прислать приглашение.' : 'Забыли пароль? Обратитесь к владельцу дома.', textAlign: TextAlign.center, style: t.bodySmall),
      ]),
    );
  }
}

/// Waits for the "Это я" button in Telegram; the session appears only after it.
class ApprovalScreen extends StatefulWidget {
  const ApprovalScreen({super.key, required this.approval});
  final Approval approval;
  @override
  State<ApprovalScreen> createState() => _ApprovalScreenState();
}

class _ApprovalScreenState extends State<ApprovalScreen> {
  Timer? timer;
  String? error;
  int left = 0;

  @override
  void initState() { super.initState(); tick(); }

  Future<void> tick() async {
    if (!mounted) return;
    setState(() => left = widget.approval.expiresAt.difference(DateTime.now()).inSeconds.clamp(0, 600));
    try {
      if (await SessionScope.of(context).pollApproval(widget.approval)) { if (mounted) Navigator.pop(context, true); return; }
      timer = Timer(const Duration(seconds: 2), tick);
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    }
  }

  @override
  void dispose() { timer?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(leading: IconButton(tooltip: 'Отмена', icon: const Icon(Icons.close_rounded), onPressed: () => Navigator.pop(context, false))),
      body: PageBody(maxWidth: 460, children: [
        const Gap(20),
        Center(child: Container(width: 96, height: 96, decoration: const BoxDecoration(color: Brand.blue, shape: BoxShape.circle), child: const Icon(Icons.send_rounded, size: 44, color: Brand.white))),
        const Gap(24),
        Text(error == null ? (widget.approval.byOwner ? 'Ждём подтверждения владельца' : 'Подтвердите вход в Telegram') : 'Вход не выполнен', textAlign: TextAlign.center, style: t.headlineMedium),
        const Gap(10),
        Text(error ?? (widget.approval.byOwner ? 'Владелец получил запрос в Telegram. Как только он нажмёт «Разрешить», вход продолжится сам.' : 'Мы отправили сообщение от @ijara360bot. Нажмите в нём «Это я» — вход продолжится сам.'), textAlign: TextAlign.center, style: t.bodyLarge?.copyWith(color: Brand.gray500)),
        const Gap(24),
        if (error == null) ...[
          const LinearProgressIndicator(minHeight: 6, borderRadius: BorderRadius.all(Radius.circular(9))),
          const Gap(10),
          Text('Ждём ещё ${left ~/ 60}:${(left % 60).toString().padLeft(2, '0')}', textAlign: TextAlign.center, style: t.bodySmall),
        ],
        const Gap(28),
        OutlinedButton(onPressed: () => Navigator.pop(context, false), child: Text(error == null ? 'Отмена' : 'Назад ко входу')),
      ]),
    );
  }
}
