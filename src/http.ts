import type { Channel } from "./channels/channel.ts";

type Health = () => { ready: boolean; [key: string]: unknown };

export function serveHttp(port: number, channels: Channel[], health: Health) {
  const routes: Record<
    string,
    { POST: (request: Request) => Promise<Response> }
  > = {};
  for (const channel of channels)
    for (const [path, handler] of Object.entries(channel.routes))
      routes[path] = { POST: handler };
  return Bun.serve({
    port,
    routes: {
      ...routes,
      "/health": {
        GET: () => {
          const status = health();
          return Response.json(status, { status: status.ready ? 200 : 503 });
        },
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}
