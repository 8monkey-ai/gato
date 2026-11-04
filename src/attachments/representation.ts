import type { Attachment } from "../record/types.ts";

const defaultMediaTypes: Partial<Record<Attachment["category"], string>> = {
  image: "image",
  audio: "audio",
  document: "application/pdf",
};

export function mediaTypeOf(attachment: Attachment): string {
  return (
    attachment.mediaType ??
    defaultMediaTypes[attachment.category] ??
    "application/octet-stream"
  );
}

export function preparedText(attachment: Attachment): string | undefined {
  const prepared = attachment.preparation;
  if (!prepared || !("text" in prepared)) return undefined;
  const label =
    attachment.category === "audio" ? "audio transcript" : attachment.category;
  const name = attachment.fileName ? ` ${attachment.fileName}` : "";
  return `[${label}${name}: ${prepared.text}]`;
}

export function attachmentName(attachment: Attachment): string {
  const name = attachment.fileName ? ` ${attachment.fileName}` : "";
  return `${attachment.category} attachment${name}`;
}
