import type { Pool } from 'pg';
import { pool } from '../../db/pool.js';

let sharedPool: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (!sharedPool) {
    sharedPool = pool;
  }
  return sharedPool;
}

export { pool };
