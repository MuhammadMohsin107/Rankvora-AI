import { AlertOctagon, AlertTriangle, FileText, Package } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';

/**
 * /content — the Content pillar dashboard.
 *
 * Layout comes from components/pillars/PillarDashboard, shared by all five pillars; this file is
 * Content's name and mark and nothing else. All numbers come from the audit the shared component fetches.
 */

export default function ContentDashboard() {
  return (
    <PillarDashboard
      pillar="content"
      title="Content"
      icon={FileText}
      kpiIcons={{
        'Open Issues': { icon: AlertTriangle, accent: 'warning' },
        'Critical Issues': { icon: AlertOctagon, accent: 'critical' },
        'High Priority': { icon: Package, accent: 'warning' },
        'Areas Measured': { icon: FileText, accent: 'info' },
      }}
    />
  );
}
