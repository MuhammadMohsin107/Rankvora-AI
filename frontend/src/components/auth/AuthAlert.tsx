import { AlertCircle, Info } from 'lucide-react';

/**
 * Form-level banner. Uses an icon + text (not colour alone) to convey the state.
 *
 * `error` is for something that went wrong. `info` is for news that is not a mistake, such as a
 * session that ended on its own.
 */
export default function AuthAlert({ message, tone = 'error' }: { message: string; tone?: 'error' | 'info' }) {
  const info = tone === 'info';
  const Icon = info ? Info : AlertCircle;
  return (
    <div
      role={info ? 'status' : 'alert'}
      className={`auth-rise mb-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 backdrop-blur-sm ${
        info
          ? 'border-brand-100 bg-brand-50/80 shadow-[0_2px_8px_-2px_rgba(79,70,229,0.08)]'
          : 'border-critical-100 bg-critical-50/80 shadow-[0_2px_8px_-2px_rgba(220,38,38,0.08)]'
      }`}
      style={{ animationDuration: '0.35s' }}
    >
      <Icon size={16} strokeWidth={2} className={`mt-px flex-shrink-0 ${info ? 'text-brand-600' : 'text-critical-600'}`} aria-hidden="true" />
      <p className={`text-[13px] leading-5 ${info ? 'text-brand-800' : 'text-critical-700'}`}>{message}</p>
    </div>
  );
}
