import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

type Handler = (request: Request) => Promise<Response>;

const since = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const sinceBody = z.object({ since });
const mergeBody = z.object({
  connectionId: z.string().min(1),
  fromChatId: z.string().min(1),
  intoChatId: z.string().min(1),
});

const digest = (text: string) => createHash("sha256").update(text).digest();
const badRequest = (error: string) => Response.json({ error }, { status: 400 });

async function parse<T>(schema: z.ZodType<T>, request: Request) {
  const body: unknown = await request.json().catch(() => undefined);
  const result = schema.safeParse(body);
  return result.success
    ? result.data
    : badRequest(z.prettifyError(result.error));
}

function guard(token: string, method: string, handle: Handler): Handler {
  const expected = digest(`Bearer ${token}`);
  return async (request) => {
    const given = digest(request.headers.get("authorization") ?? "");
    if (!timingSafeEqual(given, expected))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (request.method !== method)
      return Response.json({ error: `use ${method}` }, { status: 405 });
    return handle(request);
  };
}

export function opsRoutes(deps: {
  token: string;
  failedNudges: (since: Date) => Promise<unknown>;
  retryFailedNudges: (since: Date) => Promise<unknown>;
  merge: (
    connectionId: string,
    fromChatId: string,
    intoChatId: string,
  ) => Promise<void>;
  inspect: () => Promise<unknown>;
}): Record<string, Handler> {
  const route = (method: string, handle: Handler) =>
    guard(deps.token, method, handle);
  return {
    "/ops/nudges/failed": route("GET", async (request) => {
      const query = new URL(request.url).searchParams.get("since");
      const parsed = since.safeParse(query);
      if (!parsed.success) return badRequest("since must be an ISO-8601 time");
      return Response.json(await deps.failedNudges(parsed.data));
    }),
    "/ops/nudges/retry": route("POST", async (request) => {
      const body = await parse(sinceBody, request);
      if (body instanceof Response) return body;
      return Response.json(await deps.retryFailedNudges(body.since));
    }),
    "/ops/merge": route("POST", async (request) => {
      const body = await parse(mergeBody, request);
      if (body instanceof Response) return body;
      try {
        await deps.merge(body.connectionId, body.fromChatId, body.intoChatId);
      } catch (error) {
        return badRequest(
          error instanceof Error ? error.message : String(error),
        );
      }
      return Response.json({ merged: true });
    }),
    "/ops/chats": route("GET", async () => Response.json(await deps.inspect())),
  };
}
