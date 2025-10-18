import { logger } from './logger.js';

type MetricsAdapter = {
  count: (name: string, value: number) => void;
  timing?: (name: string, value: number) => void;
};

let adapter: MetricsAdapter | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function recordCount(name: string, value: number): void {
  if (!isFiniteNumber(value)) {
    return;
  }

  if (adapter) {
    adapter.count(name, value);
    return;
  }

  logger.info({ metric: name, value }, '[METRIC] count');
}

function recordTiming(name: string, value: number): void {
  if (!isFiniteNumber(value)) {
    return;
  }

  if (adapter?.timing) {
    adapter.timing(name, value);
    return;
  }

  logger.info({ metric: name, value }, '[METRIC] timing');
}

export const metrics = {
  setAdapter(nextAdapter: MetricsAdapter | null): void {
    adapter = nextAdapter;
  },

  count(name: string, value: number): void {
    recordCount(name, value);
  },

  timing(name: string, value: number): void {
    recordTiming(name, value);
  },

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      recordTiming(name, Date.now() - start);
    }
  },
};
