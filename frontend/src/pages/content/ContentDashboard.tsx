import { AlertOctagon, AlertTriangle, FileText, Package } from 'lucide-react';
import PillarDashboard from '../../components/pillars/PillarDashboard';

/**
 * /content — the Content pillar dashboard.
 *
 * Layout comes from components/pillars/PillarDashboard, shared by all five pillars; this file is
 * Content's copy and nothing else. All numbers come from the audit the shared component fetches.
 */

/** Static copy per sub-pillar — descriptions are page text, never a measurement. */
const areaDescriptions: Record<string, string> = {
  'product-descriptions': 'Depth, uniqueness, and completeness of on-page product copy.',
  'collection-descriptions': 'Category-page copy that supports search intent and browsing.',
  // This line has always been here; the sub-pillar it describes was the one never registered.
  metafields: 'How much of the catalog fills in each metafield the store actually uses.',
  'dup-templated': 'Pages that repeat or lightly reword the same boilerplate copy.',
  'blog-freshness': 'How current your blog and buying-guide content is for readers.',
  'media-richness': 'Image, gallery, and video coverage across the product catalog.',
};

export default function ContentDashboard() {
  return (
    <PillarDashboard
      pillar="content"
      title="Content"
      icon={FileText}
      description="Improve the depth, uniqueness, and richness of your product & brand copy across every content area."
      areaDescriptions={areaDescriptions}
      healthNote="Resolving critical issues first will have the largest impact on catalog quality and conversion."
      emptyDescription="Once an audit has measured your store, content quality scores and prioritised issues for all 6 content areas appear here."
      kpiIcons={{
        'Open Issues': { icon: AlertTriangle, accent: 'warning' },
        'Critical Issues': { icon: AlertOctagon, accent: 'critical' },
        'High Priority': { icon: Package, accent: 'warning' },
        'Areas Measured': { icon: FileText, accent: 'info' },
      }}
    />
  );
}
