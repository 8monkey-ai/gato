import { join } from "node:path";

export interface StoredEntry {
  kind: string;
  role?: string;
  text?: string;
  type?: string;
  delivery?: string;
  ref?: string;
  at: string;
  turn?: string;
  sender?: unknown;
  attachments?: Record<string, unknown>[];
  [key: string]: unknown;
}

export async function readChat(
  dataDir: string,
  connection: string,
  chat: string,
) {
  const file = Bun.file(join(dataDir, connection, chat, "chat.txt"));
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredEntry);
}

export async function readState(
  dataDir: string,
  connection: string,
  chat: string,
) {
  return (await Bun.file(
    join(dataDir, connection, chat, "state.json"),
  ).json()) as Record<string, unknown>;
}

export async function writeChat(
  dataDir: string,
  connection: string,
  chat: string,
  entries: object[],
  state?: object,
) {
  const dir = join(dataDir, connection, chat);
  await Bun.write(
    join(dir, "chat.txt"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  if (state) await Bun.write(join(dir, "state.json"), JSON.stringify(state));
}
