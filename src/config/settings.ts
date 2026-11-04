import type { Country } from "../skills/country.ts";
import { envId, type EnvReader, parseDuration, parseList } from "./env.ts";

export type Settings = ReturnType<typeof readSettings>;

const countries: readonly Country[] = ["MY", "PH"];

function parseTimeZone(raw: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en", { timeZone: raw });
    return raw;
  } catch {
    return undefined;
  }
}

const hourPattern = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/;

function parseHours(raw: string) {
  const match = hourPattern.exec(raw);
  if (!match) return undefined;
  const [h1, m1, h2, m2] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const startMinutes = h1 * 60 + m1;
  const endMinutes = h2 * 60 + m2;
  const valid = startMinutes !== endMinutes && endMinutes <= 1440;
  return valid ? { startMinutes, endMinutes } : undefined;
}

function parseDurations(raw: string): number[] | undefined {
  const values = raw.split(",").map((item) => parseDuration(item.trim()));
  return values.every((v) => v !== undefined && v > 0)
    ? (values as number[])
    : undefined;
}

function parseIds(raw: string): string[] | undefined {
  const ids = parseList(raw);
  const valid =
    ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id)) &&
    new Set(ids.map(envId)).size === ids.length;
  return valid ? ids : undefined;
}

const idsAccepted =
  "a comma separated list of distinct ids of letters, digits, '_' and '-'";

function readModels(env: EnvReader) {
  const model = env.string("GATO_MODEL");
  return {
    openRouterApiKey: env.string("OPENROUTER_API_KEY"),
    model,
    summaryModel: env.optionalString("GATO_SUMMARY_MODEL") ?? model,
    summaryPromptFile: env.string("GATO_SUMMARY_PROMPT_FILE", {
      default: "prompts/summary.md",
    }),
    preparationModels: {
      image: env.optionalString("GATO_IMAGE_MODEL"),
      document: env.optionalString("GATO_DOCUMENT_MODEL"),
      audio: env.optionalString("GATO_AUDIO_MODEL"),
    },
    turn: {
      timeoutMs: env.duration("GATO_TURN_TIMEOUT", { default: "2m" }),
      maxModelCalls: env.int("GATO_TURN_MAX_MODEL_CALLS", { default: 12 }),
    },
  };
}

function readConversation(env: EnvReader) {
  return {
    ownershipPolicy: env.enumOf(
      "GATO_OWNERSHIP_POLICY",
      ["assigned", "shared", "unrestricted"],
      "assigned",
    ),
    history: {
      scope: env.enumOf("GATO_HISTORY_SCOPE", ["chat", "recent-month"], "chat"),
      includeToolActivity: env.bool("GATO_INCLUDE_TOOL_ACTIVITY", {
        default: true,
      }),
    },
    labels: {
      handoff: env.string("GATO_LABEL_HANDOFF", { default: "handoff" }),
      outOfScope: env.string("GATO_LABEL_OUT_OF_SCOPE", {
        default: "out-of-scope",
      }),
      error: env.string("GATO_LABEL_ERROR", { default: "error" }),
      expired: env.string("GATO_LABEL_EXPIRED", { default: "expired" }),
    },
  };
}

function readDelivery(env: EnvReader) {
  return {
    boundary: env.enumOf(
      "GATO_DELIVERY_BOUNDARY",
      ["paragraph", "line", "whole"],
      "paragraph",
    ),
    timing: env.enumOf(
      "GATO_DELIVERY_TIMING",
      ["stream", "complete"],
      "stream",
    ),
    pacing: env.enumOf(
      "GATO_DELIVERY_PACING",
      ["fixed", "typing", "none"],
      "fixed",
    ),
    pauseMs: env.duration("GATO_DELIVERY_PAUSE", { default: "750ms" }),
    perWordMs: env.duration("GATO_DELIVERY_PER_WORD", { default: "1s" }),
    stripFinalStop: env.bool("GATO_DELIVERY_STRIP_FINAL_STOP", {
      default: true,
    }),
    video: {
      linkPrefixes: env.list("GATO_VIDEO_LINK_PREFIXES", { default: [] }),
      mode: env.enumOf(
        "GATO_VIDEO_LINK_MODE",
        ["attachment", "text"],
        "attachment",
      ),
      surroundingText: env.enumOf(
        "GATO_VIDEO_SURROUNDING_TEXT",
        ["replace", "separate"],
        "replace",
      ),
    },
  };
}

function readNudges(env: EnvReader) {
  return {
    enabled: env.bool("GATO_NUDGES_ENABLED", { default: true }),
    expiryEnabled: env.bool("GATO_EXPIRY_ENABLED", { default: true }),
    checkIntervalMs: env.duration("GATO_NUDGE_CHECK_INTERVAL", {
      default: "5m",
    }),
    milestonesMs: env.custom(
      "GATO_NUDGE_MILESTONES",
      "a comma separated list of durations such as 5m,35m,12h35m",
      parseDurations,
      [300_000, 2_100_000, 45_300_000, 45_900_000],
    ),
    hours: env.custom(
      "GATO_NUDGE_HOURS",
      "HH:MM-HH:MM with start before end",
      parseHours,
      {
        startMinutes: 0,
        endMinutes: 1440,
      },
    ),
    prompt: env.string("GATO_NUDGE_PROMPT", { default: "Nudge" }),
    expiryAfterMs: env.duration("GATO_EXPIRY_AFTER", { default: "13h45m" }),
    expiryExemptLabel: env.string("GATO_EXPIRY_EXEMPT_LABEL", {
      default: "out-of-scope-unsolved",
    }),
  };
}

function readConnections(env: EnvReader) {
  const ids: string[] | undefined = env.custom(
    "GATO_CONNECTIONS",
    idsAccepted,
    parseIds,
  );
  return (ids ?? []).map((id) => ({
    id,
    type: env.string(`GATO_CONNECTION_${envId(id)}_TYPE`),
  }));
}

export function readSettings(env: EnvReader) {
  return {
    port: env.int("PORT", { default: 3000 }),
    dataDir: env.string("GATO_DATA_DIR"),
    skillsDir: env.string("GATO_SKILLS_DIR"),
    country: env.enumOf("GATO_COUNTRY", countries),
    timeZone: env.custom(
      "GATO_TIMEZONE",
      "an IANA time zone name such as UTC or Asia/Manila",
      parseTimeZone,
      "UTC",
    ),
    ...readModels(env),
    ...readConversation(env),
    delivery: readDelivery(env),
    nudges: readNudges(env),
    shutdownGraceMs: env.duration("GATO_SHUTDOWN_GRACE", { default: "10s" }),
    opsToken: env.optionalString("GATO_OPS_TOKEN"),
    connections: readConnections(env),
    mcpServers: env.custom("GATO_MCP_SERVERS", idsAccepted, parseIds, []),
  };
}
