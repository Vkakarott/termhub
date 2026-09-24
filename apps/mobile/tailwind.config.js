const keys = ['bg', 'surface', 'surface2', 'border', 'text', 'muted', 'accent', 'accent-soft', 'danger', 'ok'];

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: { extend: { colors: Object.fromEntries(keys.map((k) => [`app-${k}`, `var(--app-${k})`])) } },
  plugins: [],
};
