import type { Logger } from 'pino';
import { createClient } from 'redis';

function createRedisClient(url: string) {
  return createClient({ url });
}

/** Derive the type from the factory: node-redis generics differ by RESP version and modules. */
export type RedisClient = ReturnType<typeof createRedisClient>;

/**
 * Creates, observes and connects a client. The 'error' listener is mandatory: node-redis emits 'error' on every lost
 * connection (it reconnects on its own), and an 'error' event without a listener is thrown and ends the process.
 * The composition root and the test app both connect through here, so neither can forget it.
 */
export async function connectRedis(url: string, name: string, logger: Pick<Logger, 'error'>): Promise<RedisClient> {
  const client = createRedisClient(url);
  client.on('error', (error: unknown) => {
    logger.error({ err: error, redis: name }, 'redis error');
  });
  await client.connect();
  return client;
}
