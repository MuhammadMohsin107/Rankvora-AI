import { AlertOctagon, AlertTriangle, FileSearch, Flag, Search } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';

/**
 * /seo — the SEO pillar dashboard.
 *
 * The layout lives in components/pillars/PillarDashboard, which all five pillars render. This file
 * holds only what is SEO's own: its name and its mark. Nothing here computes or stores a
 * number; every value on the page comes from the audit the shared component fetches.
 */

export default function SeoDashboard() {
  return (
    <PillarDashboard
      pillar="seo"
      title="SEO"
      icon={Search}
      kpiIcons={{
        'Open Issues': { icon: AlertTriangle, accent: 'warning' },
        'Critical Issues': { icon: AlertOctagon, accent: 'critical' },
        'High Priority': { icon: Flag, accent: 'warning' },
        'Areas Measured': { icon: FileSearch, accent: 'info' },
      }}
    />
  );
}
