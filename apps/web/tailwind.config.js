/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * FormaAI brand identity.
         *
         * The palette is deliberately two colours and one neutral: Deep Blue
         * (#09318D) carries structure and trust, Bubblegum Pink (#FD91CC) is the
         * single accent used for emphasis and hover, and Pure White is the only
         * surface colour. Anything else lives in `ink`, which is a tinted grey so
         * it stays in the blue family instead of looking dirty next to it.
         */
        brand: {
          50: '#eef2fc',
          100: '#d6e0f8',
          200: '#adc2f0',
          300: '#7f9fe6',
          400: '#4b74d8',
          500: '#1f51c0',
          600: '#09318d', // Deep blue — the primary colour
          700: '#082a78',
          800: '#072261',
          900: '#051a4a',
        },
        accent: {
          50: '#fff2f9',
          100: '#ffe3f2',
          200: '#fecbe7',
          300: '#fd91cc', // Bubblegum pink — the only accent
          400: '#fc74be',
          500: '#f955ad',
          600: '#e63b94',
          700: '#c02777',
          800: '#94215e',
          900: '#6d1a46',
        },
        ink: {
          50: '#f6f8fc',
          100: '#eaeef6',
          200: '#d5dcea',
          300: '#b0bbd0',
          400: '#7f8ca8',
          500: '#5c6982',
          600: '#47536a',
          700: '#374257',
          800: '#2a3346',
          900: '#1b2233',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      maxWidth: {
        reading: '46rem',
      },
      backgroundImage: {
        /** The hero wash: deep blue sinking into a lighter centre, as in the brand board. */
        'brand-hero': 'radial-gradient(120% 90% at 50% 0%, #1a52c9 0%, #09318d 45%, #051a4a 100%)',
        'brand-glow': 'radial-gradient(60% 60% at 50% 40%, rgba(253,145,204,0.35) 0%, rgba(253,145,204,0) 70%)',
        'brand-line': 'linear-gradient(90deg, #09318d 0%, #fd91cc 100%)',
        /**
         * The band the hero dissolves into.
         *
         * The hero used to stop dead on `#051a4a` and meet the white page in a
         * straight line, which read as a hard edge cutting across the screen. This
         * fades the same deep blue down into white over the last stretch of the
         * section, so the hero bleeds out instead of ending.
         */
        'brand-fade-out': 'linear-gradient(to bottom, rgba(5,26,74,0) 0%, rgba(5,26,74,0.35) 22%, rgba(5,26,74,0.82) 52%, #ffffff 100%)',
        /** The mirror of the above, for the top edge of the closing band. */
        'brand-fade-in': 'linear-gradient(to bottom, #ffffff 0%, rgba(5,26,74,0.82) 48%, rgba(5,26,74,0.35) 78%, rgba(5,26,74,0) 100%)',
        /**
         * The CTA band, rounded and lifted off the page instead of butting into it.
         * A soft blue halo sits underneath so the block reads as a panel floating on
         * the page rather than a painted stripe.
         */
        'brand-band': 'radial-gradient(120% 140% at 50% 0%, #1a52c9 0%, #09318d 52%, #061f56 100%)',
      },
      boxShadow: {
        // A soft, blue-tinted lift so cards never look flat grey.
        card: '0 1px 2px rgba(9,49,141,0.06), 0 8px 24px -12px rgba(9,49,141,0.18)',
        lift: '0 2px 4px rgba(9,49,141,0.08), 0 18px 40px -18px rgba(9,49,141,0.28)',
        accent: '0 8px 24px -10px rgba(253,145,204,0.75)',
        /**
         * A deep blue halo for the closing band, so the panel floats above the page
         * instead of sitting flush against it. Two stacked shadows: a tight contact
         * shadow and a wide ambient one, which is what makes it read as height
         * rather than as a blurry border.
         */
        band: '0 1px 2px rgba(6,31,86,0.10), 0 24px 60px -24px rgba(9,49,141,0.45), 0 8px 22px -12px rgba(9,49,141,0.28)',
        /** Glow behind the accent button, used where it sits on dark blue. */
        'accent-glow': '0 10px 30px -8px rgba(253,145,204,0.65), 0 2px 10px -2px rgba(253,145,204,0.45)',
        /**
         * A three-layer shadow for primary panels.
         *
         * One shadow reads as a grey outline; three at different offsets and blurs
         * read as light falling on a real surface — a tight contact line, a mid
         * shadow for the edge, and a wide ambient pool. This is the difference
         * between "a border" and "something sitting above the page".
         */
        panel: '0 0 0 1px rgba(9,49,141,0.04), 0 1px 3px rgba(9,49,141,0.07), 0 14px 34px -16px rgba(9,49,141,0.22), 0 32px 64px -40px rgba(9,49,141,0.28)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        /**
         * Drawer entrances. A drawer that pops into place reads as a page reload
         * rather than as a panel sliding over the workspace, so each side gets a
         * short 8 px travel in the direction it is anchored to.
         */
        'slide-in-left': {
          '0%': { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.45s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 0.3s ease-out both',
        'scale-in': 'scale-in 0.18s cubic-bezier(0.16, 1, 0.3, 1) both',
        float: 'float 6s ease-in-out infinite',
        'slide-in-left': 'slide-in-left 0.22s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-in-right': 'slide-in-right 0.22s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      transitionTimingFunction: {
        // The house easing: quick start, gentle settle.
        brand: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
