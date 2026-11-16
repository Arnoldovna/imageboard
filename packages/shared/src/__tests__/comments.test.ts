import { describe, expect, it } from 'vitest';

import { CommentDto, CommentPage, CreateCommentBody, fieldMessages } from '../index.js';

const dto = {
  id: 7,
  imageId: 3,
  authorName: 'Kofi',
  body: 'Where does it go?',
  createdAt: '2026-11-07T14:02:00.000Z',
  canDelete: true,
};

describe('CreateCommentBody', () => {
  it('F-29: trims both fields', () => {
    expect(CreateCommentBody.parse({ authorName: ' Noor ', body: '\nTo a very small village.\n' })).toEqual({
      authorName: 'Noor',
      body: 'To a very small village.',
    });
  });

  it('F-29 / B-26: rejects empty and whitespace-only values with field messages', () => {
    const result = CreateCommentBody.safeParse({ authorName: '   ', body: ' \n ' });

    expect(result.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['authorName'], message: fieldMessages.authorName.required },
      { path: ['body'], message: fieldMessages.commentBody.required },
    ]);
  });

  it('F-29: enforces 60 and 1000 code points', () => {
    expect(CreateCommentBody.safeParse({ authorName: 'a'.repeat(60), body: 'b'.repeat(1000) }).success).toBe(true);
    const result = CreateCommentBody.safeParse({ authorName: 'a'.repeat(61), body: 'b'.repeat(1001) });

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      fieldMessages.authorName.tooLong,
      fieldMessages.commentBody.tooLong,
    ]);
  });

  it('F-49: rejects unknown keys', () => {
    expect(CreateCommentBody.safeParse({ authorName: 'a', body: 'b', imageId: 1 }).success).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(CreateCommentBody.safeParse({ authorName: 5, body: ['x'] }).success).toBe(false);
  });
});

describe('CommentDto', () => {
  it('B-27: parses the documented shape and strips unknown keys', () => {
    expect(CommentDto.parse({ ...dto, ownerId: 'x' })).toEqual(dto);
    expect(CommentPage.parse({ items: [dto], nextCursor: 'abc' }).nextCursor).toBe('abc');
  });
});
