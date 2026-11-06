import { AlertTriangle, Flag, Layers, Target } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';

/**
 * /cro — the CRO pillar dashboard.
 *
 * Layout comes from components/pillars/PillarDashboard, shared by all five pillars; this file is
 * CRO's name and mark and nothing else. All numbers come from the audit the shared component fetches.
 *
 * CRO has eleven sub-pillars, the most of any pillar — the shared four-column area grid is what
 * brings that from six rows down to three.
 */

export default function CroDashboard() {
  return (
    <PillarDashboard
      pillar="cro"
      title="CRO"
      icon={Target}
      kpiIcons={{
        'Open Issues': { icon: Target, accent: 'warning' },
        'Critical Issues': { icon: AlertTriangle, accent: 'critical' },
        'High Priority': { icon: Flag, accent: 'warning' },
        'Areas Measured': { icon: Layers, accent: 'info' },
      }}
    />
  );
}
