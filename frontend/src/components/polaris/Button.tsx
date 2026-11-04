import type { ComponentProps, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * ─── A button, drawn by Polaris ──────────────────────────────────────
 *
 * Every button in the app is this one component, which renders a Polaris `<s-button>` — so it looks and
 * behaves like the buttons in the rest of the Shopify admin, and follows the admin's theme.
 *
 * Four looks, named for what the button DOES rather than how it is drawn (primary when none is given):
 *   primary    the one thing a screen is for ("Save", "Run audit")
 *   secondary  anything else worth a button
 *   ghost      a quiet action next to a louder one ("Reset", "Show older")
 *   danger     removes something or cannot be undone
 *
 * Three ways to act: `onClick`; `to` for another page of this app (the router takes the click, so the app
 * does not reload); or `href` for anywhere else (opened in a new tab with `newTab`).
 *
 * `className` is for LAYOUT only — a margin, `flex-shrink-0`, hiding it at a width. The look comes from
 * Polaris and cannot be overridden from here, by design: Polaris draws inside its own shadow root.
 */
export interface ButtonProps {
  /** The label. Left out only for an icon-only button, which must then have an `accessibilityLabel`. */
  children?: ReactNode;
  /** One of Polaris's own icons ("x", "chevron-left", "refresh"…), drawn before the label. */
  icon?: ComponentProps<'s-button'>['icon'];
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  onClick?: () => void;
  /** Another page of this app, e.g. "/integrations". */
  to?: string;
  /** An address outside the app. */
  href?: string;
  newTab?: boolean;
  disabled?: boolean;
  /** Polaris's spinner inside the button. A loading button ignores clicks. */
  loading?: boolean;
  /** Stretches to the width of its container. */
  fullWidth?: boolean;
  type?: 'button' | 'submit';
  /** For a screen reader, when the visible label alone does not say enough. */
  accessibilityLabel?: string;
  className?: string;
  /** Set to "secondary-actions" to place the button in a Polaris banner's action area. */
  slot?: 'secondary-actions';
}

const LOOK = {
  primary: { variant: 'primary', tone: 'auto' },
  secondary: { variant: 'secondary', tone: 'auto' },
  ghost: { variant: 'tertiary', tone: 'auto' },
  danger: { variant: 'secondary', tone: 'critical' },
} as const;

export default function Button({
  children,
  icon,
  variant = 'primary',
  onClick,
  to,
  href,
  newTab = false,
  disabled = false,
  loading = false,
  fullWidth = false,
  type = 'button',
  accessibilityLabel,
  className,
  slot,
}: ButtonProps) {
  const navigate = useNavigate();
  const look = LOOK[variant];
  const inactive = disabled || loading;

  return (
    <s-button
      variant={look.variant}
      tone={look.tone}
      type={type}
      icon={icon}
      slot={slot}
      href={inactive ? undefined : (to ?? href)}
      target={href && newTab ? '_blank' : undefined}
      loading={loading}
      disabled={disabled}
      inlineSize={fullWidth ? 'fill' : 'auto'}
      accessibilityLabel={accessibilityLabel}
      // Polaris's types leave out `className`, but React sets it as the element's class like any other
      // element's, so a margin or `flex-shrink-0` reaches the button.
      {...(className ? { className } : {})}
      onClick={(event) => {
        if (inactive) {
          event.preventDefault();
          return;
        }
        // An in-app link: the router takes the click, so the page does not reload and the admin's own
        // history stays in step. (Where the link is drawn by Polaris with a real address, it still works
        // when opened in a new tab.)
        if (to) {
          event.preventDefault();
          navigate(to);
        }
        onClick?.();
      }}
    >
      {children}
    </s-button>
  );
}
