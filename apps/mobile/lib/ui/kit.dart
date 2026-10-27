import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../api/client.dart';
import '../session.dart';
import '../theme.dart';

/// Gives every screen the signed-in session.
class SessionScope extends InheritedNotifier<Session> {
  const SessionScope({super.key, required Session session, required super.child}) : super(notifier: session);
  static Session of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<SessionScope>()!.notifier!;
}

// Formatting in Uzbekistan's convention: "1 200 000 сум", dates in Tashkent.
final _money = NumberFormat.decimalPattern('ru');
String sum(Object? v) {
  final n = v is num ? v : num.tryParse('${v ?? 0}') ?? 0;
  return '${_money.format(n.round()).replaceAll(' ', ' ')} сум';
}
DateTime _tashkent(DateTime d) => d.toUtc().add(const Duration(hours: 5));
String day(Object? iso) => iso == null ? '—' : DateFormat('d MMMM', 'ru').format(DateTime.parse('$iso').toUtc());
String dayTime(Object? iso) => iso == null ? '—' : DateFormat('d MMM, HH:mm', 'ru').format(_tashkent(DateTime.parse('$iso')));
String longDate(DateTime t) => DateFormat('d MMMM y', 'ru').format(_tashkent(t));
String greeting() {
  final h = _tashkent(DateTime.now()).hour;
  return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
}

enum Tone { blue, red, orange, green, gray, ink }
(Color, Color) toneColors(Tone t) => switch (t) {
      Tone.blue => (Brand.blueSoft, Brand.blue),
      Tone.red => (Brand.redSoft, Brand.red),
      Tone.orange => (Brand.orangeSoft, Brand.orange),
      Tone.green => (Brand.greenSoft, Brand.green),
      Tone.gray => (Brand.gray100, Brand.ink),
      Tone.ink => (Brand.ink, Brand.white),
    };

/// Centered column with a comfortable reading width on tablets and desktops.
class PageBody extends StatelessWidget {
  const PageBody({super.key, required this.children, this.maxWidth = 1120, this.onRefresh});
  final List<Widget> children;
  final double maxWidth;
  final Future<void> Function()? onRefresh;
  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 600;
    final list = ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.fromLTRB(wide ? 28 : 16, 8, wide ? 28 : 16, 32),
      children: [Center(child: ConstrainedBox(constraints: BoxConstraints(maxWidth: maxWidth), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children)))],
    );
    return onRefresh == null ? list : RefreshIndicator(color: Brand.white, backgroundColor: Brand.blue, onRefresh: onRefresh!, child: list);
  }
}

class Gap extends StatelessWidget {
  const Gap(this.size, {super.key});
  final double size;
  @override
  Widget build(BuildContext context) => SizedBox(height: size, width: size);
}

class AppCard extends StatelessWidget {
  const AppCard({super.key, required this.child, this.onTap, this.padding = const EdgeInsets.all(18), this.color = Brand.white, this.semanticLabel});
  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding;
  final Color color;
  final String? semanticLabel;
  @override
  Widget build(BuildContext context) {
    final card = Material(
      color: color,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(borderRadius: BorderRadius.circular(18), onTap: onTap, child: Padding(padding: padding, child: child)),
    );
    final shadowed = DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(18), boxShadow: const [BoxShadow(color: Color(0x0D111111), blurRadius: 18, offset: Offset(0, 6))]),
      child: card,
    );
    return semanticLabel == null ? shadowed : Semantics(button: onTap != null, label: semanticLabel, child: shadowed);
  }
}

class IconChip extends StatelessWidget {
  const IconChip(this.icon, {super.key, this.tone = Tone.blue, this.size = 40});
  final IconData icon;
  final Tone tone;
  final double size;
  @override
  Widget build(BuildContext context) {
    final (bg, fg) = toneColors(tone);
    return Container(width: size, height: size, decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(size * .3)), child: Icon(icon, color: fg, size: size * .52));
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill(this.text, {super.key, this.tone = Tone.green});
  final String text;
  final Tone tone;
  @override
  Widget build(BuildContext context) {
    final (bg, fg) = toneColors(tone);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 6, height: 6, decoration: BoxDecoration(color: fg, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Text(text, style: manrope(12, FontWeight.w700, color: fg)),
      ]),
    );
  }
}

class Kpi extends StatelessWidget {
  const Kpi({super.key, required this.icon, required this.value, required this.label, this.tone = Tone.blue, this.onTap});
  final IconData icon;
  final String value;
  final String label;
  final Tone tone;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => AppCard(
        onTap: onTap,
        semanticLabel: '$label: $value',
        padding: const EdgeInsets.all(14),
        child: ExcludeSemantics(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [IconChip(icon, tone: tone, size: 34), const SizedBox(width: 10), Flexible(child: FittedBox(fit: BoxFit.scaleDown, child: Text(value, style: manrope(24, FontWeight.w800))))]),
          const SizedBox(height: 8),
          Text(label, maxLines: 2, overflow: TextOverflow.ellipsis, style: manrope(12, FontWeight.w600, color: Brand.gray500)),
        ])),
      );
}

