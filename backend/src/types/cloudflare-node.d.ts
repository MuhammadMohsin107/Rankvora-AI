/**
 * The one piece of `cloudflare:node` that worker.ts uses.
 *
 * `cloudflare:node` is provided by the Workers runtime and has no package to install, so TypeScript
 * cannot find it by itself. This describes only what is called; the full generated types
 * (`wrangler types`) replace it once the Worker has its own configuration.
 */
declare module 'cloudflare:node' {
  import type { Server } from 'node:http';

  /** Turns a Node HTTP server into the handler object a Worker exports as its default. */
  export function httpServerHandler(server: Server): {
    fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response>;
  };
}
