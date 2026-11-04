import type { Server } from "bun";
import { z } from "zod";

import { type ChannelAdapter, connectionPath } from "../channel/adapter.ts";
import { type Env, integer, readEnv } from "../config/env.ts";
import type { Logger } from "../log/logger.ts";

type Handler = (request: Request) => Response | Promise<Response>;

export function readPort(env: Env = process.env): number {
  return readEnv(
    "GATO_PORT",
    integer.pipe(z.int().min(0).max(65_535)).default(3000),
    env,
  );
}

/** One HTTP server for the routes of all adapters, each under `/<kind>/<connection>`. */
export function httpServer(
  adapters: readonly ChannelAdapter[],
  port: number,
  logger: Logger,
) {
  const routes = mountRoutes(adapters);
  let server: Server<undefined> | undefined;
  return {
    /** Defined while the server runs. */
    get url(): URL | undefined {
      return server?.url;
    },
    start() {
      server = Bun.serve({
        port,
        routes,
        fetch: () => new Response("Not Found", { status: 404 }),
        error(error) {
          logger.error({ err: error }, "request failed");
          return new Response("Internal Server Error", { status: 500 });
        },
      });
      logger.info({ port: server.port }, "listening");
    },
    /** Stops accepting connections and waits for open requests. */
    async stop() {
      await server?.stop();
      server = undefined;
    },
  };
}

function mountRoutes(
  adapters: readonly ChannelAdapter[],
): Record<string, Record<string, Handler>> {
  const routes: Record<string, Record<string, Handler>> = {};
  for (const adapter of adapters) {
    for (const route of adapter.routes()) {
      const path = `${connectionPath(adapter)}${route.path}`;
      const methods = (routes[path] ??= {});
      if (methods[route.method]) {
        throw new Error(`Route ${route.method} ${path} is declared twice`);
      }
      methods[route.method] = (request) => route.handle(request);
    }
  }
  return routes;
}
