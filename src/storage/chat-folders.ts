import fs from "node:fs/promises";
import path from "node:path";

import type { ChatRef } from "../record/types.ts";
import {
  chatDir,
  plainFileName,
  readOptional,
  writeAtomic,
} from "./chat-files.ts";

export type Summary = { generatedAt: string; text: string };

function parseSummary(text: string): Summary | undefined {
  const match = /^Generated: (\S+)\n\n([\s\S]*)$/.exec(text);
  return match?.[1] && match[2] !== undefined
    ? { generatedAt: match[1], text: match[2] }
    : undefined;
}

function folderPaths(dataDir: string) {
  const dirOf = (ref: ChatRef) => chatDir(dataDir, ref);
  return {
    dirOf,
    fileOf: (ref: ChatRef, name: string) =>
      path.join(dirOf(ref), plainFileName(name)),
    write: async (
      ref: ChatRef,
      relative: string,
      data: string | Uint8Array,
    ) => {
      const file = path.join(dirOf(ref), relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeAtomic(file, data);
    },
  };
}

function attachmentFiles(dataDir: string) {
  const { dirOf, write } = folderPaths(dataDir);
  return {
    saveAttachment: async (
      ref: ChatRef,
      fileName: string,
      bytes: Uint8Array,
    ) => {
      const relative = `attachments/${plainFileName(fileName)}`;
      await write(ref, relative, bytes);
      return relative;
    },
    attachmentPath: (ref: ChatRef, relative: string) => {
      const full = path.resolve(dirOf(ref), relative);
      if (!full.startsWith(path.resolve(dirOf(ref), "attachments") + path.sep))
        throw new Error(`Not an attachment path: ${relative}`);
      return full;
    },
  };
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

function textFiles(dataDir: string) {
  const { dirOf, fileOf, write } = folderPaths(dataDir);
  return {
    // A revision's instructions never change, so an existing file is kept.
    saveInstructions: async (
      ref: ChatRef,
      revisionId: string,
      text: string,
    ) => {
      const relative = `instructions/${plainFileName(`${revisionId}.md`)}`;
      if (!(await exists(path.join(dirOf(ref), relative))))
        await write(ref, relative, text);
    },
    readSummary: async (ref: ChatRef) => {
      const text = await readOptional(fileOf(ref, "summary.txt"));
      return text === undefined ? undefined : parseSummary(text);
    },
    writeSummary: (ref: ChatRef, summary: Summary) =>
      write(
        ref,
        "summary.txt",
        `Generated: ${summary.generatedAt}\n\n${summary.text}`,
      ),
    fileExists: (ref: ChatRef, name: string) => exists(fileOf(ref, name)),
    readTextFile: (ref: ChatRef, name: string) =>
      readOptional(fileOf(ref, name)),
    writeTextFile: (ref: ChatRef, name: string, text: string) =>
      write(ref, plainFileName(name), text),
    removeFile: (ref: ChatRef, name: string) =>
      fs.rm(fileOf(ref, name), { force: true }),
  };
}

export function chatFolders(dataDir: string) {
  return { ...attachmentFiles(dataDir), ...textFiles(dataDir) };
}
