import type { ReactElement, SVGProps } from "react";

/**
 * Inline single-colour icons drawn with `currentColor` so they inherit the
 * surrounding text colour exactly. These replace typed Unicode glyphs (✕ ✓ ▼ ▶ ◀ ↗)
 * and two CSS-span constructions, all of which rendered at a size unrelated to the
 * text beside them.
 *
 * Each icon is drawn like a glyph rather than a picture. The 24-unit viewBox is an
 * em box; the baseline sits at y=20, and every icon's *rendered* ink — the
 * skeleton plus half its stroke on each side — is fitted to the ink box measured off
 * the glyph it replaces in this app's UI font. A skeleton drawn to that box instead
 * renders oversized and hangs half a stroke below the baseline, which reads as broken
 * alignment beside capitals.
 *
 * Call sites set nothing: no size, no offset, no margin. `1em` ties the icon to the
 * font size of its own control, and `vertical-align: -0.1667em` puts the art's baseline on
 * the text baseline (CSS aligns an inline SVG's box *bottom*, not its art). An icon
 * that needs adjusting at the call site has failed its metrics; fix the art.
 *
 * `plus` and `menu` stand alone in icon-only buttons, so they are centred in the em box
 * rather than baseline-anchored. Both buttons are flex containers, where `vertical-align`
 * is inert — so one component serves inline and standalone use without a variant.
 *
 * `data-icon` names the shape in the DOM. It is what tells a test which chevron a
 * disclosure toggle is showing, since the art itself is `aria-hidden`.
 *
 * The set and the sheet that validates it are `company/tools/icon-specimen`.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

const BASELINE_SHIFT = "-0.1667em";

function IconBase({ children, style, ...props }: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ verticalAlign: BASELINE_SHIFT, ...style }}
      {...props}
    >
      {children}
    </svg>
  );
}

/** Replaces the typed ✕ glyph. */
export function XIcon(props: IconProps): ReactElement {
  return (
    <IconBase data-icon="x" {...props}>
      <path d="M19.35 4.30L4.65 19.00" />
      <path d="M4.65 4.30L19.35 19.00" />
    </IconBase>
  );
}

/** Replaces the typed ✓ glyph. */
export function CheckIcon(props: IconProps): ReactElement {
  return (
    <IconBase data-icon="check" {...props}>
      <path d="M19.05 5.58L9.60 19.00L4.95 13.20" />
    </IconBase>
  );
}

/** Replaces the typed ▼ glyph. */
export function ChevronDownIcon(props: IconProps): ReactElement {
  return (
    <IconBase data-icon="chevron-down" {...props}>
      <path d="M4.67 6.12L12.00 16.96L19.33 6.12" />
    </IconBase>
  );
}

/** Replaces the typed ◀ glyph. */
export function ChevronLeftIcon(props: IconProps): ReactElement {
  return (
    <IconBase data-icon="chevron-left" {...props}>
      <path d="M17.42 4.21L6.58 11.54L17.42 18.87" />
    </IconBase>
  );
}

/** Replaces the typed ▶ glyph. */
export function ChevronRightIcon(props: IconProps): ReactElement {
  return (
    <IconBase data-icon="chevron-right" {...props}>
      <path d="M6.58 4.21L17.42 11.54L6.58 18.87" />
    </IconBase>
  );
}

/** Replaces the typed ↗ glyph. */
export function ExternalLinkIcon(props: IconProps): ReactElement {
  return (
    <IconBase data-icon="external-link" {...props}>
      <path d="M15.90 12.50L15.90 19.00L5.50 19.00L5.50 8.60L12.00 8.60" />
      <path d="M13.30 5.57L18.50 5.57L18.50 10.77" />
      <path d="M18.50 5.57L11.13 12.93" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps): ReactElement {
  return (
    <IconBase data-icon="plus" {...props}>
      <path d="M5.25 11.54L18.75 11.54" />
      <path d="M12.00 4.79L12.00 18.29" />
    </IconBase>
  );
}

export function MenuIcon(props: IconProps): ReactElement {
  return (
    <IconBase data-icon="menu" {...props}>
      <path d="M4.55 6.88L19.45 6.88" />
      <path d="M4.55 11.54L19.45 11.54" />
      <path d="M4.55 16.20L19.45 16.20" />
    </IconBase>
  );
}
