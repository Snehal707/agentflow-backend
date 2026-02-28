import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0A0A0A",
          secondary: "#121212",
          tertiary: "#1A1A1A",
        },
        gold: {
          DEFAULT: "#C0A060",
          light: "#D4B880",
          dark: "#A08040",
        },
        platinum: {
          DEFAULT: "#E0E0E0",
          muted: "#A0A0A0",
        },
        blue: {
          deep: "#1A5F7A",
          electric: "#2A8FBD",
        },
        success: "#2A9D8F",
        danger: "#E76F51",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "sans-serif"],
        mono: ["var(--font-jetbrains)", "JetBrains Mono", "monospace"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
      },
      animation: {
        "pulse-fast":
          "pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "spin-slow": "spin 4s linear infinite",
        "ping-slow": "ping 2s cubic-bezier(0, 0, 0.2, 1) infinite",
      },
      typography: ({ theme }: { theme: (path: string) => string }) => ({
        luxury: {
          css: {
            "--tw-prose-body": theme("colors.platinum.DEFAULT"),
            "--tw-prose-headings": theme("colors.platinum.DEFAULT"),
            "--tw-prose-links": theme("colors.gold.DEFAULT"),
            "--tw-prose-bold": theme("colors.platinum.DEFAULT"),
            "--tw-prose-counters": theme("colors.gold.DEFAULT"),
            "--tw-prose-bullets": theme("colors.gold.DEFAULT"),
            "--tw-prose-quotes": theme("colors.platinum.muted"),
            "--tw-prose-code": theme("colors.gold.DEFAULT"),
            "--tw-prose-pre-code": theme("colors.platinum.DEFAULT"),
            "--tw-prose-pre-bg": theme("colors.bg.DEFAULT"),
            "--tw-prose-invert-body": theme("colors.platinum.DEFAULT"),
            "--tw-prose-invert-headings": theme("colors.platinum.DEFAULT"),
            "--tw-prose-invert-lead": theme("colors.platinum.muted"),
            "--tw-prose-invert-links": theme("colors.gold.DEFAULT"),
            "--tw-prose-invert-bold": theme("colors.platinum.DEFAULT"),
            "--tw-prose-invert-counters": theme("colors.gold.dark"),
            "--tw-prose-invert-bullets": theme("colors.gold.DEFAULT"),
            "--tw-prose-invert-hr": "rgba(255, 255, 255, 0.1)",
            "--tw-prose-invert-quotes": theme("colors.platinum.muted"),
            "--tw-prose-invert-quote-borders": theme("colors.gold.DEFAULT"),
            "--tw-prose-invert-captions": theme("colors.platinum.muted"),
            "--tw-prose-invert-code": theme("colors.gold.DEFAULT"),
            "--tw-prose-invert-pre-code": theme("colors.platinum.DEFAULT"),
            "--tw-prose-invert-pre-bg": theme("colors.bg.tertiary"),
            "--tw-prose-invert-th-borders": "rgba(255, 255, 255, 0.1)",
            "--tw-prose-invert-td-borders": "rgba(255, 255, 255, 0.05)",
          },
        },
      }),
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
export default config;
