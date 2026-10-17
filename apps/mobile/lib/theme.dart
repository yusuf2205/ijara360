import 'package:flutter/material.dart';

/// Brand tokens, v4 (owner mockups 2026-10-17): blue accent with white text on it, dark navy surfaces.
/// The owner's logo stays as it is.
class Brand {
  static const blue = Color(0xFF1F6BFF);
  static const blueDark = Color(0xFF1557E0);
  static const blueSoft = Color(0xFFEAF1FF);
  /// Blue that reads on [navy] (labels on dark cards).
  static const blueLight = Color(0xFF8FB0FF);
  static const navy = Color(0xFF0E1A3A);
  static const ink = Color(0xFF0F172A);
  static const white = Color(0xFFFFFFFF);
  static const bg = Color(0xFFF4F6FB);
  static const gray100 = Color(0xFFEEF2F8);
  static const gray300 = Color(0xFFCBD3E1);
  static const gray500 = Color(0xFF667085);
  static const line = Color(0xFFE3E8F0);
  // Meaning, not brand: debt / full, almost / overdue soon, free / paid.
  static const red = Color(0xFFE5484D);
  static const redSoft = Color(0xFFFDECEC);
  static const orange = Color(0xFFF08C1A);
  static const orangeSoft = Color(0xFFFEF2E2);
  static const green = Color(0xFF18A058);
  static const greenSoft = Color(0xFFE6F6EE);
}

/// Manrope ships as one variable font; the weight axis follows the requested weight.
TextStyle manrope(double size, FontWeight weight, {Color color = Brand.ink, double? height, double? spacing}) => TextStyle(
      fontFamily: 'Manrope',
      fontSize: size,
      fontWeight: weight,
      fontVariations: [FontVariation.weight(weight.value.toDouble())],
      color: color,
      height: height,
      letterSpacing: spacing,
    );

ThemeData buildTheme() {
  const scheme = ColorScheme(
    brightness: Brightness.light,
    primary: Brand.blue,
    onPrimary: Brand.white,
    secondary: Brand.ink,
    onSecondary: Brand.white,
    error: Brand.red,
    onError: Brand.white,
    surface: Brand.white,
    onSurface: Brand.ink,
  );
  final text = TextTheme(
    headlineLarge: manrope(30, FontWeight.w800, height: 1.15, spacing: -.6),
    headlineMedium: manrope(24, FontWeight.w800, height: 1.2, spacing: -.4),
    headlineSmall: manrope(20, FontWeight.w800, height: 1.25),
    titleLarge: manrope(18, FontWeight.w800),
    titleMedium: manrope(16, FontWeight.w700),
    titleSmall: manrope(14, FontWeight.w700),
    bodyLarge: manrope(16, FontWeight.w500, height: 1.5),
    bodyMedium: manrope(14, FontWeight.w500, height: 1.5),
    bodySmall: manrope(12, FontWeight.w500, color: Brand.gray500, height: 1.45),
    labelLarge: manrope(15, FontWeight.w700),
    labelMedium: manrope(12, FontWeight.w700),
    labelSmall: manrope(11, FontWeight.w700, spacing: .6),
  );
  final radius = BorderRadius.circular(14);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: Brand.bg,
    fontFamily: 'Manrope',
    textTheme: text,
    splashFactory: InkSparkle.splashFactory,
    appBarTheme: AppBarTheme(backgroundColor: Brand.bg, surfaceTintColor: Colors.transparent, elevation: 0, scrolledUnderElevation: 0, foregroundColor: Brand.ink, titleTextStyle: text.titleLarge, centerTitle: false),
    cardTheme: CardThemeData(color: Brand.white, elevation: 0, margin: EdgeInsets.zero, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18))),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(backgroundColor: Brand.blue, foregroundColor: Brand.white, minimumSize: const Size(48, 52), textStyle: text.labelLarge, shape: RoundedRectangleBorder(borderRadius: radius), elevation: 0)),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(foregroundColor: Brand.ink, minimumSize: const Size(48, 52), side: const BorderSide(color: Brand.gray300), textStyle: text.labelLarge, shape: RoundedRectangleBorder(borderRadius: radius), backgroundColor: Brand.white)),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: Brand.blue, textStyle: text.labelLarge)),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Brand.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      labelStyle: manrope(14, FontWeight.w600, color: Brand.gray500),
      floatingLabelStyle: manrope(14, FontWeight.w700, color: Brand.blue),
      border: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: Brand.gray300)),
      enabledBorder: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: Brand.gray300)),
      focusedBorder: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: Brand.blue, width: 2)),
      errorBorder: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: Brand.red)),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: Brand.white,
      // Mockup: the selected tab is blue icon and label without a pill.
      indicatorColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      height: 68,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => manrope(11, s.contains(WidgetState.selected) ? FontWeight.w800 : FontWeight.w600, color: s.contains(WidgetState.selected) ? Brand.blue : Brand.gray500)),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? Brand.blue : Brand.gray500, size: 24)),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: Brand.navy,
      indicatorColor: const Color(0xFF1C2B57),
      selectedIconTheme: const IconThemeData(color: Brand.white),
      unselectedIconTheme: const IconThemeData(color: Color(0xFFAEB9D6)),
      selectedLabelTextStyle: manrope(13, FontWeight.w800, color: Brand.white),
      unselectedLabelTextStyle: manrope(13, FontWeight.w600, color: const Color(0xFFAEB9D6)),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(style: ButtonStyle(
      backgroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? Brand.blue : Brand.white),
      foregroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? Brand.white : Brand.ink),
      side: const WidgetStatePropertyAll(BorderSide(color: Brand.gray300)),
      textStyle: WidgetStatePropertyAll(manrope(13, FontWeight.w700)),
    )),
    chipTheme: ChipThemeData(backgroundColor: Brand.white, selectedColor: Brand.blueSoft, side: const BorderSide(color: Brand.gray300), labelStyle: manrope(13, FontWeight.w700), shape: const StadiumBorder()),
    snackBarTheme: SnackBarThemeData(backgroundColor: Brand.ink, contentTextStyle: manrope(14, FontWeight.w600, color: Brand.white), behavior: SnackBarBehavior.floating, shape: RoundedRectangleBorder(borderRadius: radius)),
    dividerTheme: const DividerThemeData(color: Brand.line, space: 1, thickness: 1),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: Brand.blue, linearTrackColor: Brand.gray100),
    bottomSheetTheme: const BottomSheetThemeData(backgroundColor: Brand.white, surfaceTintColor: Colors.transparent, showDragHandle: true),
    dialogTheme: DialogThemeData(backgroundColor: Brand.white, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20))),
  );
}
