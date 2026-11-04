import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A message across the page, drawn by Polaris (`<s-banner>`).
 *
 * `tone` says what kind of message it is: info, success, warning or critical. With `onDismiss` it gets a
 * close button; without it the banner stays. Buttons for the merchant go in `actions` — Polaris accepts
 * up to two, as `<s-button slot="secondary-actions">` (use the `Button` of this folder's siblings'
 * equivalent, `<s-button>` itself, since the slot must be a direct child).
 *
 * The banner announces its close button with a `dismiss` event. It is listened for by hand rather than
 * through a React `onDismiss` prop: React 19 hands custom elements any `on…` prop as the event of the
 * same name, capital letter and all, so `onDismiss` would wait for an event called "Dismiss" that never
 * comes (tested). The callback is read through a ref so a new function each render never re-attaches the
 * listener.
 *
 * A banner the merchant closes hides ITSELF. Give each different message its own `key`, so a new message
 * is a new element and never a closed one re-labelled.
 */
export interface BannerProps {
  tone?: 'info' | 'success' | 'warning' | 'critical';
  heading?: string;
  onDismiss?: () => void;
  children?: ReactNode;
}

export default function Banner({ tone = 'info', heading, onDismiss, children }: BannerProps) {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  const dismissible = Boolean(onDismiss);

  useEffect(() => {
    const element = ref.current;
    if (!element || !dismissible) return undefined;
    const handle = () => latest.current?.();
    element.addEventListener('dismiss', handle);
    return () => element.removeEventListener('dismiss', handle);
  }, [dismissible]);

  return (
    <s-banner ref={ref} tone={tone} heading={heading} dismissible={dismissible}>
      {children}
    </s-banner>
  );
}
