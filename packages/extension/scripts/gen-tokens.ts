/**
 * Generates `src/dashboard/tokens.css` — the Material Design 3 token layer.
 *
 * Colour roles are derived in HCT space by Google's own material-color-utilities,
 * not hand-picked. Hand-picking hex values produces something Material-adjacent;
 * only the tonal-palette maths produces Material.
 *
 * Run:  pnpm --filter @nashir/extension gen:tokens
 *
 * The output is committed. `tokens.test.ts` re-runs this generator and asserts the
 * committed file matches, so a hand-edit or a stale regenerate fails the suite.
 */
import {
  Hct,
  MaterialDynamicColors,
  SchemeTonalSpot,
  argbFromHex,
  blueFromArgb,
  customColor,
  greenFromArgb,
  redFromArgb,
  type DynamicScheme,
} from "@material/material-color-utilities";

/** The Nashir brand green. Every colour role descends from this one value. */
export const SEED = "#2FA084";

/**
 * M3 baseline ships `error` but no success/warning, and this app needs both:
 * post status (published / pending_approval / failed) and the four RiskLevel
 * values are semantic states. `blend: true` harmonises them toward the seed hue
 * so they read as part of one system rather than as bolted-on stoplight colours.
 */
export const CUSTOM_COLORS = [
  { name: "success", value: "#2E7D32" },
  { name: "warning", value: "#F9A825" },
] as const;

/**
 * The roles emitted, in output order. Deliberately excludes the `*PaletteKeyColor`
 * roles (internal to the algorithm) and the `*Fixed*` family (for cross-scheme
 * persistent surfaces, which this UI has none of).
 */
const ROLES = [
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "inversePrimary",
  "secondary",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "tertiary",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "error",
  "onError",
  "errorContainer",
  "onErrorContainer",
  "background",
  "onBackground",
  "surface",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "surfaceDim",
  "surfaceBright",
  "surfaceContainerLowest",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "surfaceTint",
  "outline",
  "outlineVariant",
  "inverseSurface",
  "inverseOnSurface",
  "shadow",
  "scrim",
] as const satisfies readonly (keyof typeof MaterialDynamicColors)[];

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Emitted as space-separated sRGB channels, not hex.
 *
 * Tailwind can only inject an alpha channel into a custom property that holds
 * bare channels — `rgb(var(--x) / <alpha-value>)`. M3 needs that for the disabled
 * treatment (content 38%, container 12%) and the scrim, so `bg-on-surface/38`
 * has to work. Plain CSS consumers wrap the var: `rgb(var(--md-sys-color-x))`.
 */
const channels = (argb: number) =>
  `${redFromArgb(argb)} ${greenFromArgb(argb)} ${blueFromArgb(argb)}`;

function colorVars(dark: boolean): string {
  const source = Hct.fromInt(argbFromHex(SEED));
  const scheme: DynamicScheme = new SchemeTonalSpot(source, dark, 0);

  const lines = ROLES.map((role) => {
    return `  --md-sys-color-${kebab(role)}: ${channels(MaterialDynamicColors[role].getArgb(scheme))};`;
  });

  for (const { name, value } of CUSTOM_COLORS) {
    const group = customColor(argbFromHex(SEED), {
      value: argbFromHex(value),
      name,
      blend: true,
    });
    const g = dark ? group.dark : group.light;
    lines.push(
      "",
      `  --md-sys-color-${name}: ${channels(g.color)};`,
      `  --md-sys-color-on-${name}: ${channels(g.onColor)};`,
      `  --md-sys-color-${name}-container: ${channels(g.colorContainer)};`,
      `  --md-sys-color-on-${name}-container: ${channels(g.onColorContainer)};`,
    );
  }

  return lines.join("\n");
}

/**
 * Token sets that are fixed constants in the M3 spec rather than derived from the
 * seed. They live here, not hand-written into the CSS, so that `tokens.css` stays
 * 100% generated and the drift guard covers the whole file.
 */
