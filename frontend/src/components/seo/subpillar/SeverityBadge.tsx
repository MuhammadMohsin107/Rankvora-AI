import { AlertOctagon, AlertTriangle, CheckCircle2, Info, Minus, type LucideIcon } from 'lucide-react';
import { severityLabel, type Severity } from '../../../data/seo/subpillar.model';
import { toneStyles, type Tone } from './tone';

const icons: Record<Tone, LucideIcon> = {
  critical: AlertOctagon,
  high: AlertTriangle,
  medium: Info,
  low: Minus,
  healthy: CheckCircle2,
};

interface Props {
  severity: Severity | 'healthy';
  /** Hide the icon for very dense contexts (table cells). */
  showIcon?: boolean;
  className?: string;
}

/**
 * Severity chip. Always pairs colour with a label and an icon shape so
 * severity is never communicated by colour alone.
 */
export default function SeverityBadge({ severity, showIcon = true, className = '' }: Props) {
  const Icon = icons[severity];
  const label = severity === 'healthy' ? 'Healthy' : severityLabel[severity];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-semibold leading-[1.5] ${toneStyles[severity].badge} ${className}`}
    >
      {showIcon && <Icon size={10} strokeWidth={2.4} aria-hidden="true" />}
      {label}
    </span>
  );
}
