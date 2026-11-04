import fs from "node:fs/promises";

import { generateText } from "ai";

import type { TurnBudget } from "../agent/budget.ts";
import type { ModelProvider } from "../agent/models.ts";
import type { Logger } from "../log.ts";
import type { RecordedMessage } from "../record/projection.ts";
import type { Attachment, ChatRef, Preparation } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import { attachmentName, mediaTypeOf } from "./representation.ts";

export class PreparationError extends Error {
  constructor(attachment: Attachment, reason: string) {
    super(`Preparation of ${attachmentName(attachment)} failed: ${reason}`);
    this.name = "PreparationError";
  }
}

type PreparedCategory = "image" | "document" | "audio";

const instructions: Record<PreparedCategory, string> = {
  image:
    "Read or describe this image as text. Return only the text content or the description.",
  document:
    "Read this document. Return its textual content or, if it has no text, your interpretation of it.",
  audio: "Transcribe this audio. Return only the transcript.",
};

type Input = {
  store: Pick<ChatStore, "append" | "attachmentPath">;
  ref: ChatRef;
  messages: RecordedMessage[];
  models: Partial<Record<PreparedCategory, string>>;
  provider: ModelProvider;
  budget: TurnBudget;
  log: Logger;
  now?: () => Date;
};

const isPrepared = (attachment: Attachment) =>
  attachment.preparation !== undefined && "text" in attachment.preparation;

function modelFor(attachment: Attachment, models: Input["models"]) {
  const category = attachment.category;
  if (category !== "image" && category !== "document" && category !== "audio")
    return undefined;
  const model = models[category];
  return model && attachment.file && !isPrepared(attachment)
    ? { model, category, file: attachment.file }
    : undefined;
}

async function callModel(
  input: Input,
  attachment: Attachment,
  job: { model: string; category: PreparedCategory; file: string },
) {
  const data = await fs.readFile(
    input.store.attachmentPath(input.ref, job.file),
  );
  const result = await generateText({
    model: input.provider(job.model),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instructions[job.category] },
          {
            type: "file",
            data,
            mediaType: mediaTypeOf(attachment),
            filename: attachment.fileName,
          },
        ],
      },
    ],
    maxRetries: 0,
    abortSignal: input.budget.signal,
  });
  const text = result.text.trim();
  if (text === "") throw new Error("The model returned no text");
  return text;
}

async function prepareOne(
  input: Input,
  message: RecordedMessage,
  attachment: Attachment,
) {
  const job = modelFor(attachment, input.models);
  if (!job) return;
  input.budget.take();
  const at = (input.now ?? (() => new Date()))().toISOString();
  let preparation: Preparation;
  try {
    preparation = {
      model: job.model,
      at,
      text: await callModel(input, attachment, job),
    };
  } catch (error) {
    if (input.budget.signal.aborted) throw error;
    preparation = {
      model: job.model,
      at,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await input.store.append(input.ref, [
    {
      type: "attachment-update",
      messageId: message.id,
      attachmentId: attachment.id,
      preparation,
    },
  ]);
  if ("error" in preparation) {
    input.log.warn("attachment.preparation_failed", {
      messageId: message.id,
      attachmentId: attachment.id,
      error: preparation.error,
    });
    throw new PreparationError(attachment, preparation.error);
  }
}

export async function prepareAttachments(input: Input) {
  for (const message of input.messages)
    for (const attachment of message.attachments)
      await prepareOne(input, message, attachment);
}
