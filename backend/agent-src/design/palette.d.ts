/* =================================================================
   design/palette.d.ts — the seam, not a module
   -----------------------------------------------------------------
   backend/lib/design/palette.js stays hand-written JavaScript. It is
   the OKLCH colour system — it moves lightness until each pairing
   provably clears WCAG AA rather than hoping it does — and it belongs
   to the design layer, not to the agent. theme.ts calls exactly one
   of its exports.

   Emits nothing. See the rootDir note in tsconfig.json.
   ================================================================= */

export interface PaletteBuildOpts {
  /** A hex seed. Named `seed`, not `seedHex` — theme.ts translates. */
  seed?: string;
  industry?: string;
  tone?: string;
}

/** Every pairing the build verifies, as a ratio. `passesAA` is true only
    when all of them clear 4.5:1 — see palette.js, which moves lightness
    until they do rather than hoping. */
export interface ContrastReport {
  inkOnSurface: number;
  ink2OnSurface: number;
  onAccentOnAccent: number;
  inkOnTint: number;
  onDarkOnDark: number;
}

/** The computed system. The index signature is there because palette.js
    carries more tokens than the agent reads; the named ones are those
    theme.ts actually puts into a Tailwind config. */
export interface Palette {
  accent: string;
  accentHover: string;
  onAccent: string;
  surface: string;
  tint: string;
  line: string;
  ink: string;
  ink2: string;
  dark: string;
  onDark: string;
  contrast: ContrastReport;
  passesAA: boolean;
  [token: string]: unknown;
}

export function build(opts: PaletteBuildOpts): Palette;
export function contrast(a: string, b: string): number;
export function ensureContrast(fg: string, bg: string, target: number): string;
export function toOklch(hex: string): { l: number; c: number; h: number };
export function fromOklch(o: { l: number; c: number; h: number }): string;
export function hexToRgb(hex: string): { r: number; g: number; b: number };
export function rgbToHex(rgb: { r: number; g: number; b: number }): string;
export function shift(hex: string, kind: string): string;
export const INDUSTRY_SEED: Record<string, string>;
export const SHIFT_KINDS: string[];
