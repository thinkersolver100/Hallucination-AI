import { ApiError } from '../api/client';
import type { ExperimentStatus } from '../api/types';
import { STATUS_LABELS } from '../lib/format';

export function ErrorMessage({ error }: { error: Error | undefined | null }) {
  if (!error) return null;
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div role="alert" className="alert">
      <strong>{error.message}</strong>
      {issues.length > 0 && (
        <ul>
          {issues.map((issue, i) => (
            <li key={i}>
              {issue.path ? `${issue.path}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: ExperimentStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABELS[status]}</span>;
}

export function ProgressBar({ done, total, failed }: { done: number; total: number; failed: number }) {
  const percent = total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
  return (
    <div className="progress-wrap">
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label="Items evaluated"
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="muted small">
        {done}/{total} items{failed > 0 ? `, ${failed} failed` : ''}
      </span>
    </div>
  );
}

export function StackedBar({ correct, abstained, incorrect }: { correct: number; abstained: number; incorrect: number }) {
  const total = correct + abstained + incorrect;
  const share = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  const label = `${share(correct).toFixed(0)}% correct, ${share(abstained).toFixed(0)}% abstained, ${share(incorrect).toFixed(0)}% incorrect`;
  return (
    <div className="stack" role="img" aria-label={label} title={label}>
      <span className="seg seg-correct" style={{ width: `${share(correct)}%` }} />
      <span className="seg seg-abstained" style={{ width: `${share(abstained)}%` }} />
      <span className="seg seg-incorrect" style={{ width: `${share(incorrect)}%` }} />
    </div>
  );
}
