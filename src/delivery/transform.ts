import type { OutboundPart } from "../channels/channel.ts";

export type PlanOptions = {
  stripFinalStop: boolean;
  videoPrefixes: string[];
  videoMode: "attachment" | "text";
  surroundingText: "replace" | "separate";
  supportsVideo: boolean;
  maxTextLength: number;
};

type VideoLink = { url: string; start: number; end: number };

const urlPattern = /https?:\/\/[^\s<>"]+/g;
const trailingPunctuation = /[.,;:!?)\]}'"]+$/;

function approvedLinks(text: string, prefixes: string[]): VideoLink[] {
  return [...text.matchAll(urlPattern)]
    .map((match) => {
      const url = match[0].replace(trailingPunctuation, "");
      return { url, start: match.index, end: match.index + url.length };
    })
    .filter((link) => prefixes.some((prefix) => link.url.startsWith(prefix)));
}

function extractVideos(text: string, options: PlanOptions): OutboundPart[] {
  const convert = options.videoMode === "attachment" && options.supportsVideo;
  const links = convert ? approvedLinks(text, options.videoPrefixes) : [];
  if (links.length === 0) return [{ kind: "text", text }];
  if (options.surroundingText === "replace") {
    return links.map((link) => ({ kind: "video", url: link.url }));
  }
  const parts: OutboundPart[] = [];
  let textStart = 0;
  for (const link of links) {
    parts.push({ kind: "text", text: text.slice(textStart, link.start) });
    parts.push({ kind: "video", url: link.url });
    textStart = link.end;
  }
  parts.push({ kind: "text", text: text.slice(textStart) });
  return parts;
}

const withoutFinalStop = (text: string) =>
  text.endsWith(".") && !text.endsWith("..") ? text.slice(0, -1) : text;

function cutPosition(text: string, max: number) {
  const window = text.slice(0, max + 1);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph > 0) return paragraph;
  const line = window.lastIndexOf("\n");
  if (line > 0) return line;
  const sentence = [...window.matchAll(/[.!?](?=\s)/g)].at(-1);
  if (sentence) return sentence.index + 1;
  const space = window.search(/\s\S*$/);
  if (space > 0) return space;
  const isHighSurrogate = /[\uD800-\uDBFF]/.test(text.charAt(max - 1));
  return isHighSurrogate ? max - 1 : max;
}

function splitToLimit(text: string, max: number) {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = cutPosition(rest, max);
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  pieces.push(rest);
  return pieces;
}

function finishText(text: string, options: PlanOptions): OutboundPart[] {
  const trimmed = text.trim();
  const finished = options.stripFinalStop ? withoutFinalStop(trimmed) : trimmed;
  if (finished === "") return [];
  return splitToLimit(finished, options.maxTextLength).map((piece) => ({
    kind: "text",
    text: piece,
  }));
}

export function planParts(text: string, options: PlanOptions) {
  return extractVideos(text, options).flatMap((part) =>
    part.kind === "video" ? [part] : finishText(part.text, options),
  );
}
