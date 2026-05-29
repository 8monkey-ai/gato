import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readPiFile, piFileMtime } from "./lib/helpers.ts";

export default function injectSystemPrompt(pi: ExtensionAPI) {
  pi.on("before_agent_start", (_event) => {
    let prompt = _event.systemPrompt;

    // Conversation summary
    const summary = readPiFile("summary.md");
    if (summary) {
      const mtime = piFileMtime("summary.md");
      const date = mtime ? mtime.toISOString().split("T")[0] : "unknown";
      prompt += `\n<summary date="${date}">\n${summary}\n</summary>\n<additional_context>\nThe above is a summary of recent interactions with this contact. Use it to maintain continuity and provide contextual responses.\nContinue the conversation using the same language and tone and follow the language direction above.\n</additional_context>`;
    }

    // User data
    const userData = readPiFile("user.json");
    if (userData) {
      prompt += `\n\n<user_data>\n${userData}\n</user_data>\nThe above is data about the user you are speaking with. Use this information to personalize the conversation and pass relevant identifiers when calling tools. IMPORTANT: Never disclose any IDs or internal identifiers to the user.`;
    }

    return { systemPrompt: prompt };
  });
}
