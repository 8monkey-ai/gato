import { generateText, type LanguageModel } from "ai";

import type { Config } from "../config.ts";
import type { Attachment } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";
import type { Prompts } from "./prompts.ts";

export class PreparationError extends Error {}

type PreparedKind = keyof Config["models"]["preparation"];

export const defaultMediaTypes: Record<PreparedKind, string> = {
  image: "image/jpeg",
  document: "application/pdf",
  audio: "audio/ogg",
};

export const isPreparedKind = (kind: string): kind is PreparedKind =>
  kind in defaultMediaTypes;

export function createPreparer(deps: {
  models: Config["models"]["preparation"];
  prompts: Prompts;
  model: (modelId: string) => LanguageModel;
  signal: AbortSignal;
  conversation: Conversation;
}) {
  return async (
    attachment: Attachment,
    file: string,
  ): Promise<string | undefined> => {
    const kind = attachment.kind;
    const modelId = isPreparedKind(kind) ? deps.models[kind] : undefined;
    if (!modelId || !isPreparedKind(kind)) return undefined;
    if (attachment.prepared) return attachment.prepared.text;
    const { text } = await generateText({
      model: deps.model(modelId),
      instructions: deps.prompts[`prepare-${kind}`],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: await deps.conversation.readAttachment(file),
              mediaType: attachment.mime ?? defaultMediaTypes[kind],
              filename: attachment.name,
            },
          ],
        },
      ],
      abortSignal: deps.signal,
    });
    if (!text.trim())
      throw new PreparationError(
        `The ${kind} preparation model returned no text`,
      );
    await deps.conversation.lock(async (edit) => {
      attachment.prepared = { model: modelId, text: text.trim() };
      await edit.save();
    });
    return text.trim();
  };
}

export type Preparer = ReturnType<typeof createPreparer>;
