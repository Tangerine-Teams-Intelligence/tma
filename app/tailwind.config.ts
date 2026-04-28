import type { Config } from "tailwindcss";

const config: Config = {
  // We support BOTH the .dark class AND the [data-theme="dark"] attribute as
  // dark-mode triggers. Tailwind 3.4's `variant` strategy lets us pass an
  // array of selectors, both of which activate the `dark:` variant. The
  // store applies both on <html> for belt-and-suspenders coverage and to
  // make sure WebView2 (Tauri on Windows) — which sometimes drops
  // prefers-color-scheme propagation — still flips theme correctly.
  darkMode: [
    "variant",
    [
      "&:is(.dark *)",
      "&:is([data-theme='dark'] *)",
      "&:is(.dark)",
      "&:is([data-theme='dark'])",
    ],
  ],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Tangerine tokens — backed by CSS variables in index.css so dark mode
        // is a token swap, not a parallel stylesheet.
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        border: "var(--border)",
        ring: "var(--ring)",
        ti: {
          orange: {
            50: "var(--ti-orange-50)",
            100: "var(--ti-orange-100)",
            200: "var(--ti-orange-200)",
            300: "var(--ti-orange-300)",
            500: "var(--ti-orange-500)",
            600: "var(--ti-orange-600)",
            700: "var(--ti-orange-700)",
            // === wave 8 === — deep emphasis end of the orange ramp.
            900: "var(--ti-orange-900)",
          },
          navy: {
            700: "var(--ti-navy-700)",
            900: "var(--ti-navy-900)",
          },
          // === wave 8 === — blue ramp + green "alive" + filled-out
          // ink hierarchy. Existing 300/500/700/900 ink keys keep their
          // values; the new 100/200/400/600/800 fill in the steps so
          // components that reach for `text-ti-ink-600` get a real shade
          // rather than falling through.
          blue: {
            200: "var(--ti-blue-200)",
            500: "var(--ti-blue-500)",
            700: "var(--ti-blue-700)",
            900: "var(--ti-blue-900)",
          },
          green: {
            200: "var(--ti-green-200)",
            500: "var(--ti-green-500)",
          },
          paper: {
            50: "var(--ti-paper-50)",
            100: "var(--ti-paper-100)",
            200: "var(--ti-paper-200)",
          },
          ink: {
            100: "var(--ti-ink-100)",
            200: "var(--ti-ink-200)",
            300: "var(--ti-ink-300)",
            400: "var(--ti-ink-400)",
            500: "var(--ti-ink-500)",
            600: "var(--ti-ink-600)",
            700: "var(--ti-ink-700)",
            800: "var(--ti-ink-800)",
            900: "var(--ti-ink-900)",
          },
          border: {
            faint: "var(--ti-border-faint)",
            default: "var(--ti-border-default)",
          },
          state: {
            live: "#2D8659",
            failed: "#B83232",
            warn: "#B8860B",
          },
          /* Wave 3 cross-cut — VISUAL_DESIGN_SPEC §1 semantic state tokens.
             Backed by CSS variables in index.css so dark mode shifts via the
             token swap rather than a parallel `dark:` class on every site. */
          success: "var(--ti-success)",
          warn: "var(--ti-warn)",
          danger: "var(--ti-danger)",
          // === wave 8 === — additional status palette.
          warning: "var(--ti-warning)",
          info: "var(--ti-info)",
        },
      },
      fontFamily: {
        sans: ["var(--ti-font-sans)"],
        mono: ["var(--ti-font-mono)"],
        display: ["var(--ti-font-display)"],
      },
      borderRadius: {
        DEFAULT: "var(--ti-radius)",
      },
      transitionTimingFunction: {
        "ti-out": "var(--ti-ease-out)",
      },
      transitionDuration: {
        fast: "var(--ti-dur-fast)",
        /* Wave 3 — spec §3 timing scale. `quick` = 100ms (hover/focus),
           `medium` = 200ms (panel open, accept flash), `slow` = 400ms
           (route change, graph layout settle). */
        quick: "var(--ti-dur-quick)",
        medium: "var(--ti-dur-medium)",
        slow: "var(--ti-dur-slow)",
      },
      keyframes: {
        "live-pulse": {
          "0%, 100%": { transform: "scale(0.9)", opacity: "0.85" },
          "50%": { transform: "scale(1.1)", opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        /* Spec §3 — `ti-pulse` is the canonical co-thinker "alive" cadence
           (1.4s). Existing call sites pass it inline as `animation:
           ti-pulse 1.4s …`; exposing it through tailwind lets new components
           reach the canonical cadence via `animate-ti-pulse`. */
        "ti-pulse": {
          "0%, 100%": { opacity: "0.25" },
          "50%": { opacity: "1" },
        },
        // === wave 8 === — heartbeat halo for "alive AI" indicator.
        "ti-heartbeat-halo": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.4" },
          "50%": { transform: "scale(2.2)", opacity: "0" },
        },
        // === wave 8 === — slow rise for hero numerals fade-in.
        "ti-rise": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "live-pulse": "live-pulse 2s ease-in-out infinite",
        "fade-in": "fade-in 200ms ease-out",
        "ti-pulse": "ti-pulse 1.4s ease-in-out infinite",
        // === wave 8 === — exposed as utility classes for hero / brain page.
        "ti-heartbeat-halo": "ti-heartbeat-halo 2s ease-out infinite",
        "ti-rise": "ti-rise 400ms cubic-bezier(0.16, 1, 0.3, 1) both",
      },
      // === wave 8 === — line-height tokens. `tight` for display headlines,
      // `relaxed-cn` for the slightly looser CJK body cadence.
      lineHeight: {
        "display-tight": "1.1",
        "display-snug": "1.15",
        "body-relaxed": "1.6",
      },
      // === wave 8 === — display sizes available as font-size utilities.
      fontSize: {
        "display-xl": ["60px", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        "display-lg": ["48px", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        "display-md": ["36px", { lineHeight: "1.15", letterSpacing: "-0.015em" }],
      },
    },
  },
  plugins: [],
};

export default config;
