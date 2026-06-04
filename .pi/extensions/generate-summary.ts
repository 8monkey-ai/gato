import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readPiFile, piFileMtime } from "./lib/helpers.ts";

const STALENESS_DAYS = Number(process.env["GATO_SUMMARY_STALENESS_DAYS"]) || 3;

function daysSince(date: Date): number {
  return (Date.now() - date.getTime()) / 86_400_000;
}

export default function generateSummary(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (_event.reason === "new") return;

    const mtime = piFileMtime("agent/summary.md");
    if (mtime && daysSince(mtime) < STALENESS_DAYS) return;

    const entries = ctx.sessionManager.getEntries();
    const firstUser = entries.find((e) => e.type === "message" && e.message?.role === "user");
    if (!firstUser || daysSince(new Date(firstUser.timestamp)) < STALENESS_DAYS) return;

    const template = readPiFile("prompts/generate-summary.md");
    if (!template) return;

    const history = entries
      .filter((e) => e.type === "message")
      .map((e) => {
        const msg = e.message;
        if (msg?.role !== "user" && msg?.role !== "assistant") return null;
        const text = Array.isArray(msg.content)
          ? msg.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n")
          : String(msg.content || "");
        if (!text.trim()) return null;
        const ts = new Date(e.timestamp).toISOString().slice(0, 16).replace("T", " ");
        return `[${ts}] ${msg.role}: ${text.trim()}`;
      })
      .filter(Boolean)
      .join("\n\n");

    if (!history) return;

    try {
      const summary = execFileSync(
        "pi",
        [
          "-p",
          "--no-session",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--system-prompt",
          template.replace("{conversation_history}", history),
          "Generate a detailed summary of the conversation. Respond with the summary only. No comments or other text. Remember to generate it in English and to add the primary language of the conversation at the start.",
        ],
        { encoding: "utf-8", timeout: 60_000 },
      ).trim();

      if (summary) writeFileSync(join(homedir(), ".pi", "agent", "summary.md"), summary);
    } catch {}
  });
}
