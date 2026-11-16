import { fieldMessages } from '@app/shared';

/**
 * Postgres errors arrive wrapped (Drizzle's DrizzleQueryError keeps the driver error as `cause`), so every helper
 * walks the cause chain. SQLSTATE codes: https://www.postgresql.org/docs/18/errcodes-appendix.html
 */
export const PG_ERROR = {
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;

const MAX_CAUSE_DEPTH = 5;

interface PgErrorFields {
  code: string;
  constraint?: string;
}

function findPgError(error: unknown): PgErrorFields | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    // pg's DatabaseError carries `severity`; Node system errors ('EPIPE') also have 5-letter codes but no severity.
    if (
      'severity' in current &&
      'code' in current &&
      typeof current.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      const constraint =
        'constraint' in current && typeof current.constraint === 'string' ? current.constraint : undefined;
      return { code: current.code, ...(constraint ? { constraint } : {}) };
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** The SQLSTATE of a Postgres error anywhere in the cause chain, if any. */
export function pgErrorCode(error: unknown): string | undefined {
  return findPgError(error)?.code;
}

/** The violated constraint's name (unique, foreign key, check), if Postgres reported one. */
export function pgConstraintName(error: unknown): string | undefined {
  return findPgError(error)?.constraint;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_ERROR.foreignKeyViolation;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_ERROR.uniqueViolation;
}

/** A text CHECK violation as the client sees it: the field name it knows and that field's "invalid" message. */
export interface TextCheckViolation {
  field: string;
  message: string;
}

/**
 * CHECK constraints on client-supplied text, by constraint name (DATA-MODEL §2). A violation means Zod and SQL drifted
 * apart; it becomes `400 validation-failed` on that field and is logged at `warn` (ADR 0006). Checks on
 * server-computed columns (object key, MIME type, dimensions) are deliberately absent: violating one is a server bug
 * and stays a 500. A Map, so a name can never resolve to an inherited `Object.prototype` member.
 */
export const TEXT_CHECKS: ReadonlyMap<string, TextCheckViolation> = new Map([
  ['images_author_name_valid', { field: 'authorName', message: fieldMessages.authorName.invalid }],
  ['images_title_valid', { field: 'title', message: fieldMessages.title.invalid }],
  ['images_description_valid', { field: 'description', message: fieldMessages.description.invalid }],
  ['comments_author_name_valid', { field: 'authorName', message: fieldMessages.authorName.invalid }],
  ['comments_body_valid', { field: 'body', message: fieldMessages.commentBody.invalid }],
]);

/** The client field and message behind a text CHECK violation, or undefined for any other error. */
export function textCheckViolation(error: unknown): TextCheckViolation | undefined {
  const pgError = findPgError(error);
  if (pgError?.code !== PG_ERROR.checkViolation || pgError.constraint === undefined) return undefined;
  return TEXT_CHECKS.get(pgError.constraint);
}
