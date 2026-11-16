import { randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { IncomingMessage } from 'node:http';

import { pino, type DestinationStream, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import type { Env } from '../../config/env.js';

/** Never logged in clear (F-46): session and CSRF material, credentials, the proxy chain with client addresses. */
export const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-forwarded-for"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
] as const;

/** `destination` is for tests that capture output; production writes JSON to stdout (pretty in development). */
export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, destination?: DestinationStream): Logger {
  const options = {
    level: env.LOG_LEVEL,
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
  };
  if (destination) return pino(options, destination);
  return pino({ ...options, ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}) });
}

/**
 * IP minimisation (ADR 0019): IPv4 to its /24, IPv6 to its /48; IPv4-mapped IPv6 is treated as IPv4. Rate limiting
 * still sees the full address; only logs are truncated.
 */
export function truncateIp(address: string | undefined): string | undefined {
  if (address === undefined || address === '') return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped?.[1] ?? address;
  if (isIPv4(ip)) return `${ip.split('.').slice(0, 3).join('.')}.0`;
  if (isIPv6(ip)) return `${expandIpv6(ip).slice(0, 3).join(':')}::`;
  return undefined;
}

/** An embedded dotted IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is 32 bits, i.e. two hex groups. */
const DOTTED_TAIL = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

function withHexTail(ip: string): string {
  return ip.replace(DOTTED_TAIL, (_match, a: string, b: string, c: string, d: string) => {
    const group = (high: string, low: string) => ((Number(high) << 8) | Number(low)).toString(16);
    return `${group(a, b)}:${group(c, d)}`;
  });
}

/**
 * Eight groups without leading zeros, so `2001:db8::1` and `2001:0db8:0:0::1` truncate the same way. The dotted tail
 * is converted first, so it counts as the two groups it is when `::` is expanded.
 */
function expandIpv6(address: string): string[] {
  const ip = withHexTail(address);
  const [head = '', tail = ''] = ip.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = ip.includes('::') && tail !== '' ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups]
    : headGroups;
  return groups.map((group) => Number.parseInt(group, 16).toString(16));
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Probes and media are noise when they succeed (health every few seconds, 12 to 24 previews per page). */
const QUIET_ON_SUCCESS = /^\/api\/(?:health|media)(?:\/|\?|$)/;

type ExpressishRequest = IncomingMessage & { originalUrl?: string; ip?: string };

function originalUrl(req: ExpressishRequest): string {
  return req.originalUrl ?? req.url ?? '';
}

interface SerializedRequestLike {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  remoteAddress?: string;
  raw?: ExpressishRequest;
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
    serializers: {
      // The client address behind TRUST_PROXY hops (req.ip), truncated; never the port or x-forwarded-for.
      req: (req: SerializedRequestLike) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        headers: req.headers,
        remoteAddress: truncateIp(req.raw?.ip ?? req.remoteAddress),
      }),
    },
  });
}
