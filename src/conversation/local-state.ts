import type { ChatRef } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";

type ChatFiles = Pick<
  ChatStore,
  "fileExists" | "readTextFile" | "writeTextFile"
>;

const labelsOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export function localState(files: ChatFiles) {
  return {
    isPaused: (ref: ChatRef) => files.fileExists(ref, "paused"),
    pause: (ref: ChatRef, reason: string) =>
      files.writeTextFile(ref, "paused", `${reason}\n`),
    isClosed: (ref: ChatRef) => files.fileExists(ref, "closed"),
    readLocalLabels: async (ref: ChatRef) =>
      labelsOf((await files.readTextFile(ref, "labels.txt")) ?? ""),
    appendLocalLabels: async (ref: ChatRef, labels: string[]) => {
      const text = (await files.readTextFile(ref, "labels.txt")) ?? "";
      const known = new Set(labelsOf(text));
      const added = [...new Set(labels)].filter((label) => !known.has(label));
      if (added.length === 0) return;
      const separator = text === "" || text.endsWith("\n") ? "" : "\n";
      await files.writeTextFile(
        ref,
        "labels.txt",
        `${text}${separator}${added.join("\n")}\n`,
      );
    },
  };
}
