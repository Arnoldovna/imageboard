import { fieldMessages } from '@app/shared';
import { describe, expect, it } from 'vitest';

import {
  isForeignKeyViolation,
  isUniqueViolation,
  pgConstraintName,
  pgErrorCode,
  TEXT_CHECKS,
  textCheckViolation,
} from '../db-errors.js';

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('driver message'), { severity: 'ERROR', code, constraint });
}

describe('Postgres error helpers', () => {
  it('finds the SQLSTATE through the Drizzle cause chain', () => {
    const wrapped = new Error('Failed query', { cause: new Error('middle', { cause: pgError('23503') }) });

    expect(pgErrorCode(wrapped)).toBe('23503');
    expect(isForeignKeyViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped)).toBe(false);
  });

  it('ignores Node system errors that also have five-letter codes', () => {
    expect(pgErrorCode(Object.assign(new Error('pipe'), { code: 'EPIPE' }))).toBeUndefined();
  });

  it('returns undefined for non-errors and plain errors', () => {
    expect(pgErrorCode(undefined)).toBeUndefined();
    expect(pgErrorCode('23505')).toBeUndefined();
    expect(pgErrorCode(new Error('x'))).toBeUndefined();
  });

  it('reads the constraint name', () => {
    expect(pgConstraintName(new Error('q', { cause: pgError('23505', 'images_object_key_key') }))).toBe(
      'images_object_key_key',
    );
  });

  it.each([
    ['images_author_name_valid', 'authorName', fieldMessages.authorName.invalid],
    ['images_title_valid', 'title', fieldMessages.title.invalid],
    ['images_description_valid', 'description', fieldMessages.description.invalid],
    ['comments_author_name_valid', 'authorName', fieldMessages.authorName.invalid],
    ['comments_body_valid', 'body', fieldMessages.commentBody.invalid],
  ])('maps CHECK %s to the client field %s and its message', (constraint, field, message) => {
    expect(textCheckViolation(new Error('q', { cause: pgError('23514', constraint) }))).toEqual({ field, message });
  });

  it('knows exactly the text checks listed above', () => {
    expect(TEXT_CHECKS.size).toBe(5);
  });

  it('does not map checks on server-computed columns, inherited names or other error codes', () => {
    expect(textCheckViolation(pgError('23514', 'images_object_key_format'))).toBeUndefined();
    expect(textCheckViolation(pgError('23514', 'constructor'))).toBeUndefined();
    expect(textCheckViolation(pgError('23505', 'images_title_valid'))).toBeUndefined();
  });
});
