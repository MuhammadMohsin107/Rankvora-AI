import { Navigate, useParams } from 'react-router-dom';
import { seoAnalyses } from '../../data/seo/analyses';
import AltTextTemplateBuilder from '../../components/seo/AltTextTemplateBuilder';
import SchemaTemplateBuilder from '../../components/seo/SchemaTemplateBuilder';
import SeoSubPillarPage from './SeoSubPillarPage';

/**
 * Resolves an SEO sub-pillar slug to its analysis and renders the shared
 * master template. Unknown slugs fall back to the SEO pillar dashboard.
 */

/**
 * Sub-pillars that own a configuration surface, rendered into the template's `configurator` slot.
 *
 * A lookup rather than a conditional inside the shared page: the template stays identical for all
 * eight sub-pillars, and adding a builder to another one is an entry here.
 */
const configurators: Record<string, React.ReactNode> = {
  'image-alt-text': <AltTextTemplateBuilder />,
  // Schema settings live beside the schema AUDIT rather than on a page of their own: the audit
  // says what the storefront renders today, this says what Rankvora AI would generate. Reading one
  // without the other is how a merchant ends up configuring schema they already have.
  schema: <SchemaTemplateBuilder />,
};

export default function SeoSubPillarRoute() {
  const { subPillar } = useParams<{ subPillar: string }>();
  const analysis = subPillar ? seoAnalyses[subPillar] : undefined;

  if (!analysis) return <Navigate to="/seo" replace />;

  // key forces a clean remount (and reload) when moving between sub-pillars.
  return <SeoSubPillarPage key={analysis.slug} analysis={analysis} configurator={configurators[analysis.slug]} />;
}