const STATIC_TOKENS = `:root {
  /* --- Shape scale ------------------------------------------------------- */
  --md-sys-shape-none: 0;
  --md-sys-shape-extra-small: 4px;
  --md-sys-shape-small: 8px;
  --md-sys-shape-medium: 12px;
  --md-sys-shape-large: 16px;
  --md-sys-shape-extra-large: 28px;
  --md-sys-shape-full: 9999px;

  /* --- Elevation (two-layer shadows, per spec) --------------------------- */
  --md-sys-elevation-0: none;
  --md-sys-elevation-1: 0 1px 2px 0 rgb(0 0 0 / 0.3), 0 1px 3px 1px rgb(0 0 0 / 0.15);
  --md-sys-elevation-2: 0 1px 2px 0 rgb(0 0 0 / 0.3), 0 2px 6px 2px rgb(0 0 0 / 0.15);
  --md-sys-elevation-3: 0 4px 8px 3px rgb(0 0 0 / 0.15), 0 1px 3px 0 rgb(0 0 0 / 0.3);
  --md-sys-elevation-4: 0 6px 10px 4px rgb(0 0 0 / 0.15), 0 2px 3px 0 rgb(0 0 0 / 0.3);
  --md-sys-elevation-5: 0 8px 12px 6px rgb(0 0 0 / 0.15), 0 4px 4px 0 rgb(0 0 0 / 0.3);

  /* --- State layer opacities --------------------------------------------- */
  --md-sys-state-hover: 0.08;
  --md-sys-state-focus: 0.1;
  --md-sys-state-pressed: 0.1;
  --md-sys-state-dragged: 0.16;

  /* Disabled: content at 38%, container at 12%. */
  --md-sys-state-disabled-content: 0.38;
  --md-sys-state-disabled-container: 0.12;

  /* --- Motion ------------------------------------------------------------ */
  --md-sys-easing-emphasized: cubic-bezier(0.2, 0, 0, 1);
  --md-sys-easing-emphasized-decelerate: cubic-bezier(0.05, 0.7, 0.1, 1);
  --md-sys-easing-emphasized-accelerate: cubic-bezier(0.3, 0, 0.8, 0.15);
  --md-sys-easing-standard: cubic-bezier(0.2, 0, 0, 1);
  --md-sys-easing-standard-decelerate: cubic-bezier(0, 0, 0, 1);
  --md-sys-easing-standard-accelerate: cubic-bezier(0.3, 0, 1, 1);

  --md-sys-duration-short1: 50ms;
  --md-sys-duration-short2: 100ms;
  --md-sys-duration-short3: 150ms;
  --md-sys-duration-short4: 200ms;
  --md-sys-duration-medium1: 250ms;
  --md-sys-duration-medium2: 300ms;
  --md-sys-duration-medium3: 350ms;
  --md-sys-duration-medium4: 400ms;
  --md-sys-duration-long1: 450ms;
  --md-sys-duration-long2: 500ms;
  --md-sys-duration-long3: 550ms;
  --md-sys-duration-long4: 600ms;
}`;

export function buildTokensCss(): string {
  return `/*
 * Material Design 3 token layer — GENERATED, do not edit by hand.
 *
 * Source seed: ${SEED} (Nashir brand green)
 * Regenerate:  pnpm --filter @nashir/extension gen:tokens
 *
 * Colour roles are derived in HCT space via @material/material-color-utilities
 * (SchemeTonalSpot, contrast level 0). The dark scheme is a separate derivation,
 * not a filter over the light one.
 *
 * Values are space-separated sRGB channels so an alpha can be composed in:
 *   Tailwind    bg-primary  ->  rgb(var(--md-sys-color-primary) / 1)
 *   Tailwind    bg-primary/12
 *   plain CSS   color: rgb(var(--md-sys-color-primary));
 */

/* ===== Light scheme ===================================================== */
:root {
  color-scheme: light;

${colorVars(false)}
}

/* ===== Dark scheme ====================================================== */
.dark {
  color-scheme: dark;

${colorVars(true)}
}

/* ===== Scheme-independent tokens ======================================== */
${STATIC_TOKENS}
`;
}
