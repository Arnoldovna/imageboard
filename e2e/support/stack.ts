import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Requests that only the TLS-terminating load balancer of ADR 0019 can make. docker-compose.e2e.yml trusts
 * `127.0.0.1/32` as that load balancer, an address that no request from outside the web container can have. Every
 * spec therefore talks to nginx as an ordinary client, exactly as with the production default, and this probe plays
 * the load balancer by running busybox `wget` inside the web container.
 */

const run = promisify(execFile);

/** The compose project of `pnpm test:e2e` and `pnpm e2e:up` (scripts/run-e2e.mjs, conventions §6). */
const PROJECT = 'imageboard-e2e';

export interface ResponseHeader {
  name: string;
  value: string;
}

async function webContainer(): Promise<string> {
  const { stdout } = await run('docker', [
    'ps',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--filter',
    'label=com.docker.compose.service=web',
  ]);
  const ids = stdout.split('\n').filter((line) => line.trim() !== '');
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) {
    throw new Error(`expected one running web container in ${PROJECT}, found ${String(ids.length)}`);
  }
  return id;
}

/**
 * `GET path` from 127.0.0.1 inside the web container, with `headers`. Returns the response headers in order, repeated
 * ones kept (busybox `wget -S` prints them indented on stderr). Rejects on a non-2xx status.
 */
export async function getAsLoadBalancer(
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<ResponseHeader[]> {
  const headerArgs = Object.entries(headers).flatMap(([name, value]) => ['--header', `${name}: ${value}`]);
  const { stderr } = await run('docker', [
    'exec',
    await webContainer(),
    'wget',
    '-S',
    '-O',
    '/dev/null',
    ...headerArgs,
    `http://127.0.0.1:8080${path}`,
  ]);
  return stderr.split('\n').flatMap((line) => {
    const header = /^\s+([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
    return header?.[1] === undefined ? [] : [{ name: header[1].toLowerCase(), value: header[2] ?? '' }];
  });
}
