import type { OutgoingPart } from "../channels/channel.ts";
import type { DeliverySettings } from "../config/settings.ts";

export interface ChannelLimits {
  maxMessageLength: number;
  videoAttachments: boolean;
}

function stripFinalPeriod(text: string) {
  return text.replace(/(?<!\.)\.$/, "");
}

function splitLength(text: string, max: number) {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const space = rest.lastIndexOf(" ", max);
    const cut = space > 0 ? space : max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

function findVideoLinks(text: string, prefixes: string[]) {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  return urls.filter((url) =>
    prefixes.some((prefix) => url.startsWith(prefix)),
  );
}

function textParts(
  text: string,
  settings: DeliverySettings,
  limits: ChannelLimits,
): OutgoingPart[] {
  const trimmed = text.trim();
  const final = settings.stripFinalPeriod ? stripFinalPeriod(trimmed) : trimmed;
  if (final === "") return [];
  return splitLength(final, limits.maxMessageLength).map((chunk) => ({
    text: chunk,
  }));
}

export function shapeParts(
  text: string,
  settings: DeliverySettings,
  limits: ChannelLimits,
): OutgoingPart[] {
  const convert =
    settings.videoLinksAs === "attachment" && limits.videoAttachments;
  const videos = convert
    ? findVideoLinks(text, settings.videoLinkPrefixes)
    : [];
  if (videos.length === 0) return textParts(text, settings, limits);
  const surrounding = videos.reduce((rest, url) => rest.replace(url, ""), text);
  const kept =
    settings.videoSurroundingText === "separate"
      ? textParts(surrounding, settings, limits)
      : [];
  return [...kept, ...videos.map((videoUrl) => ({ videoUrl }))];
}
