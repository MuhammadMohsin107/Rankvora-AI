import type { AuthenticatedUser } from '../middleware/authenticate.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      /** Raw request body bytes, captured by server.ts's express.json({verify}) — needed to
       * check Shopify webhook HMAC signatures, which are computed over the exact raw bytes. */
      rawBody?: Buffer;
      /** Set by middleware/requestLog.ts on every request, and returned as `X-Request-Id`. The
       * value that ties a request's access line to any error logged while it ran. */
      requestId?: string;
    }
  }
}

export {};
