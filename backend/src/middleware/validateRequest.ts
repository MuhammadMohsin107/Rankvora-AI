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

    Object.assign(req, parsedValues);
    next();
  };
}

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
