import { requestMessages } from '@app/shared';
import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

import { ValidationError, type ValidationIssue } from '../errors/app-error.js';

export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

export type ValidatedInput<S extends RequestSchemas> = {
  [K in keyof RequestSchemas]-?: S[K] extends z.ZodType ? z.output<S[K]> : undefined;
};

export type ValidatedHandler<S extends RequestSchemas> = (
  input: ValidatedInput<S>,
  req: Request,
  res: Response,
) => Promise<void> | void;

type Part = keyof RequestSchemas;
const PARTS = ['params', 'query', 'body'] as const satisfies readonly Part[];

/**
 * Zod issues → `{ field, location, message }` (F-18). `field` is the dotted path as the client knows it; an issue on
 * the whole part (body missing, not an object) is reported on the part itself. Unknown keys of a strict schema
 * become one issue per key, so the client can point at each.
 */
export function toValidationIssues(location: Part, issues: readonly z.core.$ZodIssue[]): ValidationIssue[] {
  return issues.flatMap((issue): ValidationIssue[] => {
    const path = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: [...path, key].join('.'),
        location,
        message: requestMessages.unknownField,
      }));
    }
    return [{ field: path.length > 0 ? path.join('.') : location, location, message: issue.message }];
  });
}

/**
 * Validates params, query and body with Zod and hands the parsed, typed values to the handler. All issues of all
 * parts are collected into one `400 validation-failed`.
 *
 * Why a wrapper instead of mutating `req`: in Express 5 `req.query` is a getter and cannot be reassigned, and a
 * wrapper keeps the parsed types attached to the handler.
 */
export function validate<S extends RequestSchemas>(schemas: S, handler: ValidatedHandler<S>): RequestHandler {
  return async (req, res) => {
    const issues: ValidationIssue[] = [];
    const parsed: Partial<Record<Part, unknown>> = {};

    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        parsed[part] = result.data;
      } else {
        issues.push(...toValidationIssues(part, result.error.issues));
      }
    }

    if (issues.length > 0) throw new ValidationError(issues);
    await handler(parsed as ValidatedInput<S>, req, res);
  };
}
