import type { AuthenticatedUser } from '../middleware/authenticate.js';
import type { AdminIdentity } from '../middleware/requireAdmin.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      /** Set ONLY by requireAdmin, after re-reading `users.is_platform_admin` from the database. Its
       * presence is therefore proof of a current grant, not a claim copied out of a token. */
      admin?: AdminIdentity;
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
