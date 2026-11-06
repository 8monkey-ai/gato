import type { Category } from "../record/entries.ts";

const documentTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
]);

export function categoryOf(mime: string | undefined): Category {
  const type = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/") || documentTypes.has(type)) return "document";
  return "other";
}
