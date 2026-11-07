import type { Connection } from "./channels/channel.ts";
import { log } from "./log.ts";

export type Health = () => Record<string, unknown> & { ready: boolean };

export function startHttp(
  port: number,
  connections: readonly Connection[],
  health: Health,
) {
  const routes: Record<
    string,
    { POST: (request: Request) => Promise<Response> }
  > = {};
  for (const connection of connections) {
    for (const [path, handle] of Object.entries(connection.routes)) {
      routes[path] = {
        POST: async (request) => {
          try {
            return await handle(request);
          } catch (error) {
            log.error("http.notification_failed", {
              connection: connection.id,
              error,
            });
            return new Response("Not saved", { status: 500 });
          }
        },
      };
    }
  }
  return Bun.serve({
    port,
    routes: {
      ...routes,
      "/health": () => {
        const status = health();
        return Response.json(status, { status: status.ready ? 200 : 503 });
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}
