import { AlertTriangle, Flag, Layers, Target } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';

/**
 * /cro — the CRO pillar dashboard.
 *
 * Layout comes from components/pillars/PillarDashboard, shared by all five pillars; this file is
 * CRO's copy and nothing else. All numbers come from the audit the shared component fetches.
 *
 * CRO has eleven sub-pillars, the most of any pillar — the shared four-column area grid is what
 * brings that from six rows down to three.
 */

/**
 * Static copy per sub-pillar — descriptions are page text, never a measurement.
 *
 * Taken verbatim from the descriptions each CRO sub-pillar page already shows
 * (pages/pillarCatalogs/croCatalog.ts), so the card and the page it opens say the same thing.
 */
const areaDescriptions: Record<string, string> = {
  clarity: 'Remove hesitation by making the next action obvious across the storefront.',
  'cart-recovery': 'Recover high-intent shoppers with complete, timely, and measurable recovery flows.',
  trust: 'Make confidence visible with reviews, trust signals, and evidence close to the buying decision.',
  returns: 'Make returns easy to understand and complete without unnecessary support friction.',
  tracking: 'Keep customers informed after checkout with reliable tracking and proactive updates.',
  cod: 'Reduce failed deliveries and fraud risk with a clearer, better-validated COD checkout.',
  options: 'Help shoppers choose confidently with complete variants, guides, and relevant add-ons.',
  subscription: 'Turn replenishment behavior into a clear, convenient recurring purchase option.',
  wishlist: 'Capture save-for-later intent and bring high-intent shoppers back to the catalog.',
  locator: 'Make physical locations easy to find with complete, trustworthy location information.',
  'mobile-ux': 'Remove mobile friction from tap targets, layout, and mobile conversion paths.',
};

export default function CroDashboard() {
  return (
    <PillarDashboard
      pillar="cro"
      title="CRO"
      icon={Target}
      description="Find and prioritize the moments that help more shoppers understand, trust, and complete their purchase."
      areaDescriptions={areaDescriptions}
      healthNote="Resolving critical checkout and recovery issues first will have the largest conversion impact."
      emptyDescription="Once an audit has measured your store, conversion scores and prioritised issues for all 11 CRO areas appear here."
      kpiIcons={{
        'Open Issues': { icon: Target, accent: 'warning' },
        'Critical Issues': { icon: AlertTriangle, accent: 'critical' },
        'High Priority': { icon: Flag, accent: 'warning' },
        'Areas Measured': { icon: Layers, accent: 'info' },
      }}
    />
  );
}
