/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'Menlo', 'Monaco', '"SF Mono"', 'Consolas', 'monospace'],
      },
      colors: {
        bg: { DEFAULT: '#0f1115', 2: '#161920', 3: '#1e222b', 4: '#262b36' },
        line: '#2a2f3a',
        fg: { DEFAULT: '#e6e8ee', muted: '#9aa1b1', dim: '#6b7280' },
        accent: { DEFAULT: '#4f8cff', hover: '#3b78ea' },
        ok: '#3fb950',
        warn: '#d29922',
        danger: '#f85149',
      },
    },
  },
  plugins: [],
};
