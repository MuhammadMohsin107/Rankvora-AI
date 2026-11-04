import { AlertOctagon, AlertTriangle, FileSearch, Flag, Search } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';

/**
 * /seo — the SEO pillar dashboard.
 *
 * The layout lives in components/pillars/PillarDashboard, which all five pillars render. This file
 * holds only what is SEO's own: its name, its mark and its copy. Nothing here computes or stores a
 * number; every value on the page comes from the audit the shared component fetches.
 */

/** Static copy per sub-pillar — descriptions are page text, never a measurement. */
const areaDescriptions: Record<string, string> = {
  'title-tags': 'Optimize title tags for relevance, uniqueness, and click-through performance.',
  'meta-descriptions': 'Improve search-result descriptions and reduce missing or duplicate metadata.',
  schema: 'Monitor structured data coverage, validation, and rich-result eligibility.',
  'image-alt-text': 'Improve image accessibility and search context with descriptive alt text.',
  canonicals: 'Detect duplicate URLs and canonicalization problems affecting indexing.',
  'handles-redirects': 'Monitor URL handles, redirect chains, and broken destinations.',
  sitemap: 'Monitor sitemap coverage, index status, robots rules, and exclusions.',
  'internal-links': 'Identify broken links, orphan pages, 404s, and linking opportunities.',
};

export default function SeoDashboard() {
  return (
    <PillarDashboard
      pillar="seo"
      title="SEO"
      icon={Search}
      description="Improve your store's search visibility and technical SEO health across every important SEO area."
      areaDescriptions={areaDescriptions}
      healthNote="Resolving critical indexing and metadata issues first will have the largest impact on rankings."
      emptyDescription="Once an audit has measured your store, search-visibility scores and prioritised issues for all 8 SEO areas appear here."
      kpiIcons={{
        'Open Issues': { icon: AlertTriangle, accent: 'warning' },
        'Critical Issues': { icon: AlertOctagon, accent: 'critical' },
        'High Priority': { icon: Flag, accent: 'warning' },
        'Areas Measured': { icon: FileSearch, accent: 'info' },
      }}
    />
  );
}
