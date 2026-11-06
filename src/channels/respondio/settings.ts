import { z } from "zod";

const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const schema = z
  .object({
    RESPONDIO_API_TOKEN: z.string().min(1),
    RESPONDIO_API_BASE_URL: z.url().default("https://api.respond.io/v2"),
    RESPONDIO_WEBHOOK_SIGNING_KEY: z.string().min(1),
    RESPONDIO_AGENT_USER_ID: z.coerce.number().int().positive(),
    RESPONDIO_REPLY_CHANNEL_ID: z.coerce.number().int().positive().optional(),
    RESPONDIO_HANDOFF_LABEL: z.string().min(1).default("handoff"),
    RESPONDIO_OUT_OF_SCOPE_LABEL: z.string().min(1).default("out-of-scope"),
    RESPONDIO_ERROR_LABEL: z.string().min(1).default("error"),
    RESPONDIO_MCP_URL: z.url().optional(),
    RESPONDIO_MCP_TOKEN: z.string().min(1).optional(),
    RESPONDIO_MCP_TOOLS: z
      .string()
      .default("get_contact,create_comment,add_contact_tags,update_contact")
      .transform(list),
    RESPONDIO_MCP_EDITABLE_FIELDS: z
      .string()
      .default("firstName,lastName,language")
      .transform(list),
    RESPONDIO_MCP_LABELS: z.string().default("").transform(list),
  })
  .refine((env) => !env.RESPONDIO_MCP_URL || env.RESPONDIO_MCP_TOKEN, {
    message: "is required when RESPONDIO_MCP_URL is set",
    path: ["RESPONDIO_MCP_TOKEN"],
  });

export function readRespondioSettings(env: Record<string, string | undefined>) {
  const present = Object.entries(env).filter(
    ([key, value]) => key.startsWith("RESPONDIO_") && value !== "",
  );
  const result = schema.safeParse(Object.fromEntries(present));
  if (!result.success)
    throw new Error(
      `Invalid respond.io configuration:\n${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")}`,
    );
  const s = result.data;
  const labels = {
    handoff: s.RESPONDIO_HANDOFF_LABEL,
    outOfScope: s.RESPONDIO_OUT_OF_SCOPE_LABEL,
    error: s.RESPONDIO_ERROR_LABEL,
  };
  return {
    apiToken: s.RESPONDIO_API_TOKEN,
    apiBaseUrl: s.RESPONDIO_API_BASE_URL,
    signingKey: s.RESPONDIO_WEBHOOK_SIGNING_KEY,
    agentUserId: s.RESPONDIO_AGENT_USER_ID,
    replyChannelId: s.RESPONDIO_REPLY_CHANNEL_ID,
    labels,
    mcp: s.RESPONDIO_MCP_URL
      ? {
          url: s.RESPONDIO_MCP_URL,
          token: s.RESPONDIO_MCP_TOKEN ?? "",
          tools: s.RESPONDIO_MCP_TOOLS,
          editableFields: s.RESPONDIO_MCP_EDITABLE_FIELDS,
          labels: [
            labels.handoff,
            labels.outOfScope,
            ...s.RESPONDIO_MCP_LABELS,
          ],
        }
      : undefined,
  };
}

export type RespondioSettings = ReturnType<typeof readRespondioSettings>;
