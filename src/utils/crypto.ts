import { env } from '../env.js';

export function getEncryptionKey(): string {
  return env.ENCRYPTION_KEY;
}
