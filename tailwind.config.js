/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Liquid-glass palette
        glass: {
          DEFAULT: "rgb(255 255 255 / 0.05)",
          hover: "rgb(255 255 255 / 0.10)",
          border: "rgb(255 255 255 / 0.10)",
          "border-active": "rgb(255 255 255 / 0.20)",
        },
      },
    },
  },
  // Don't reset the existing global.css base styles — we layer Tailwind
  // utilities on top rather than using @tailwind base.
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};
