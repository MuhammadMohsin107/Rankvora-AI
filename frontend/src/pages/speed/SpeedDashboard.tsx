import { AlertTriangle, Image as ImageIcon, Layers, MousePointerClick, Zap } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';

/**
 * /speed — the Speed pillar dashboard.
 *
 * Layout comes from components/pillars/PillarDashboard, shared by all five pillars; this file is
 * Speed's name and mark and nothing else. All numbers come from the audit the shared component fetches.
 */

export default function SpeedDashboard() {
  return (
    <PillarDashboard
      pillar="speed"
      title="Speed"
      icon={Zap}
      kpiIcons={{
        'Open Issues': { icon: AlertTriangle, accent: 'warning' },
        'Critical Issues': { icon: ImageIcon, accent: 'critical' },
        'High Priority': { icon: MousePointerClick, accent: 'warning' },
        'Areas Measured': { icon: Layers, accent: 'info' },
      }}
    />
  );
}
