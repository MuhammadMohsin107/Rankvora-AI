import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodType } from 'zod';

export type RequestSchemas = {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
};

export class RequestValidationError extends Error {
  readonly statusCode = 400;
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
    this.issues = issues;
  }
}

export function validateRequest(schemas: RequestSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsedValues: Partial<Record<keyof RequestSchemas, unknown>> = {};
    const issues: z.core.$ZodIssue[] = [];

    for (const key of ['body', 'params', 'query'] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (result.success) parsedValues[key] = result.data;
      else issues.push(...result.error.issues.map((issue) => ({ ...issue, path: [key, ...issue.path] })));
    }

    if (issues.length > 0) {
      next(new RequestValidationError(issues));
      return;
    }

    // Express 5 made `req.query` a read-only getter on the request, so assigning to it throws. The
    // parsed (coerced, defaulted) query is placed on the request itself instead, where it shadows the
    // getter and reads exactly as it did before. `body` and `params` are ordinary properties.
    const { query: parsedQuery, ...assignable } = parsedValues;
    Object.assign(req, assignable);
    if ('query' in parsedValues) {
      Object.defineProperty(req, 'query', { value: parsedQuery, writable: true, configurable: true, enumerable: true });
    }
    next();
  };
}
