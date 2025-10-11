import { env } from '../env.js';

export function getEncryptionKey(): string {
  return env.ENCRYPTION_KEY;
}

export function maskToken(token: string | null | undefined): string {
  const raw = typeof token === 'string' ? token : '';
  if (!raw) {
    return '';
  }
  const visible = Math.min(4, raw.length);
  const maskedPart = raw.length - visible;
  return `${'*'.repeat(Math.max(maskedPart, 0))}${raw.slice(-visible)}`;
}
