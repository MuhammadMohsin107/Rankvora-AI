import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * ─── The frame every page sits in ────────────────────────────────────
 *
 * A Polaris `<s-page>`. Inside the Shopify admin it hands the page's heading and its buttons to the
 * admin's own title bar — the bar above the app, drawn by Shopify, where merchants look for the page's
 * name and its main action — and what is left in the app is the content. Outside the admin (local
 * development) it draws the same heading and buttons itself, above the content.
 *
 * So a page that uses this draws NO heading of its own: not an <h1>, not a title row. A second title
 * inside the frame would repeat the one in the title bar.
 *
 * Shopify's rules for what goes in which slot, kept here so no page has to remember them:
 *   • ONE primary action, an `s-button` with variant="primary" — the thing the page is for (Re-analyze).
 *   • Any number of secondary actions, `s-button`s that are not primary (Export, Refresh).
 *   • One "back" link on a page that belongs to a list, an `s-link` — the arrow before the title.
 *   • Nothing else is accepted in those slots.
 * The buttons' clicks come back to the handlers given here, wherever the buttons are drawn.
 */
export interface PageAction {
  label: string;
  onClick: () => void;
  /** Polaris's spinner inside the button. A loading button ignores clicks. */
  loading?: boolean;
  disabled?: boolean;
  /** For a screen reader, when the visible label alone does not say enough. */
  accessibilityLabel?: string;
}

interface AppPageProps {
  heading: string;
  primaryAction?: PageAction;
  secondaryActions?: PageAction[];
  /** The page this one belongs to — a product's page goes back to the products list. */
  back?: { label: string; to: string };
  /**
   * How wide the page is. The app's pages are dashboards and tables, so "large" (the full width) is the
   * default; "base" is Polaris's narrower reading width, for a settings-style form.
   */
  inlineSize?: 'small' | 'base' | 'large';
  children: ReactNode;
}

export default function AppPage({ heading, primaryAction, secondaryActions, back, inlineSize = 'large', children }: AppPageProps) {
  const navigate = useNavigate();
  return (
    <s-page heading={heading} inlineSize={inlineSize}>
      {/* In the admin the title bar follows `href` itself. Where the link is drawn by the page (local
          development) the router takes the click, so the app does not reload to go back. */}
      {back && (
        <s-link
          slot="breadcrumb-actions"
          href={back.to}
          onClick={(event) => {
            event.preventDefault();
            navigate(back.to);
          }}
        >
          {back.label}
        </s-link>
      )}
      {primaryAction && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={primaryAction.onClick}
          loading={primaryAction.loading ?? false}
          disabled={primaryAction.disabled ?? false}
          accessibilityLabel={primaryAction.accessibilityLabel}
        >
          {primaryAction.label}
        </s-button>
      )}
      {secondaryActions?.map((action) => (
        <s-button
          key={action.label}
          slot="secondary-actions"
          onClick={action.onClick}
          loading={action.loading ?? false}
          disabled={action.disabled ?? false}
          accessibilityLabel={action.accessibilityLabel}
        >
          {action.label}
        </s-button>
      ))}
      {children}
    </s-page>
  );
}
