import AuthLayout from '../../layouts/AuthLayout';
import Button from '../../components/polaris/Button';

/**
 * ─── What a visitor sees on the bare site ────────────────────────────
 *
 * Rankvora AI is a Shopify app and runs inside the Shopify admin, where Shopify itself says which
 * store is opening it. There is nothing to sign in to here, and — deliberately — no field asking a
 * merchant to type their store address: the App Store requires that installation and sign-in start
 * from a Shopify surface, never from a form on the app's own site.
 *
 * So this page only points the way back. It stands where the sign-in and sign-up pages were, for the
 * addresses an old email or bookmark still carries.
 */
export default function OpenFromShopify() {
  return (
    <AuthLayout
      title="Open Rankvora AI from your Shopify admin"
      subtitle="Rankvora AI runs inside Shopify, so there is nothing to sign in to here."
      footer={<p>Not installed yet? Install Rankvora AI from the Shopify App Store, then open it from Apps in your Shopify admin.</p>}
    >
      <ol className="space-y-3 text-[14.5px] leading-6 text-surface-700">
        <li>1. Open your Shopify admin.</li>
        <li>
          2. Choose <span className="font-semibold text-surface-900">Apps</span> in the sidebar.
        </li>
        <li>
          3. Select <span className="font-semibold text-surface-900">Rankvora AI</span>.
        </li>
      </ol>

      <Button variant="primary" href="https://admin.shopify.com" className="mt-6">
        Go to your Shopify admin
        
      </Button>
    </AuthLayout>
  );
}
