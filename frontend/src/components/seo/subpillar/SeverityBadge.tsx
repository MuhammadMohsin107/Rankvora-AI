import Badge from '../../polaris/Badge';
import { severityLabel, type Severity } from '../../../data/seo/subpillar.model';
import { severityBadgeTone } from './tone';

interface Props {
  severity: Severity | 'healthy';
}

/**
 * Severity label: a Polaris badge whose tone is the severity (critical, high, medium, low, healthy).
 * The label always says it in words as well, so severity is never communicated by colour alone.
 */
export default function SeverityBadge({ severity }: Props) {
  const label = severity === 'healthy' ? 'Healthy' : severityLabel[severity];
  return <Badge tone={severityBadgeTone[severity]}>{label}</Badge>;
}
