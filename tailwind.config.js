/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        void: {
          900: '#02030a',
          800: '#050718',
          700: '#080c24',
          600: '#0c1233',
          500: '#131b45',
        },
        signal: {
          cyan: '#5ff0ff',
          blue: '#4b8dff',
          violet: '#9d6bff',
          magenta: '#ff5fd2',
          amber: '#ffb347',
          lime: '#7dffb2',
          red: '#ff5f6d',
        },
      },
      fontFamily: {
        display: ['Orbitron', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Share Tech Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      boxShadow: {
        hud: '0 0 0 1px rgba(95, 240, 255, 0.16), 0 18px 60px -30px rgba(95, 240, 255, 0.55)',
        glow: '0 0 24px -4px rgba(95, 240, 255, 0.7)',
      },
      backdropBlur: {
        xs: '2px',
      },
      keyframes: {
        'hud-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scan-sweep': {
          '0%': { transform: 'translateY(-120%)' },
          '100%': { transform: 'translateY(520%)' },
        },
        'pulse-ring': {
          '0%': { opacity: '0.7', transform: 'scale(0.82)' },
          '70%': { opacity: '0', transform: 'scale(1.45)' },
          '100%': { opacity: '0', transform: 'scale(1.45)' },
        },
        'blink-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'bar-grow': {
          '0%': { transform: 'scaleX(0)' },
          '100%': { transform: 'scaleX(1)' },
        },
        // Entrance for the "Regresar a Casa" control. Declared here rather than
        // in a CSS module so it inherits the global prefers-reduced-motion
        // suppression in index.css, which zeroes every animation duration.
        'fade-slide-in': {
          '0%': { opacity: '0', transform: 'translateX(-20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'hud-in': 'hud-in 380ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'scan-sweep': 'scan-sweep 5.5s linear infinite',
        'pulse-ring': 'pulse-ring 2.4s ease-out infinite',
        'blink-soft': 'blink-soft 2s ease-in-out infinite',
        'bar-grow': 'bar-grow 900ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-slide-in': 'fade-slide-in 400ms ease-out both',
      },
    },
  },
  plugins: [],
}
