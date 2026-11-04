import type { ReactNode } from 'react';
import RankvoraLogo from '../components/auth/RankvoraLogo';
import AuthBackdrop, { AuthInsightCards } from '../components/auth/AuthBackdrop';
import AuthWorldMap from '../components/auth/AuthWorldMap';

interface AuthLayoutProps {
  title: string;
  /** Optional. Omitted — or empty — renders NO element, rather than an empty <p> that still
   * claims its top margin and a line box. */
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * ─── Signed-out shell ────────────────────────────────────────────────────────
 *
 *   LEFT   — a panel saying what the product does, its copy set on a live world-map wall
 *            (AuthWorldMap), with the chart cards and AI node beside it from `xl` up. From `lg` up.
 *   BEHIND — the live background (AuthBackdrop) the light side fades into.
 *   RIGHT  — the light form side: logo, title, the form, and the footer under a hairline.
 *
 * The form comes first in the markup, so keyboard and screen-reader users reach it first;
 * `lg:flex-row-reverse` puts it on the right.
 *
 * Every colour belongs to `.auth-shell` in index.css. The form side is `.auth-sheet`, which pins
 * the light surface and brand ramps, so it reads the same in every app theme.
 *
 * DELIBERATELY NOT HERE: check counts, scores, testimonials or customer numbers. The panel copy
 * describes the product as built.
 */
export default function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className="auth-shell relative h-full overflow-y-auto overflow-x-hidden" style={{ background: 'var(--auth-stage)' }}>
      <AuthBackdrop />

      <div className="relative z-10 flex min-h-full lg:flex-row-reverse">
        <div className="auth-sheet flex w-full flex-col px-5 py-7 sm:px-10 lg:w-[var(--auth-split)] lg:flex-none lg:py-9 lg:pl-[5.5vw] lg:pr-[3.5vw]">
          <RankvoraLogo />

          <div className="flex flex-1 items-center py-10">
            <main className="auth-rise mx-auto w-full max-w-[460px] lg:mx-0">
              <h1 className="text-balance text-[26px] font-bold leading-[1.2] tracking-[-0.02em] text-surface-900">
                {title}
              </h1>
              {subtitle && <p className="mt-2 text-[14.5px] leading-6 text-surface-600">{subtitle}</p>}

              <div className="mt-7">{children}</div>

              {footer && (
                <div className="mt-8 border-t border-surface-200 pt-5 text-[13.5px] leading-6 text-surface-600 [&_a]:font-semibold [&_a]:text-[color:var(--auth-accent)] [&_a:hover]:text-[color:var(--auth-accent-hover)]">
                  {footer}
                </div>
              )}
            </main>
          </div>
        </div>

        <aside className="hidden flex-1 py-8 pl-[2.3vw] pr-[3.5vw] lg:flex" aria-label="About Rankvora AI">
          <div className="auth-map-panel auth-rise relative flex w-full items-center overflow-hidden rounded-[24px]">
            <AuthWorldMap />
            <div aria-hidden="true" className="auth-map-scrim absolute inset-0" />

            <div className="relative flex w-full items-center gap-8 py-14 pl-[clamp(32px,3.8vw,56px)] pr-[clamp(28px,2.8vw,42px)]">
              <div className="auth-map-copy min-w-0 max-w-[470px] flex-1">
                <span className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-4 py-2 text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--auth-pill-ink)] shadow-[0_6px_18px_-8px_rgba(0,0,0,0.6)]">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[color:var(--auth-accent)]" />
                  Store optimization engine
                </span>
                <h2 className="mt-7 text-balance text-[clamp(26px,2.35vw,40px)] font-extrabold uppercase leading-[1.08] tracking-[-0.01em] text-[color:var(--auth-panel-ink)]">
                  Uncover every growth bottleneck. Know precisely what to fix for maximum revenue.
                </h2>
                <p className="mt-6 text-[15px] leading-[1.65] text-[color:var(--auth-panel-muted)]">
                  Rankvora AI provides an automated, comprehensive diagnostic of your Shopify storefront. It
                  detects revenue leaks, conversion inhibitors, and technical issues. We don&apos;t just find
                  problems, we deliver actionable, prioritized fix plans.
                </p>
              </div>

              <div className="ml-auto hidden xl:block">
                <AuthInsightCards />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
