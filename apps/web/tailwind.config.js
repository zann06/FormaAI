/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Minimal, professional palette. `brand` is the single accent colour.
        brand: {
          50: '#eef4ff',
          100: '#dbe6fe',
          200: '#bfd3fe',
          300: '#93b4fd',
          400: '#608bfa',
          500: '#3b66f6',
          600: '#2547eb',
          700: '#1d36d8',
          800: '#1e2fae',
          900: '#1e2d89',
        },
        ink: {
          50: '#f7f8fa',
          100: '#eceef2',
          200: '#d5dae2',
          300: '#b0b9c8',
          400: '#8391a8',
          500: '#64728c',
          600: '#4e5a72',
          700: '#40495c',
          800: '#373e4d',
          900: '#313743',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      maxWidth: {
        reading: '46rem',
      },
    },
  },
  plugins: [],
};
