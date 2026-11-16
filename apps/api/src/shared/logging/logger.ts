import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import type { Env } from '../../config/env.js';

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'req.headers["x-forwarded-for"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.secret',
      ],
      censor: '[redacted]',
    },
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Paths whose successful responses are noise (probes every few seconds); failures are still logged. */
const QUIET_ON_SUCCESS = /^\/api\/health(?:\/|\?|$)/;

function originalUrl(req: IncomingMessage): string {
  return (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
}

export function createRequestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    // Accept a well-formed upstream id (nginx $request_id, load balancer), otherwise create one; echo it back.
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    customLogLevel: (req, res, error) => {
      if (error !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode < 400 && QUIET_ON_SUCCESS.test(originalUrl(req))) return 'silent';
      return 'info';
    },
  });
}
