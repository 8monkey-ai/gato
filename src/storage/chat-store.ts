import { assertWritableDir } from "./chat-files.ts";
import { chatFolders } from "./chat-folders.ts";
import { type ChatLogOptions, openChatLog } from "./chat-log.ts";

export type ChatStore = Awaited<ReturnType<typeof openChatStore>>;

export async function openChatStore(dataDir: string, options: ChatLogOptions) {
  await assertWritableDir(dataDir);
  return { ...(await openChatLog(dataDir, options)), ...chatFolders(dataDir) };
}

export type { ChatSession, NewEntry } from "./chat-log.ts";
export type { Summary } from "./chat-folders.ts";
