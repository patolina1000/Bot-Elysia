import { logger } from './logger.js';

type MetricsAdapter = {
  count: (name: string, value: number) => void;
};

let adapter: MetricsAdapter | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export const metrics = {
  setAdapter(nextAdapter: MetricsAdapter | null): void {
    adapter = nextAdapter;
  },

  count(name: string, value: number): void {
    if (!isFiniteNumber(value)) {
      return;
    }

    if (adapter) {
      adapter.count(name, value);
      return;
    }

    logger.info({ metric: name, value }, '[METRIC] count');
  },
};