/// Mockup tile: the whole card tinted by meaning, icon on a light square, small label over a big value.
class ColorTile extends StatelessWidget {
  const ColorTile({super.key, required this.icon, required this.value, required this.label, this.tone = Tone.blue, this.onTap});
  final IconData icon;
  final String value;
  final String label;
  final Tone tone;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final (bg, fg) = toneColors(tone);
    return AppCard(
      onTap: onTap,
      color: bg,
      semanticLabel: '$label: $value',
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      child: ExcludeSemantics(child: Row(children: [
        Container(width: 38, height: 38, alignment: Alignment.center, decoration: BoxDecoration(color: Brand.white.withValues(alpha: .7), borderRadius: BorderRadius.circular(11)), child: Icon(icon, size: 20, color: fg)),
        const SizedBox(width: 10),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // Shrinks rather than cuts: on 320 dp phones "Не оплатили" ended as "Не оплат…".
          FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(label, maxLines: 1, style: manrope(11.5, FontWeight.w600, color: fg))),
          FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(value, style: manrope(20, FontWeight.w800, color: tone == Tone.orange ? fg : Brand.ink))),
        ])),
      ])),
    );
  }
}

/// Columns that follow the width: 2 on phones, 3–4 on tablets, up to [max] on desktops.
class TileGrid extends StatelessWidget {
  const TileGrid({super.key, required this.children, this.minTile = 150, this.max = 6, this.spacing = 12});
  final List<Widget> children;
  final double minTile;
  final int max;
  final double spacing;
  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, c) {
        final cols = (c.maxWidth / minTile).floor().clamp(2, max);
        final w = (c.maxWidth - spacing * (cols - 1)) / cols;
        return Wrap(spacing: spacing, runSpacing: spacing, children: [for (final child in children) SizedBox(width: w, child: child)]);
      });
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key, this.action, this.onAction});
  final String title;
  final String? action;
  final VoidCallback? onAction;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 22, bottom: 10),
        child: Row(children: [
          Expanded(child: Semantics(header: true, child: Text(title, style: Theme.of(context).textTheme.titleLarge))),
          if (action != null) TextButton(onPressed: onAction, child: Text(action!)),
        ]),
      );
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.text});
  final IconData icon;
  final String title;
  final String? text;
  @override
  Widget build(BuildContext context) => AppCard(
        padding: const EdgeInsets.symmetric(vertical: 34, horizontal: 20),
        child: Column(children: [
          IconChip(icon, tone: Tone.gray, size: 56),
          const SizedBox(height: 14),
          Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
          if (text != null) ...[const SizedBox(height: 6), Text(text!, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall)],
        ]),
      );
}

class Avatar extends StatelessWidget {
  const Avatar(this.name, {super.key, this.size = 44});
  final String name;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: const BoxDecoration(color: Brand.blue, shape: BoxShape.circle),
        child: Text(name.isEmpty ? '·' : name.characters.first.toUpperCase(), style: manrope(size * .4, FontWeight.w800, color: Brand.white)),
      );
}

class KeyValue extends StatelessWidget {
  const KeyValue(this.label, this.value, {super.key, this.valueColor});
  final String label;
  final String value;
  final Color? valueColor;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Text(label, style: manrope(14, FontWeight.w500, color: Brand.gray500))),
          const SizedBox(width: 12),
          Flexible(child: Text(value, textAlign: TextAlign.end, style: manrope(14, FontWeight.w700, color: valueColor ?? Brand.ink))),
        ]),
      );
}

void toast(BuildContext context, String text) => ScaffoldMessenger.of(context)..hideCurrentSnackBar()..showSnackBar(SnackBar(content: Text(text)));

/// Loads data, shows a calm skeleton, a clear error with "Повторить", and refetches on live events.
class LiveData<T> extends StatefulWidget {
  const LiveData({super.key, required this.load, required this.builder, this.topics = const {}});
  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, Future<void> Function() refresh) builder;
  final Set<String> topics;
  @override
  State<LiveData<T>> createState() => _LiveDataState<T>();
}

class _LiveDataState<T> extends State<LiveData<T>> {
  T? data;
  Object? error;
  StreamSubscription<String>? sub;
  Timer? debounce;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (sub == null) {
      final session = SessionScope.of(context);
      sub = session.realtime.topics.listen((t) {
        if (t == 'resync' || widget.topics.contains(t)) { debounce?.cancel(); debounce = Timer(const Duration(milliseconds: 250), refresh); }
      });
      refresh();
    }
  }

  Future<void> refresh() async {
    try {
      final next = await widget.load();
      if (mounted) setState(() { data = next; error = null; });
    } catch (e) {
      if (e is ApiException && e.status == 401 && mounted) { await SessionScope.of(context).expired(); return; }
      if (mounted) setState(() => error = e);
    }
  }

  @override
  void dispose() { sub?.cancel(); debounce?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    if (data != null) return widget.builder(context, data as T, refresh);
    if (error != null) {
      return PageBody(children: [
        const Gap(40),
        EmptyState(icon: Icons.wifi_off_rounded, title: 'Не удалось загрузить', text: '$error'),
        const Gap(14),
        Center(child: FilledButton.icon(onPressed: () { setState(() => error = null); refresh(); }, icon: const Icon(Icons.refresh_rounded), label: const Text('Повторить'))),
      ]);
    }
    return const _Skeleton();
  }
}

class _Skeleton extends StatelessWidget {
  const _Skeleton();
  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Загружаем',
        child: PageBody(children: [
          for (final h in [70.0, 120.0, 180.0, 120.0]) ...[Container(height: h, decoration: BoxDecoration(color: Brand.gray100, borderRadius: BorderRadius.circular(18))), const Gap(14)],
        ]),
      );
}

/// Opens a detail page; on phones it slides in full screen, on wide screens it stays a page too.
Future<T?> openPage<T>(BuildContext context, Widget page) => Navigator.of(context).push<T>(MaterialPageRoute(builder: (_) => page));
