import { describe, expect, it } from 'vitest';

import {
  animationTooLarge,
  animationTooLong,
  fieldMessages,
  formatMegabytes,
  PROBLEM_CODES,
  ProblemDetails,
  problemMessages,
  SessionDto,
  uploadTooLarge,
} from '../index.js';

describe('ProblemDetails', () => {
  const problem = {
    type: 'tag:arnoldovna.github.io,2026:imageboard:problem:validation-failed',
    title: 'Validation failed',
    status: 400,
    detail: 'The request contains invalid data.',
    instance: '/api/images',
    code: 'validation-failed',
    requestId: 'c0ffee00',
    errors: [{ field: 'title', location: 'body', message: fieldMessages.title.required }],
  };

  it('F-41: parses an API problem', () => {
    expect(ProblemDetails.parse(problem)).toEqual(problem);
  });

  it('is a tolerant reader: an unknown code and unknown members are kept', () => {
    const parsed = ProblemDetails.parse({ ...problem, code: 'brand-new-code', retryAfter: 30 });

    expect(parsed.code).toBe('brand-new-code');
    expect(parsed['retryAfter']).toBe(30);
  });

  it('rejects bodies that are not problems', () => {
    expect(ProblemDetails.safeParse({ message: 'Bad Gateway' }).success).toBe(false);
  });
});

describe('messages', () => {
  it('has a default detail for every problem code', () => {
    for (const code of PROBLEM_CODES) {
      expect(problemMessages[code]).toMatch(/\.$/);
    }
  });

  it('F-20: formats the upload limit in MB', () => {
    expect(uploadTooLarge(5 * 1024 * 1024)).toBe('The image must be 5 MB or smaller.');
    expect(formatMegabytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatMegabytes(20 * 1024 * 1024)).toBe('20 MB');
  });

  it('names the frame cap', () => {
    expect(animationTooLong(200)).toBe('Animated images can have at most 200 frames.');
  });

  it('names the animation pixel budget in megapixels', () => {
    expect(animationTooLarge(100_000_000)).toBe(
      'Animated images can have at most 100 megapixels in all frames together.',
    );
  });

  it('formats limits with thousands separators', () => {
    expect(fieldMessages.description.tooLong).toBe('Description must be 2,000 characters or fewer.');
    expect(fieldMessages.commentBody.tooLong).toBe('Comment must be 1,000 characters or fewer.');
    expect(fieldMessages.authorName.tooLong).toBe('Name must be 60 characters or fewer.');
  });
});

describe('SessionDto', () => {
  it('parses the session response and strips unknown keys', () => {
    expect(SessionDto.parse({ csrfToken: 'abc', uploadMaxBytes: 5_242_880, ownerId: 'x' })).toEqual({
      csrfToken: 'abc',
      uploadMaxBytes: 5_242_880,
    });
    expect(SessionDto.safeParse({ csrfToken: '', uploadMaxBytes: 1 }).success).toBe(false);
  });
});
