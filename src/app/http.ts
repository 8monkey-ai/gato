type Handler = (request: Request) => Promise<Response>;

export function routeTable(...tables: Record<string, Handler>[]) {
  const routes = new Map<string, Handler>();
  for (const table of tables)
    for (const [path, handler] of Object.entries(table)) {
      if (routes.has(path) || path === "/health")
        throw new Error(`HTTP route ${path} is defined twice`);
      routes.set(path, handler);
    }
  return routes;
}

export function createFetch(options: {
  routes: ReadonlyMap<string, Handler>;
  health: () => { ready: boolean };
  accepting: () => boolean;
}) {
  return async (request: Request): Promise<Response> => {
    if (!options.accepting())
      return new Response("Shutting down", { status: 503 });
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      const health = options.health();
      return Response.json(health, { status: health.ready ? 200 : 503 });
    }
    const handler = options.routes.get(pathname);
    return handler
      ? handler(request)
      : new Response("Not found", { status: 404 });
  };
}
