import { Link, useLocation } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { card } from '../components/seo/subpillar/tone';

/**
 * Catch-all for URLs that match no route.
 *
 * Renders INSIDE AppShell on purpose: the customer keeps the sidebar and header, so a mistyped
 * or stale link is a wrong turn they can navigate out of, not a dead end. Previously these URLs
 * matched nothing in the inner router and left the main area completely blank, with only a
 * "No routes matched location" warning in the console to explain it.
 *
 * The path is echoed back because the most common cause is a stale bookmark or an out-of-date
 * link, and seeing which URL failed is what makes that diagnosable.
 */
export default function NotFound() {
  const { pathname } = useLocation();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:px-6">
      <div className={`${card} flex flex-col items-center p-6 text-center`}>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-100 text-surface-500">
          <Compass size={18} />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-surface-900">Page not found</h1>
        <p className="mt-1.5 max-w-md text-sm text-surface-500">
          We couldn&apos;t find anything at{' '}
          <span className="break-all font-mono text-[13px] text-surface-700">{pathname}</span>. The
          link may be out of date, or the page may have moved.
        </p>
        <Link to="/" className="btn-primary mt-6">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
