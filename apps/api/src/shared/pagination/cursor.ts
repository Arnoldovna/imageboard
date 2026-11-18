import { CursorPayload } from '@app/shared';

import { InvalidCursorError } from '../errors/app-error.js';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Keyset position for `ORDER BY created_at DESC, id DESC` (ADR 0007): the last item the client has seen. */
export interface KeysetPosition {
  createdAt: Date;
  id: number;
}

export function encodeCursor({ createdAt, id }: KeysetPosition): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Opaque base64url JSON `{ t, id }`. Any failure is `400 invalid-cursor`, never a 500 (F-44, B-13). */
export function decodeCursor(raw: string): KeysetPosition {
  try {
    if (!BASE64URL.test(raw)) throw new Error('not base64url');
    const payload = CursorPayload.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { createdAt: new Date(payload.t), id: payload.id };
  } catch (error) {
    throw new InvalidCursorError(error);
  }
}

/** Repositories fetch `limit + 1` rows; the extra row only signals that another page exists (B-46). */
export function toPage<T extends KeysetPosition>(rows: readonly T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
