import 'package:flutter/material.dart';

import '../theme.dart';
import 'kit.dart';

class Destination {
  const Destination(this.label, this.icon, this.selectedIcon, this.builder, {this.badge});
  final String label;
  final IconData icon;
  final IconData selectedIcon;
  final WidgetBuilder builder;
  final int? badge;
}

/// One navigation model, three layouts:
/// phone (<600) bottom bar with up to five tabs (the rest under "Ещё"),
/// tablet (600–1100) dark rail, desktop (≥1100) extended dark rail with the logo.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.destinations, this.header});
  final List<Destination> destinations;
  final Widget? header;
  /// Switches to another section from inside a page (for example a tile on the home screen).
  static void go(BuildContext context, int index) => context.findAncestorStateOfType<_AppShellState>()?.select(index);
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int index = 0;
  final _keys = <int, GlobalKey<NavigatorState>>{};

  GlobalKey<NavigatorState> _key(int i) => _keys.putIfAbsent(i, () => GlobalKey<NavigatorState>());

  void select(int i) {
    if (i == index) { _key(i).currentState?.popUntil((r) => r.isFirst); return; }
    setState(() => index = i);
  }

  /// Each section keeps its own back stack, so switching tabs does not lose an open detail page.
  Widget _section(int i) => Navigator(
        key: _key(i),
        onGenerateRoute: (_) => MaterialPageRoute(builder: widget.destinations[i].builder),
      );

  String _spoken(Destination d) => (d.badge ?? 0) > 0 ? '${d.label}, новых: ${d.badge}' : d.label;

  Widget _badge(Destination d, IconData icon) => d.badge != null && d.badge! > 0
      ? Badge(label: Text(d.badge! > 99 ? '99+' : '${d.badge}'), backgroundColor: Brand.ink, textColor: Brand.white, child: Icon(icon))
      : Icon(icon);

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final d = widget.destinations;
    // Each section's Navigator blocks the semantics of widgets painted before it in the same container;
    // a container of its own keeps the side menu visible to screen readers.
    final body = Semantics(container: true, explicitChildNodes: true, child: IndexedStack(index: index, children: [for (var i = 0; i < d.length; i++) _section(i)]));
    if (width < 600) {
      final tabs = d.length <= 5 ? d.length : 4;
      final inMore = index >= tabs;
      return PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) async {
          if (didPop) return;
          final popped = await _key(index).currentState?.maybePop() ?? false;
          if (!popped && index != 0) setState(() => index = 0);
        },
        child: Scaffold(
          body: SafeArea(bottom: false, child: body),
          bottomNavigationBar: _narrowLabels(context, NavigationBar(
            selectedIndex: inMore ? tabs : index,
            onDestinationSelected: (i) => i == tabs && d.length > 5 ? _more(context, tabs) : select(i),
            destinations: [
              for (var i = 0; i < tabs; i++) NavigationDestination(icon: _badge(d[i], d[i].icon), selectedIcon: _badge(d[i], d[i].selectedIcon), label: d[i].label),
              if (d.length > 5) NavigationDestination(icon: _badge(Destination('Ещё', Icons.more_horiz, Icons.more_horiz, (_) => const SizedBox(), badge: d.skip(tabs).fold<int>(0, (s, x) => s + (x.badge ?? 0))), Icons.more_horiz_rounded), label: 'Ещё'),
            ],
          )),
        ),
      );
    }
    final extended = width >= 1100;
    return Scaffold(
      body: Row(children: [
        NavigationRail(
          extended: extended,
          labelType: extended ? NavigationRailLabelType.none : NavigationRailLabelType.all,
          minExtendedWidth: 236,
          selectedIndex: index,
          onDestinationSelected: select,
          leading: Padding(
            padding: const EdgeInsets.fromLTRB(8, 18, 8, 22),
            child: extended ? Image.asset('assets/brand/logo-light.png', height: 40, semanticLabel: 'ijara360') : Image.asset('assets/brand/app-icon-512.png', height: 44, semanticLabel: 'ijara360'),
          ),
          trailing: widget.header,
          // The rail does not announce its labels on web/desktop; name each item explicitly for screen readers.
          destinations: [for (var i = 0; i < d.length; i++) NavigationRailDestination(
            icon: Semantics(label: _spoken(d[i]), button: true, selected: false, child: ExcludeSemantics(child: _badge(d[i], d[i].icon))),
            selectedIcon: Semantics(label: _spoken(d[i]), button: true, selected: true, child: ExcludeSemantics(child: _badge(d[i], d[i].selectedIcon))),
            label: ExcludeSemantics(child: Text(d[i].label)),
          )],
        ),
        Expanded(child: SafeArea(child: body)),
      ]),
    );
  }

  void _more(BuildContext context, int first) => showModalBottomSheet(
        context: context,
        builder: (sheet) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              for (var i = first; i < widget.destinations.length; i++)
                ListTile(
                  leading: IconChip(widget.destinations[i].icon, tone: i == index ? Tone.blue : Tone.gray),
                  title: Text(widget.destinations[i].label, style: manrope(16, FontWeight.w700)),
                  trailing: (widget.destinations[i].badge ?? 0) > 0 ? StatusPill('${widget.destinations[i].badge}', tone: Tone.blue) : const Icon(Icons.chevron_right_rounded),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  onTap: () { Navigator.pop(sheet); select(i); },
                ),
            ]),
          ),
        ),
      );
}

/// Small phones (under 360 dp, e.g. 640 px at 2x): five labels of 11 px do not fit, and "Обращения" broke
/// in the middle of the word. Slightly smaller, tighter labels keep every label on one line.
Widget _narrowLabels(BuildContext context, Widget bar) {
  if (MediaQuery.sizeOf(context).width >= 360) return bar;
  final theme = Theme.of(context);
  final base = theme.navigationBarTheme.labelTextStyle;
  return Theme(
    data: theme.copyWith(navigationBarTheme: theme.navigationBarTheme.copyWith(
      labelTextStyle: WidgetStateProperty.resolveWith((s) => base?.resolve(s)?.copyWith(fontSize: 9.5, letterSpacing: -0.3)),
    )),
    child: bar,
  );
}
