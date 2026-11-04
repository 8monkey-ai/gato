import type { RecordedMessage } from "./projection.ts";

// Visible = what the customer has seen: observed traffic, and agent parts known to be sent.
export const isVisibleMessage = ({ author, delivery }: RecordedMessage) =>
  delivery === "observed" || (author.role === "agent" && delivery === "sent");
