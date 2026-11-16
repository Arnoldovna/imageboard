import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

/** The last item a client has seen (structurally `KeysetPosition` from `shared/pagination/cursor.ts`). */
export interface KeysetAfter {
  createdAt: Date;
  id: number;
}

/**
 * The page condition for `ORDER BY created_at DESC, id DESC` (ADR 0007, DATA-MODEL §4): rows strictly older than
 * `after`, or no condition for the first page. The row comparison keeps the order total when rows share a timestamp
 * and matches the `(created_at DESC, id DESC)` indexes column for column, so Postgres reads a page straight from the
 * index without a Sort node. The time goes in as an ISO string with an explicit cast, never as a driver-converted
 * `Date`, so the session time zone can never shift it.
 */
export function olderThan(createdAt: AnyColumn, id: AnyColumn, after: KeysetAfter | undefined): SQL | undefined {
  if (after === undefined) return undefined;
  return sql`(${createdAt}, ${id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::integer)`;
}
