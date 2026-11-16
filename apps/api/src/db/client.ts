import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type ClientConfig, Pool, type QueryConfig } from 'pg';
import type { Logger } from 'pino';

import { READINESS_MS } from '../config/app.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Readiness ping, bounded like every readiness check. pg reads `query_timeout` from the query config as well
 * (lib/client.js); @types/pg declares it only on the client config, hence the intersection type. A timed-out client is
 * released with the error, so the pool discards it instead of reusing a stuck connection.
 */
const PING: QueryConfig & Pick<ClientConfig, 'query_timeout'> = {
  text: 'select 1',
  query_timeout: READINESS_MS.checkTimeoutMs,
};

export function createDatabase(url: string, logger: Pick<Logger, 'error'>): DatabaseHandle {
  // connectionTimeoutMillis: waiting for a pool slot or a new connection fails instead of hanging forever (pg's
  // default) while Postgres is unreachable.
  const pool = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  // An idle client that loses its connection (Postgres restart, network) is reported here. Without a listener the
  // pool's 'error' event would be thrown and end the process; the pool replaces the client on the next checkout.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle postgres client error');
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return {
    db,
    async ping() {
      try {
        await pool.query(PING);
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}
