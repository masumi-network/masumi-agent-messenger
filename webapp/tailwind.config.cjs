/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', '"SF Mono"', 'monospace'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        'soft-sm': 'var(--shadow-sm)',
        'soft-md': 'var(--shadow-md)',
      },
      keyframes: {
        'masumi-fade-slide': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'masumi-fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'masumi-shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'soft-enter': 'masumi-fade-slide 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'soft-subtle': 'masumi-fade-slide 340ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'soft-fade': 'masumi-fade-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'soft-slow': 'masumi-fade-slide 480ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        shimmer: 'masumi-shimmer 1400ms linear infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
