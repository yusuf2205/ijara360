/* eslint-disable @next/next/no-img-element -- static brand files, already sized; no optimisation needed */
/**
 * The owner's logo, cut from the approved brand board (docs/BRAND.md). `logo.png` for light surfaces,
 * `logo-light.png` (white letters) for the dark sidebar and login panel, `mark.png` for the symbol alone.
 */
const RATIO = { logo: 980 / 260, light: 445 / 133, mark: 0.87 };

export function Logo({ size = 34, light = false, className = '' }: { size?: number; light?: boolean; className?: string }) {
  const width = Math.round(size * (light ? RATIO.light : RATIO.logo));
  return <img className={`logo ${className}`} src={light ? '/brand/logo-light.png' : '/brand/logo.png'} alt="ijara360" width={width} height={size}/>;
}

export function LogoMark({ size = 40 }: { size?: number }) {
  return <img className="logo-mark" src="/brand/mark.png" alt="" aria-hidden="true" width={Math.round(size * RATIO.mark)} height={size}/>;
}
