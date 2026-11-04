import { z } from "zod";

import type { SendOutcome } from "../channel.ts";
import { type Contact, contactSchema } from "./payloads.ts";

type ApiOptions = {
  apiUrl: string;
  apiToken: string;
  channelId?: number;
  fetch?: Fetch;
  now?: () => Date;
};

type ApiRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<Response>;
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const timeoutMs = 15_000;
const sendResponse = z.object({ messageId: z.union([z.number(), z.string()]) });

export type RespondioApi = ReturnType<typeof createRespondioApi>;

async function errorText(response: Response) {
  const body = await response.text().catch(() => "");
  return `respond.io answered ${response.status}: ${body.slice(0, 200)}`;
}

async function expectOk(response: Response) {
  if (!response.ok) throw new Error(await errorText(response));
  return response;
}

function retryAfterMs(response: Response) {
  const seconds = Number(response.headers.get("Retry-After") ?? "1");
  return Number.isFinite(seconds) ? seconds * 1000 : 1000;
}

async function sendOutcome(
  response: Response,
  now: () => Date,
): Promise<SendOutcome> {
  if (response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const messageId = sendResponse.safeParse(body).data?.messageId;
    return {
      status: "sent",
      platformId: messageId === undefined ? undefined : String(messageId),
      sentAt: now(),
    };
  }
  const error = await errorText(response);
  if (response.status === 429 || response.status === 449)
    return { status: "failed", error, retryAfterMs: retryAfterMs(response) };
  if (response.status >= 400 && response.status < 500)
    return { status: "failed", error };
  return { status: "uncertain", error };
}

function requester({ apiUrl, apiToken, fetch: fetcher = fetch }: ApiOptions) {
  return (method: string, path: string, body?: unknown) =>
    fetcher(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
}

const contactPath = (chatId: string) =>
  `/contact/id:${encodeURIComponent(chatId)}`;

function messageSender(request: ApiRequest, options: ApiOptions) {
  const now = options.now ?? (() => new Date());
  return async (chatId: string, message: unknown): Promise<SendOutcome> => {
    try {
      const body = { channelId: options.channelId, message };
      const path = `${contactPath(chatId)}/message`;
      return await sendOutcome(await request("POST", path, body), now);
    } catch (error) {
      return { status: "uncertain", error: String(error) };
    }
  };
}

export function createRespondioApi(options: ApiOptions) {
  const request = requester(options);
  const send = messageSender(request, options);
  const fetcher = options.fetch ?? fetch;
  return {
    sendText: (chatId: string, text: string) =>
      send(chatId, { type: "text", text }),
    sendVideo: (chatId: string, url: string) =>
      send(chatId, { type: "attachment", attachment: { type: "video", url } }),
    addComment: async (chatId: string, text: string) => {
      const body = { text: text.slice(0, 1000) };
      await expectOk(
        await request("POST", `${contactPath(chatId)}/comment`, body),
      );
    },
    addTags: async (chatId: string, tags: string[]) => {
      await expectOk(await request("POST", `${contactPath(chatId)}/tag`, tags));
    },
    getContact: async (chatId: string): Promise<Contact> => {
      const response = await expectOk(
        await request("GET", contactPath(chatId)),
      );
      return contactSchema.parse(await response.json());
    },
    download: async (url: string) => {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await expectOk(await fetcher(url, { signal }));
      return {
        bytes: await response.bytes(),
        mediaType: response.headers.get("Content-Type") ?? undefined,
      };
    },
  };
}
