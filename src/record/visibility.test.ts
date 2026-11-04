import { expect, test } from "bun:test";

import type { Author, Delivery } from "./types.ts";
import { isVisibleMessage } from "./visibility.ts";

const message = (author: Author, delivery: Delivery) => ({
  id: "m",
  seq: 1,
  author,
  sentAt: "2026-11-04T10:00:00.000Z",
  attachments: [],
  delivery,
});

test("observed traffic and sent agent parts are visible, other agent parts are not", () => {
  const deliveries: Delivery[] = [
    "observed",
    "sent",
    "pending",
    "uncertain",
    "failed",
    "superseded",
  ];
  const visible = (author: Author) =>
    deliveries.filter((d) => isVisibleMessage(message(author, d)));
  expect(visible({ role: "agent" })).toEqual(["observed", "sent"]);
  expect(visible({ role: "customer" })).toEqual(["observed"]);
  expect(visible({ role: "operator" })).toEqual(["observed"]);
  expect(visible({ role: "workflow" })).toEqual(["observed"]);
});
