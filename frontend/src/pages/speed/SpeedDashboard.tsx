import { AlertTriangle, Image as ImageIcon, Layers, MousePointerClick, Zap } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';

/**
 * /speed — the Speed pillar dashboard.
 *
 * Layout comes from components/pillars/PillarDashboard, shared by all five pillars; this file is
 * Speed's copy and nothing else. All numbers come from the audit the shared component fetches.
 */

/**
 * Static copy per sub-pillar — page text, never a measurement.
 *
 * EACH LINE DESCRIBES WHAT ITS CHECK ACTUALLY MEASURES. They did not, and the gap was the same
 * overclaiming the integration catalogue was corrected for: "across every page" when PageSpeed
 * measures the storefront home page on two devices; "legacy-format images" and "compressed" when
 * the check reads source dimensions from the Admin API; "blocking, heavy, or unused code" when it
 * detects that an app embed EXISTS, not what its bundle costs; "redundant fonts and missing
 * lazy-load coverage" when neither is visible without a rendered page — the check's own header
 * says so. A description is a promise about the number beside it.
 */
const areaDescriptions: Record<string, string> = {
  cwv: 'LCP, INP and CLS for your storefront, measured by Google on mobile and desktop.',
  'image-weight': 'Product images whose source is far larger than any page displays them at.',
  'app-bloat': 'App embeds and hardcoded layout scripts that load on every single page.',
  'theme-weight': 'Theme scripts, stylesheets and fonts heavy enough to delay first paint.',
};

export default function SpeedDashboard() {
  return (
    <PillarDashboard
      pillar="speed"
      title="Speed"
      icon={Zap}
      description="Core Web Vitals measured by Google, plus the theme and app weight behind them."
      areaDescriptions={areaDescriptions}
      healthNote="Resolving critical issues first will have the largest impact on page experience and rankings."
      emptyDescription="Once an audit has measured your store, performance scores and prioritised issues for all 4 speed areas appear here."
      kpiIcons={{
        'Open Issues': { icon: AlertTriangle, accent: 'warning' },
        'Critical Issues': { icon: ImageIcon, accent: 'critical' },
        'High Priority': { icon: MousePointerClick, accent: 'warning' },
        'Areas Measured': { icon: Layers, accent: 'info' },
      }}
    />
  );
}
