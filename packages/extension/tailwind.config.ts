import type { Config } from "tailwindcss";

/**
 * Material Design 3, Arabic-first.
 *
 * Every colour resolves to a `--md-sys-color-*` custom property defined in
 * `src/dashboard/tokens.css` (generated — see `scripts/gen-tokens.ts`). Nothing
 * here restates a hex value, which is what makes dark mode a single class flip on
 * <html> with zero duplicated `dark:` utilities.
 *
 * RTL is handled via `dir="rtl"` plus Tailwind's logical utilities
 * (ms-/me-/ps-/pe-/start-/end-) and the rtl:/ltr: variants — no plugin needed.
 */

/**
 * Tokens hold bare sRGB channels, so wrapping them in rgb() with Tailwind's
 * <alpha-value> placeholder is what makes `bg-primary` and `bg-on-surface/38`
 * both work. M3's disabled treatment depends on the second form.
 */
const role = (name: string) => `rgb(var(--md-sys-color-${name}) / <alpha-value>)`;

/** M3 type scale: [size, { lineHeight, letterSpacing, fontWeight }]. */
const type = (
  size: number,
  lineHeight: number,
  fontWeight: 400 | 500,
  letterSpacing: number,
): [string, { lineHeight: string; letterSpacing: string; fontWeight: string }] => [
  `${size}px`,
  {
    lineHeight: `${lineHeight}px`,
    letterSpacing: `${letterSpacing}px`,
    fontWeight: String(fontWeight),
  },
];

export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: role("primary"),
          container: role("primary-container"),
        },
        "on-primary": {
          DEFAULT: role("on-primary"),
          container: role("on-primary-container"),
        },
        "inverse-primary": role("inverse-primary"),

        secondary: {
          DEFAULT: role("secondary"),
          container: role("secondary-container"),
        },
        "on-secondary": {
          DEFAULT: role("on-secondary"),
          container: role("on-secondary-container"),
        },

        tertiary: {
          DEFAULT: role("tertiary"),
          container: role("tertiary-container"),
        },
        "on-tertiary": {
          DEFAULT: role("on-tertiary"),
          container: role("on-tertiary-container"),
        },

        error: {
          DEFAULT: role("error"),
          container: role("error-container"),
        },
        "on-error": {
          DEFAULT: role("on-error"),
          container: role("on-error-container"),
        },

        // Harmonised custom roles — M3 baseline has no success/warning, but post
        // status and RiskLevel are semantic states that need them.
        success: {
          DEFAULT: role("success"),
          container: role("success-container"),
        },
        "on-success": {
          DEFAULT: role("on-success"),
          container: role("on-success-container"),
        },
        warning: {
          DEFAULT: role("warning"),
          container: role("warning-container"),
        },
        "on-warning": {
          DEFAULT: role("on-warning"),
          container: role("on-warning-container"),
        },

        // Chart series. Deliberately NOT the success/warning/error roles: those are
        // tuned to sit beside text, and as adjacent fills two of the three are
        // indistinguishable under deuteranopia. See the note in styles.css.
        chart: {
          published: `rgb(var(--nashir-chart-published) / <alpha-value>)`,
          pending: `rgb(var(--nashir-chart-pending) / <alpha-value>)`,
          failed: `rgb(var(--nashir-chart-failed) / <alpha-value>)`,
        },

        background: role("background"),
        "on-background": role("on-background"),

        surface: {
          DEFAULT: role("surface"),
          dim: role("surface-dim"),
          bright: role("surface-bright"),
          variant: role("surface-variant"),
          tint: role("surface-tint"),
          container: {
            DEFAULT: role("surface-container"),
            lowest: role("surface-container-lowest"),
            low: role("surface-container-low"),
            high: role("surface-container-high"),
            highest: role("surface-container-highest"),
          },
        },
        "on-surface": {
          DEFAULT: role("on-surface"),
          variant: role("on-surface-variant"),
        },
        "inverse-surface": role("inverse-surface"),
        "inverse-on-surface": role("inverse-on-surface"),

        outline: {
          DEFAULT: role("outline"),
          variant: role("outline-variant"),
        },
        scrim: role("scrim"),
      },

      fontFamily: {
        // Both families are always listed; each @font-face carries a unicode-range,
        // so the browser picks Roboto for Latin and Plex Arabic for Arabic on its
        // own — including inside a single mixed-script line.
        sans: [
          "Roboto",
          "'IBM Plex Sans Arabic'",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["'Roboto Mono'", "ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },

      // The full M3 type scale. Arabic line-heights are adjusted in styles.css.
      fontSize: {
        "display-large": type(57, 64, 400, -0.25),
        "display-medium": type(45, 52, 400, 0),
        "display-small": type(36, 44, 400, 0),
        "headline-large": type(32, 40, 400, 0),
        "headline-medium": type(28, 36, 400, 0),
        "headline-small": type(24, 32, 400, 0),
        "title-large": type(22, 28, 400, 0),
        "title-medium": type(16, 24, 500, 0.15),
        "title-small": type(14, 20, 500, 0.1),
        "body-large": type(16, 24, 400, 0.5),
        "body-medium": type(14, 20, 400, 0.25),
        "body-small": type(12, 16, 400, 0.4),
        "label-large": type(14, 20, 500, 0.1),
        "label-medium": type(12, 16, 500, 0.5),
        "label-small": type(11, 16, 500, 0.5),
      },

      // M3 shape scale.
      borderRadius: {
        none: "var(--md-sys-shape-none)",
        xs: "var(--md-sys-shape-extra-small)",
        sm: "var(--md-sys-shape-small)",
        md: "var(--md-sys-shape-medium)",
        lg: "var(--md-sys-shape-large)",
        xl: "var(--md-sys-shape-extra-large)",
        full: "var(--md-sys-shape-full)",
      },

      // M3 elevation levels 0-5.
      boxShadow: {
        none: "var(--md-sys-elevation-0)",
        1: "var(--md-sys-elevation-1)",
        2: "var(--md-sys-elevation-2)",
        3: "var(--md-sys-elevation-3)",
        4: "var(--md-sys-elevation-4)",
        5: "var(--md-sys-elevation-5)",
      },

      transitionTimingFunction: {
        emphasized: "var(--md-sys-easing-emphasized)",
        "emphasized-decelerate": "var(--md-sys-easing-emphasized-decelerate)",
        "emphasized-accelerate": "var(--md-sys-easing-emphasized-accelerate)",
        standard: "var(--md-sys-easing-standard)",
        "standard-decelerate": "var(--md-sys-easing-standard-decelerate)",
        "standard-accelerate": "var(--md-sys-easing-standard-accelerate)",
      },

      transitionDuration: {
        short1: "var(--md-sys-duration-short1)",
        short2: "var(--md-sys-duration-short2)",
        short3: "var(--md-sys-duration-short3)",
        short4: "var(--md-sys-duration-short4)",
        medium1: "var(--md-sys-duration-medium1)",
        medium2: "var(--md-sys-duration-medium2)",
        medium3: "var(--md-sys-duration-medium3)",
        medium4: "var(--md-sys-duration-medium4)",
        long1: "var(--md-sys-duration-long1)",
        long2: "var(--md-sys-duration-long2)",
      },
    },
  },
  plugins: [],
} satisfies Config;
