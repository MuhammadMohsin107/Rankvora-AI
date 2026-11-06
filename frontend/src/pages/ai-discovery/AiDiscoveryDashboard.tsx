import { AlertOctagon, FileSearch, Lightbulb, Sparkles } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';
import AiReferralsPanel from '../../components/ai-discovery/AiReferralsPanel';
import IndexCoveragePanel from '../../components/ai-discovery/IndexCoveragePanel';
import BotTestPanel from '../../components/ai-discovery/BotTestPanel';
import PromptTrendPanel from '../../components/ai-discovery/PromptTrendPanel';
import ProductReadinessPanel from '../../components/ai-discovery/ProductReadinessPanel';
import AiDiscoverySetupPanel from '../../components/ai-discovery/AiDiscoverySetupPanel';

/**
 * /ai-discovery — the AI Discovery pillar dashboard.
 *
 * Layout comes from components/pillars/PillarDashboard, shared by all five pillars; this file is
 * AI Discovery's name and mark and nothing else. All numbers come from the audit the shared component
 * fetches.
 */

export default function AiDiscoveryDashboard() {
  return (
    <PillarDashboard
      pillar="ai-discovery"
      title="AI Discovery"
      icon={Sparkles}
      kpiIcons={{
        'Open Issues': { icon: Lightbulb, accent: 'warning' },
        'Critical Issues': { icon: AlertOctagon, accent: 'critical' },
        'High Priority': { icon: Sparkles, accent: 'warning' },
        'Areas Measured': { icon: FileSearch, accent: 'info' },
      }}
      /**
       * Live reads that do not come from the audit, in the order a merchant needs them:
       * did AI send anyone (outcome) → does Google have the pages (the precondition) → are
       * assistants naming us (trend) → and the diagnostic for when one of those is wrong.
       *
       * They render in the audit-empty state too, because none of them depends on an audit.
       */
      extraPanels={
        <div className="grid gap-4">
          <AiReferralsPanel />
          <ProductReadinessPanel />
          <IndexCoveragePanel />
          <PromptTrendPanel />
          <BotTestPanel />
          {/* What the merchant supplies: the IndexNow key, the tracked questions, the agent files. */}
          <AiDiscoverySetupPanel />
        </div>
      }
    />
  );
}
