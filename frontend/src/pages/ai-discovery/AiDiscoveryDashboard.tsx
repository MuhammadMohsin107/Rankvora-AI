import { AlertOctagon, FileSearch, Lightbulb, Sparkles } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';
import AiReferralsPanel from '../../components/ai-discovery/AiReferralsPanel';
import IndexCoveragePanel from '../../components/ai-discovery/IndexCoveragePanel';
import BotTestPanel from '../../components/ai-discovery/BotTestPanel';
import PromptTrendPanel from '../../components/ai-discovery/PromptTrendPanel';
import ProductReadinessPanel from '../../components/ai-discovery/ProductReadinessPanel';
import { pillarMeta } from '../../data/pillarMeta';

/**
 * /ai-discovery — the AI Discovery pillar dashboard.
 *
 * Layout comes from components/pillars/PillarDashboard, shared by all five pillars; this file is
 * AI Discovery's copy and nothing else. All numbers come from the audit the shared component
 * fetches.
 */

/**
 * Static copy per sub-pillar — page text, never a measurement.
 *
 * EACH LINE DESCRIBES WHAT ITS OWN CHECK READS, and nothing a neighbouring one reads. Two were
 * describing other sub-pillars' work: agents-md claimed "AI-crawler access", which is
 * indexing-freshness, plus "directive coverage", which nothing measures; agentic-attrs claimed
 * "identifier" signals, which is the feed check — its own header is explicit that the two come
 * apart, and it reads no barcode, GTIN or SKU at all. A description sits directly above the score
 * it belongs to, so it is read as a description of that score.
 */
const areaDescriptions: Record<string, string> = {
  'agents-md': 'What your storefront root returns when an assistant asks for agents.md and llms.txt.',
  'agentic-attrs': 'Whether an agent that found a product can act on it: stock, variants it can tell apart, a readable offer.',
  'answerable-qa': 'Whether descriptions answer pre-purchase questions, and whether any page renders FAQ structured data.',
  feed: 'Identifiers, price and availability, read from real variant data, so agents can match and compare.',
  'indexing-freshness': 'Which named AI and search crawlers robots.txt admits, and whether your sitemap dates match your catalog.',
  indexnow: 'Whether your IndexNow key file is published and matching, so instant submissions authenticate.',
  'prompt-tracking': 'How often assistants name this store when asked your own shopper questions.',
};

export default function AiDiscoveryDashboard() {
  return (
    <PillarDashboard
      pillar="ai-discovery"
      title="AI Discovery"
      icon={Sparkles}
      description="Make your catalog readable, quotable, and purchasable for AI assistants and shopping agents."
      areaDescriptions={areaDescriptions}
      // No healthNote. It said "resolving critical crawler-access and attribute gaps first will have
      // the largest impact" on every store, including ones with no crawler or attribute issue at
      // all — a ranking of impact nobody measured. Priority Issues above already orders the real
      // findings by severity.
      // Seven, not four. The four was copied from the Speed dashboard, which genuinely has four,
      // and told a merchant looking at an empty page the wrong size of the thing they were about
      // to get.
      // Counted from the pillar's own list, so the number cannot drift from the areas it describes.
      emptyDescription={`Once an audit has measured your store, AI-readiness scores and prioritised issues for all ${pillarMeta['ai-discovery'].subPillars.length} AI discovery areas appear here.`}
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
        </div>
      }
    />
  );
}
