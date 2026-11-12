/**
 * ─── How a search result reads ───────────────────────────────────────
 *
 * A rough picture of one Google result — the blue title, the green address, the grey description —
 * so a merchant can judge a title or meta description in context rather than as a bare string.
 *
 * It draws only what it is given. A fix writes ONE field, so the other is left out rather than
 * invented: a title fix shows no description line, a description fix shows no title. The title is
 * cut with an ellipsis on one line, as a search engine cuts it, and the description at two lines.
 * It is an approximation: engines cut by pixel width, and may rewrite either field.
 *
 * Ported from the Replica mockup's `SerpPreview`.
 */
export default function SerpPreview({ title, description, address }: { title?: string; description?: string; address?: string }) {
  if (!title && !description) return null;
  return (
    <div className="max-w-[40rem] rounded-md border border-surface-200 bg-surface-0 px-3 py-2" role="img" aria-label="Search result preview">
      {address && <p className="truncate text-[11px] leading-[1.4] text-surface-600">{address}</p>}
      {title && <p className="truncate text-[15px] font-medium leading-[1.35] text-info-600">{title}</p>}
      {description && <p className="line-clamp-2 text-[12px] leading-[1.45] text-surface-600">{description}</p>}
    </div>
  );
}
