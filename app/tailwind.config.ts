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
            500: "var(--ti-orange-500)",
            600: "var(--ti-orange-600)",
            700: "var(--ti-orange-700)",
          },
          navy: {
            700: "var(--ti-navy-700)",
            900: "var(--ti-navy-900)",
          },
          paper: {
            50: "var(--ti-paper-50)",
            100: "var(--ti-paper-100)",
            200: "var(--ti-paper-200)",
          },
          ink: {
            300: "var(--ti-ink-300)",
            500: "var(--ti-ink-500)",
            700: "var(--ti-ink-700)",
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
      },
      animation: {
        "live-pulse": "live-pulse 2s ease-in-out infinite",
        "fade-in": "fade-in 200ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
