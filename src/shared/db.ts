import { Pool, type PoolConfig } from 'pg';
import { STATEMENT_TIMEOUT_MS } from './config.js';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.PG_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('PG_CONNECTION_STRING required (point at the docs_ro role).');
  }
  const config: PoolConfig = {
    connectionString,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: 5_000,
    // Belt to the docs_ro role grants — forces read-only transactions even if a writable role slips in.
    options: '-c default_transaction_read_only=on',
  };
  pool = new Pool(config);
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}
