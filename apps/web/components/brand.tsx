/**
 * Ijara360 brand mark: the "i" (dot and stem) runs into the "j" bowl, which carries a house with a yellow roof.
 * Drawn on a 96×96 grid so it stays crisp from a favicon to the login page.
 */
export function LogoMark({ size = 40, ink = '#111111', roof = '#FEC123', title }: { size?: number; ink?: string; roof?: string; title?: string }) {
  return <svg width={size} height={size} viewBox="0 0 96 96" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} className="logo-mark">
    <circle cx="21" cy="14" r="10" fill={ink}/>
    <path d="M21 30V58a25 25 0 0 0 50 0V40" fill="none" stroke={ink} strokeWidth="18"/>
    <path d="M33 46 57 25l23 20" fill="none" stroke={roof} strokeWidth="12" strokeLinejoin="miter" strokeLinecap="butt"/>
    <g fill={ink}><rect x="43" y="50" width="8" height="8"/><rect x="53" y="50" width="8" height="8"/><rect x="43" y="60" width="8" height="8"/><rect x="53" y="60" width="8" height="8"/></g>
  </svg>;
}

/** Full logo: the mark stands for "ij", followed by "ara36" and an "0" with the yellow centre. */
export function Logo({ size = 34, light = false, className = '' }: { size?: number; light?: boolean; className?: string }) {
  const ink = light ? '#FFFFFF' : '#111111';
  return <span className={`logo ${light ? 'logo-light' : ''} ${className}`} style={{ fontSize: size * 0.9 }} aria-label="ijara360" role="img">
    <LogoMark size={size} ink={ink}/>
    <span className="logo-word" aria-hidden="true">ara36<span className="logo-o"/></span>
  </span>;
}
