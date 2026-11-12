import type { NextFunction, Request, Response } from 'express';

/**
 * Gives a request that carried no body an empty one, as Express 4 did.
 *
 * Express 4's JSON parser left `req.body = {}` on every request it saw, a POST with no body included.
 * Express 5 leaves it `undefined`. Handlers and request schemas here read `req.body` as an object
 * (`z.object({...})`, `req.body.field`), so without this a body-less POST — "start an audit" is one —
 * would fail validation or throw instead of behaving as it always has.
 *
 * Mounted straight after the JSON parser in app.ts. A route that reads raw bytes (the image upload)
 * runs its own parser later and replaces this.
 */
export function bodyDefault(req: Request, _res: Response, next: NextFunction): void {
  req.body ??= {};
  next();
}
