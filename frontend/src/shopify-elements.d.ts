import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * Types for the Shopify elements React does not know about.
 *
 * `@shopify/polaris-types` teaches React the `s-*` Polaris components (`s-link`, `s-badge`, …).
 * `s-app-nav` is not one of them — it belongs to App Bridge, whose types add it to the old global
 * JSX namespace, which React 19 no longer reads. Without this, `<s-app-nav>` is a type error.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      /** App Bridge's navigation menu. Its children are `<s-link href="…">` items; see layouts/EmbeddedShell.tsx. */
      's-app-nav': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
