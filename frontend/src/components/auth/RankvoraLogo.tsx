import { BarChart3 } from 'lucide-react';

interface RankvoraLogoProps {
  /** 'dark' renders for the deep-slate brand panel; 'light' for white backgrounds. */
  tone?: 'light' | 'dark';
}

/** The Rankvora AI lockup — same mark, wordmark and tagline as the app sidebar. */
export default function RankvoraLogo({ tone = 'light' }: RankvoraLogoProps) {
  const wordmark = tone === 'dark' ? 'text-white' : 'text-logo-text';
  const accent = tone === 'dark' ? 'text-brand-300' : 'text-logo-mark';
  const tagline = tone === 'dark' ? 'text-white/45' : 'text-surface-400';

  return (
    <span className="inline-flex items-center gap-3">
      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px] bg-logo-mark text-white shadow-sm">
        <BarChart3 size={17} strokeWidth={2.5} aria-hidden="true" />
      </span>
      <span className="flex flex-col justify-center">
        <span className={`text-[22px] font-extrabold leading-[1] tracking-tight ${wordmark}`}>
          Rankvora<span className={accent}> AI</span>
        </span>
        <span className={`mt-[2px] text-[7px] font-semibold uppercase leading-[1.2] tracking-[0.3em] ${tagline}`}>
          Store performance
        </span>
      </span>
    </span>
  );
}
