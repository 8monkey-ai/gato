import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readPiFile } from "./lib/helpers.ts";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

async function rpc(url: string, method: string, params = {}): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function cleanSchema(schema: McpTool["inputSchema"] = {}) {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const [key, raw] of Object.entries(schema?.properties || {})) {
    const prop = raw as {
      type?: string;
      title?: string;
      description?: string;
      anyOf?: { type: string }[];
    };
    const resolved = prop.anyOf?.find((a) => a.type !== "null") || prop;
    properties[key] = {
      type: resolved.type || "string",
      description: prop.title || prop.description || key,
    };
  }
  return { type: "object" as const, properties, required: schema?.required || [] };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export default function registerMcpTools(pi: ExtensionAPI) {
  let registered = false;

  pi.on("before_agent_start", async () => {
    if (registered) return;

    const raw = readPiFile("agent/mcp.json");
    if (!raw) return;

    let config: { mcpServers?: Record<string, { directTools?: boolean; url?: string }> };
    try {
      config = JSON.parse(raw);
    } catch {
      return;
    }

    let count = 0;
    for (const [name, def] of Object.entries(config.mcpServers || {})) {
      if (!def.directTools || !def.url) continue;

      let tools: McpTool[];
      try {
        // eslint-disable-next-line no-await-in-loop -- servers must register sequentially
        const res = (await rpc(def.url, "tools/list")) as { result?: { tools?: McpTool[] } };
        tools = res.result?.tools || [];
      } catch (e) {
        console.error(`[mcp] ${name}:`, (e as Error)?.message);
        continue;
      }

      for (const tool of tools) {
        const url = def.url;
        const toolName = tool.name;
        pi.registerTool({
          name: toolName,
          label: toolName,
          description: tool.description || "",
          parameters: cleanSchema(tool.inputSchema),
          async execute(_id, params) {
            try {
              const res = (await rpc(url, "tools/call", { name: toolName, arguments: params })) as {
                result?: { content?: { type: string; text?: string }[] };
                error?: { message: string };
              };
              if (res.error) return textResult(`Error: ${res.error.message}`);
              const texts = res.result?.content
                ?.filter((c) => c.type === "text")
                .map((c) => c.text || "")
                .join("\n");
              return textResult(texts || JSON.stringify(res.result));
            } catch (e) {
              return textResult(`Error: ${(e as Error)?.message}`);
            }
          },
        } as Parameters<typeof pi.registerTool>[0]);
        count++;
      }
    }

    if (count) registered = true;
  });
}
