import { AlertCircle } from 'lucide-react';
import Button from '../../components/polaris/Button';

interface Props {
  message?: string;
  onRetry?: () => void;
}

export default function DashboardError({ message, onRetry }: Props) {
  return (
    <div className="page-shell">
      <div className="card flex min-h-[240px] flex-col items-center justify-center border border-surface-200 p-6 text-center">
        <div className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-lg bg-critical-50">
          <AlertCircle size={20} className="text-critical-500" />
        </div>
        <h2 className="text-[15px] font-semibold text-surface-900 mb-2">
          Unable to load dashboard
        </h2>
        {message && <p className="text-[12.5px] text-surface-500 max-w-md mb-2">{message}</p>}
        {onRetry && (
          <Button variant="primary" onClick={onRetry}>
            
            Try Again
          </Button>
        )}
      </div>
    </div>
  );
}
