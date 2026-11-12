/**
 * ─── Word-level before / after diff ──────────────────────────────────
 *
 * Shows what a fix changes in a piece of text: words that are gone are struck through, words that are
 * new are highlighted, and the rest is left alone. Built for the short fields a fix writes (a title, a
 * meta description, alt text), so the comparison is exact, a longest-common-subsequence over words.
 *
 * Above `MAX_CELLS` the exact comparison is not attempted (it grows with the product of the two
 * lengths) and the new text is shown whole, marked as new, instead of freezing the page.
 *
 * Ported from the Replica mockup's `Diff`. It renders real <del> / <ins> elements, so the meaning
 * does not depend on colour alone.
 */

export type DiffPart = { kind: 'same' | 'removed' | 'added'; text: string };

/** A comparison larger than this many cells (words before × words after) is skipped. */
export const MAX_CELLS = 90_000;

/** The diff of `before` to `after`, as runs of text in reading order. Adjacent runs of one kind are merged. */
export function diffWords(before: string, after: string): DiffPart[] {
  if (!before) return after ? [{ kind: 'added', text: after }] : [];
  if (!after) return [{ kind: 'removed', text: before }];

  // Whitespace is kept as its own token so the pieces join back to the original text.
  const a = before.split(/(\s+)/).filter((token) => token !== '');
  const b = after.split(/(\s+)/).filter((token) => token !== '');
  if (a.length * b.length > MAX_CELLS) return [{ kind: 'removed', text: before }, { kind: 'added', text: after }];

  const rows = a.length;
  const cols = b.length;
  // lcs[i][j]: length of the longest common subsequence of a[i…] and b[j…].
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: cols + 1 }, () => 0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('removed', a[i]); i++; }
    else { push('added', b[j]); j++; }
  }
  while (i < rows) push('removed', a[i++]);
  while (j < cols) push('added', b[j++]);
  return parts;
}

export default function TextDiff({ before, after, className = '' }: { before: string; after: string; className?: string }) {
  const parts = diffWords(before, after);
  return (
    <p
      className={`text-[12px] leading-[1.5] text-surface-800 ${className}`.trim()}
      aria-label="Changes: removed text is struck through, added text is highlighted"
    >
      {parts.map((part, index) => {
        if (part.kind === 'removed') return <del key={index} className="rounded-sm bg-critical-50 text-critical-700 decoration-critical-500/70">{part.text}</del>;
        if (part.kind === 'added') return <ins key={index} className="rounded-sm bg-success-50 text-success-700 no-underline">{part.text}</ins>;
        return <span key={index}>{part.text}</span>;
      })}
    </p>
  );
}
