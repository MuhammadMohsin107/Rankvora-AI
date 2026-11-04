import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Eyebrow and title share one baseline rather than stacking. The eyebrow is a two-word category
 * ("Comparison", "At a glance") that the customer reads together with the title, so giving it its
 * own line cost a line of viewport per section and told them nothing extra.
 */
export function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          {eyebrow && <p className="eyebrow text-brand-600">{eyebrow}</p>}
          <h2 className="section-title">{title}</h2>
        </div>
        {description && <p className="section-subtitle max-w-2xl">{description}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

export function MetricTile({ label, value, detail, tone = 'neutral' }: { label: string; value: string | number; detail?: string; tone?: 'neutral' | 'success' | 'warning' | 'critical' | 'info' }) {
  const toneClass = {
    neutral: 'border-surface-200',
    success: 'border-surface-200',
    warning: 'border-surface-200',
    critical: 'border-surface-200',
    info: 'border-surface-200',
  }[tone];
  // ~64px tall instead of ~86px. Five of these sit above the data on Reports and
  // Integrations, so every pixel here is paid five times before the customer sees a finding.
  return (
    <div className={`rounded-lg border bg-surface-0 px-2.5 py-2 shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)] ${toneClass}`}>
      <p className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">{label}</p>
      <p className="mt-0.5 text-[19px] font-bold leading-[1.15] tracking-tight text-surface-950 tabular-nums">{value}</p>
      {detail && <p className="mt-0.5 text-[11px] leading-[1.35] text-surface-500">{detail}</p>}
    </div>
  );
}

export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'critical' | 'info' }) {
  const classes = {
    neutral: 'bg-surface-100 text-surface-700 border-surface-200',
    success: 'bg-success-50 text-success-700 border-success-100',
    warning: 'bg-warning-50 text-warning-700 border-warning-100',
    critical: 'bg-critical-50 text-critical-700 border-critical-100',
    info: 'bg-info-50 text-info-700 border-info-100',
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-bold ${classes}`}><span className="h-1 w-1 rounded-full bg-current" />{label}</span>;
}

/**
 * The page header for Reports, Integrations and Settings.
 *
 * The eyebrow was dropped: every page already announces itself through the sidebar's active item
 * and the breadcrumb, so a third label above the title cost a line and told the customer nothing
 * they did not know. Title and one supporting line, on the same row as the actions.
 */
export function ModuleHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="page-head border-b border-surface-200 pb-2">
      <div className="min-w-0">
        <h1 className="page-title" title={eyebrow}>{title}</h1>
        <p className="page-subtitle">{description}</p>
      </div>
      {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function Drawer({ open, title, eyebrow, onClose, children }: { open: boolean; title: string; eyebrow?: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="workflow-drawer-title">
      <button className="absolute inset-0 bg-slate-950/30 backdrop-blur-[2px]" onClick={onClose} aria-label="Close details" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col border-l border-surface-200 bg-surface-0 shadow-2xl">
        <div className="flex items-start justify-between gap-2 border-b border-surface-200 px-3 py-2">
          <div className="min-w-0">
            {eyebrow && <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-brand-600">{eyebrow}</p>}
            <h2 id="workflow-drawer-title" className="text-[15px] font-bold leading-tight tracking-tight text-surface-950">{title}</h2>
          </div>
          <button onClick={onClose} className="flex-shrink-0 rounded-md p-1.5 text-surface-400 transition hover:bg-surface-100 hover:text-surface-900" aria-label="Close details"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">{children}</div>
      </aside>
    </div>
  );
}

export function Button({ children, variant = 'primary', onClick, disabled = false, type = 'button' }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; onClick?: () => void; disabled?: boolean; type?: 'button' | 'submit' }) {
  const classes = {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    ghost: 'btn-ghost',
    danger: 'btn-destructive',
  }[variant];
  return <button type={type} onClick={onClick} disabled={disabled} className={classes}>{children}</button>;
}
