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
  seedHex?: string;
  industry?: string;
  tone?: string;
}

/** The computed system. Keys beyond these exist; theme.ts reads what it
    reads and passes the rest through to the Tailwind config untouched. */
export interface Palette {
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
