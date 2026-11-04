import { expect, test } from "bun:test";

import { project } from "../record/projection.ts";
import { agentMayAnswer, chatState } from "./ownership.ts";

test("each policy permits answers only for its owners", () => {
  const table = (["assigned", "shared", "unrestricted"] as const).map(
    (policy) =>
      (["agent", "none", "human"] as const).map((owner) =>
        agentMayAnswer(owner, policy),
      ),
  );
  expect(table).toEqual([
    [true, false, false],
    [true, true, false],
    [true, true, true],
  ]);
});

test("native assignment uses the recorded state, unassigned and open by default", () => {
  const native = { native: true, paused: true, closed: true };
  expect(chatState(project([]), native)).toEqual({ owner: "none", open: true });
  const view = project([
    {
      type: "ownership",
      owner: "human",
      eventAt: "2026-11-04T10:00:00.000Z",
      seq: 1,
      at: "2026-11-04T10:00:00.000Z",
    },
    {
      type: "status",
      open: false,
      eventAt: "2026-11-04T10:00:00.000Z",
      seq: 2,
      at: "2026-11-04T10:00:00.000Z",
    },
  ]);
  expect(chatState(view, native)).toEqual({ owner: "human", open: false });
});

test("without native assignment the chat folder files decide the state", () => {
  const view = project([]);
  const local = { native: false, paused: false, closed: false };
  expect(chatState(view, local)).toEqual({ owner: "agent", open: true });
  expect(chatState(view, { ...local, paused: true, closed: true })).toEqual({
    owner: "human",
    open: false,
  });
});
