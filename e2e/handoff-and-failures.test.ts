import { expect, test } from "bun:test";

import { readChat } from "./support/app.ts";
import { messageEvent, postWebhook } from "./support/fake-respondio.ts";
import { until } from "./support/recorder.ts";
import { startHarness } from "./support/setup.ts";

const handoffCall = {
  toolCalls: [
    {
      name: "handoff",
      args: { reason: "Customer asks for a refund above the limit" },
    },
  ],
};

test("§7 handoff: the agent's handoff tool saves an English reason and applies the handoff and out-of-scope labels", async () => {
  const { app, gateway, respondio, dataDir } = await startHarness({
    channels: "respondio",
  });
  gateway.script((_, index) =>
    index === 0 ? handoffCall : { text: "A colleague will help you soon." },
  );
  await postWebhook(
    app.url,
    messageEvent({ contact: 110, text: "I want a big refund" }),
  );

  await until(() => respondio.sent().length === 1);
  expect(respondio.sent()).toEqual(["A colleague will help you soon."]);
  expect(respondio.callsTo("/contact/id:110/tag").map((c) => c.body)).toEqual([
    ["handoff", "out-of-scope"],
  ]);
  const comments = respondio
    .callsTo("/contact/id:110/comment")
    .map((c) => (c.body as { text: string }).text);
  expect(comments).toEqual([
    "handoff: Customer asks for a refund above the limit",
  ]);
  const note = (await readChat(dataDir, "respondio", "110")).find(
    (e) => e.meta.kind === "handoff",
  );
  expect(note?.meta.author).toBe("agent");
  expect(note?.text).toBe("Customer asks for a refund above the limit");
  expect(JSON.stringify(gateway.requests[1]?.messages)).toContain(
    "A human colleague was asked to take over",
  );
});

test("§7 handoff: a handoff does not stop replies by itself", async () => {
  const { app, gateway, respondio } = await startHarness({
    channels: "respondio",
  });
  gateway.script((_, index) =>
    index === 0 ? handoffCall : { text: "Noted." },
  );
  await postWebhook(app.url, messageEvent({ contact: 111, text: "refund" }));
  await until(() => respondio.sent().length === 1);
  await postWebhook(
    app.url,
    messageEvent({ contact: 111, text: "still there?" }),
  );
  await until(() => respondio.sent().length === 2);
});

test("§7 handoff: a channel without handoff gives the agent no handoff tool", async () => {
  const { telegram, gateway } = await startHarness();
  telegram.push(112, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  const tools = gateway.requests[0]?.tools?.map((t) => t.function.name);
  expect(tools).toEqual(["read_skill"]);
});

test("§7 errors: an unrecoverable error uses the harness path with the error labels and no further model call", async () => {
  const { app, gateway, respondio, dataDir } = await startHarness({
    channels: "respondio",
  });
  gateway.script(() => ({ status: 400 }));
  await postWebhook(app.url, messageEvent({ contact: 113, text: "hi" }));

  await until(() => respondio.callsTo("/contact/id:113/tag").length === 1);
  expect(respondio.callsTo("/contact/id:113/tag")[0]?.body).toEqual([
    "handoff",
    "error",
  ]);
  expect(gateway.requests).toHaveLength(1);
  expect(respondio.sent()).toHaveLength(0);
  const note = (await readChat(dataDir, "respondio", "113")).find(
    (e) => e.meta.kind === "error",
  );
  expect(note?.meta.author).toBe("harness");
  expect(respondio.callsTo("/contact/id:113/comment")).toHaveLength(1);
});

test("§7 errors: a failed handoff report is logged without more handoff attempts", async () => {
  const { app, gateway, respondio } = await startHarness({
    channels: "respondio",
  });
  gateway.script(() => ({ status: 400 }));
  respondio.failPath = "/tag";
  await postWebhook(app.url, messageEvent({ contact: 114, text: "hi" }));

  await until(() => app.logs.some((l) => l.includes("handoff.report_failed")));
  await Bun.sleep(200);
  expect(respondio.callsTo("/contact/id:114/tag")).toHaveLength(1);
});

test("§7 errors: configured labels are used", async () => {
  const { app, gateway, respondio } = await startHarness({
    channels: "respondio",
    env: {
      RESPONDIO_HANDOFF_LABEL: "human",
      RESPONDIO_ERROR_LABEL: "bot-error",
    },
  });
  gateway.script(() => ({ status: 400 }));
  await postWebhook(app.url, messageEvent({ contact: 115, text: "hi" }));
  await until(() => respondio.callsTo("/contact/id:115/tag").length === 1);
  expect(respondio.callsTo("/contact/id:115/tag")[0]?.body).toEqual([
    "human",
    "bot-error",
  ]);
});
