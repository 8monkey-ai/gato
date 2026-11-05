import { join } from "node:path";

import { tempDir, waitFor } from "./app.ts";
import type { Harness } from "./fixture.ts";
import type { ModelRequest } from "./gateway.ts";
import { writeChat } from "./setup.ts";

export const day = 24 * 60 * 60 * 1000;
export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export async function prepareChat(
  entries: object[],
  summary?: { date: string; text: string },
) {
  const dataDir = await tempDir();
  await writeChat(dataDir, "tg", "1", entries);
  if (summary) {
    const text = `Date: ${summary.date}\n\n${summary.text}`;
    await Bun.write(join(dataDir, "tg", "1", "summary.txt"), text);
  }
  return dataDir;
}

export const history = (atMs: number) => [
  {
    kind: "message",
    id: "c1",
    at: ago(atMs),
    role: "customer",
    ref: "1",
    text: "I need a new card",
  },
  {
    kind: "message",
    id: "a1",
    at: ago(atMs - 1000),
    role: "agent",
    text: "Sure",
    delivery: "sent",
  },
];

const defaultSummary =
  "Primary Language used in this conversation: English\n- wants a new card";

export function replyWithSummary(summaryText = defaultSummary) {
  return (request: ModelRequest) =>
    request.stream ? { text: "Hello again" } : { text: summaryText };
}

export async function ask(
  f: Harness,
  dataDir: string,
  extra: Record<string, string> = {},
) {
  await f.start({ DATA_DIR: dataDir, ...extra });
  f.telegram.customerMessage(1, { text: "Any update?" });
  const failed = () =>
    f.app.logs.some((line) => line.includes('"turn.failed"'));
  await waitFor(() => f.telegram.sentTexts(1).length === 1 || failed());
}

export const summaryFile = (dataDir: string) =>
  Bun.file(join(dataDir, "tg", "1", "summary.txt"));
