export type MediaKind = "image" | "video" | "audio" | "document";

export type Segment = { text: string } | { media: MediaKind; url: string };

const mediaExtensions: Record<string, MediaKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
  mp3: "audio",
  m4a: "audio",
  ogg: "audio",
  oga: "audio",
  wav: "audio",
  aac: "audio",
  opus: "audio",
  pdf: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  csv: "document",
};

export function createPartSplitter(
  boundary: string,
  emit: (part: string) => void,
) {
  let buffer = "";
  const emitPart = (part: string) => {
    if (part.trim()) emit(part.trim());
  };
  return {
    push(delta: string) {
      buffer += delta;
      for (
        let at = buffer.indexOf(boundary);
        at >= 0;
        at = buffer.indexOf(boundary)
      ) {
        emitPart(buffer.slice(0, at));
        buffer = buffer.slice(at + boundary.length);
      }
    },
    flush() {
      emitPart(buffer);
      buffer = "";
    },
    pending: () => buffer.trim(),
  };
}

export function toSegments(
  part: string,
  maxTextLength: number,
  sendableMedia: ReadonlySet<MediaKind>,
): Segment[] {
  const segments: Segment[] = [];
  const addText = (text: string) => {
    for (const piece of splitLength(text.trim(), maxTextLength))
      segments.push({ text: piece });
  };
  let rest = part;
  for (const match of part.matchAll(
    /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>"]+/g,
  )) {
    const url = match[1] ?? match[0].replace(/[.,;:!?)\]'"]+$/, "");
    const media = mediaKind(url);
    if (!media || !sendableMedia.has(media)) continue;
    const token = match[1] ? match[0] : url;
    const at = rest.indexOf(token);
    addText(rest.slice(0, at));
    segments.push({ media, url });
    rest = rest.slice(at + token.length);
  }
  addText(rest);
  return segments;
}

function mediaKind(url: string): MediaKind | undefined {
  const path = URL.parse(url)?.pathname.toLowerCase() ?? "";
  const extension = /\.([a-z0-9]+)$/.exec(path)?.[1];
  return extension ? mediaExtensions[extension] : undefined;
}

function splitLength(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const space = rest.lastIndexOf(" ", max);
    const cut = space > 0 ? space : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export function wordCount(segment: Segment): number {
  return "text" in segment
    ? segment.text.split(/\s+/).filter(Boolean).length
    : 0;
}
