import type { ExperimentStatus } from '../api/types';

export function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '–' : `${(value * 100).toFixed(digits)}%`;
}

export function fixed(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? '–' : value.toFixed(digits);
}

export function money(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function when(iso: string | null): string {
  if (!iso) return '–';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '–' : date.toLocaleString();
}

export const STATUS_LABELS: Record<ExperimentStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  budget_exhausted: 'Budget reached',
};

export const CONFIG_LABELS = {
  A: 'A · baseline (closed rubric)',
  B: 'B · baseline (open rubric)',
  C: 'C · consistency mitigation (closed rubric)',
  D: 'D · consistency mitigation (open rubric)',
} as const;
