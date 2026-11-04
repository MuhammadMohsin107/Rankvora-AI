/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // ─── Theme tokens ───────────────────────────────────────────────
      // EVERY colour resolves through a CSS variable rather than a literal. That indirection is
      // what makes one theme system serve the whole app: `bg-surface-50` and `text-surface-900`
      // are already written into 500+ places across 64 components, and because they now read a
      // variable, flipping that variable in index.css switches all of them at once. No component
      // carries a `dark:` variant, and no page has its own copy of the palette.
      //
      // THE SURFACE RAMP IS SEMANTIC, NOT LITERAL. 50 means "page background" and 950 means
      // "strongest text" — which is why dark mode inverts the ramp instead of inventing a second
      // scale. See index.css for the two sets of values.
      //
      // Light-mode values are unchanged from before this system existed, so the existing design is
      // the baseline exactly as it was.
      colors: {
        brand: {
          50:  'var(--c-brand-50)',
          100: 'var(--c-brand-100)',
          200: 'var(--c-brand-200)',
          300: 'var(--c-brand-300)',
          400: 'var(--c-brand-400)',
          500: 'var(--c-brand-500)',
          600: 'var(--c-brand-600)', // Primary brand accent
          700: 'var(--c-brand-700)',
          800: 'var(--c-brand-800)',
          900: 'var(--c-brand-900)',
          950: 'var(--c-brand-950)',
        },
        surface: {
          // 0 is new: the raised sheet a card sits on. White in light, a lifted grey in dark —
          // which is what `bg-white` used to hardcode and could never adapt.
          0:   'var(--c-surface-0)',
          50:  'var(--c-surface-50)',
          100: 'var(--c-surface-100)',
          200: 'var(--c-surface-200)',
          300: 'var(--c-surface-300)',
          400: 'var(--c-surface-400)',
          500: 'var(--c-surface-500)',
          600: 'var(--c-surface-600)',
          700: 'var(--c-surface-700)',
          800: 'var(--c-surface-800)',
          900: 'var(--c-surface-900)',
          950: 'var(--c-surface-950)',
        },
        success: {
          50:  'var(--c-success-50)',
          100: 'var(--c-success-100)',
          500: 'var(--c-success-500)',
          600: 'var(--c-success-600)',
          700: 'var(--c-success-700)',
        },
        warning: {
          50:  'var(--c-warning-50)',
          100: 'var(--c-warning-100)',
          500: 'var(--c-warning-500)',
          600: 'var(--c-warning-600)',
          700: 'var(--c-warning-700)',
        },
        critical: {
          50:  'var(--c-critical-50)',
          100: 'var(--c-critical-100)',
          200: 'var(--c-critical-200)',
          300: 'var(--c-critical-300)',
          400: 'var(--c-critical-400)',
          500: 'var(--c-critical-500)',
          600: 'var(--c-critical-600)',
          700: 'var(--c-critical-700)',
        },
        info: {
          50:  'var(--c-info-50)',
          100: 'var(--c-info-100)',
          500: 'var(--c-info-500)',
          600: 'var(--c-info-600)',
          700: 'var(--c-info-700)',
        },
        sidebar: {
          DEFAULT: 'var(--c-sidebar)',
          hover: 'var(--c-sidebar-hover)',
          active: 'var(--c-sidebar-active)',
          border: 'var(--c-sidebar-border)',
          text: 'var(--c-sidebar-text)',
          'text-active': 'var(--c-sidebar-text-active)',
        },
      },
      fontFamily: {
        sans: ['Geist Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      // ─── Compact type ramp ──────────────────────────────────────────────
      // ONE scale, tightened for a data screen. The steps are proportional to each other, so a
      // heading and the description under it shrink together — the previous 36px page title over
      // 16px body was a marketing ratio, not a working one.
      //
      //   score 36 · metric 24 · page 22 · section 15 · body 13/14 · meta 11
      //
      // The named steps here are the vocabulary; the .page-title / .section-title / .card-title
      // component classes in index.css are what pages actually reach for, since those carry the
      // matching weight, colour and tracking as well as the size.
      fontSize: {
        'metric': ['1.5rem', { lineHeight: '1.05', letterSpacing: '-0.02em', fontWeight: '600' }],
        'score-lg': ['2.25rem', { lineHeight: '1.05', letterSpacing: '-0.03em', fontWeight: '600' }],
        'page-title': ['1.375rem', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '600' }],
        'section-title': ['0.9375rem', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '600' }],
        'body-lg': ['0.875rem', { lineHeight: '1.45', fontWeight: '400' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.45', fontWeight: '400' }],
        'meta': ['0.6875rem', { lineHeight: '1.4', fontWeight: '500' }],
      },
      boxShadow: {
        // Crisp, minimal shadows
        'card': '0 1px 3px rgba(0,0,0,0.02), 0 1px 2px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03)',
        'elevated': '0 10px 15px -3px rgba(0,0,0,0.05), 0 4px 6px -2px rgba(0,0,0,0.03)',
      },
      borderRadius: {
        // 10px. A smaller radius reads as tighter at small card sizes; 12px looked soft once the
        // cards themselves came down to ~120px tall.
        'card': '0.625rem',
      },
      letterSpacing: {
        'wider': '0.04em',
        'widest': '0.08em',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.98)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [],
}
