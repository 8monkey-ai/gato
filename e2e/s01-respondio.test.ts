import { expect, test } from "bun:test";

import { logEvents, waitFor } from "./support/app.ts";
import { useHarness } from "./support/fixture.ts";
import { conversation } from "./support/gateway.ts";
import { deliver, incoming, outgoingEvent } from "./support/respondio.ts";
import { readChat } from "./support/setup.ts";

const f = useHarness(["rio"]);

async function chat(contact: string) {
  return (await readChat(f.app.dataDir, "rio", contact)).filter(
    (entry) => entry.kind === "message",
  );
}

test("§1 respond.io: a signed incoming message is saved before acknowledgement and answered on the platform's selected route", async () => {
  f.gateway.reply({ text: "Hello Ana" });
  const app = await f.start();
  const response = await deliver(
    app.url,
    incoming("21", { type: "text", text: "Hi" }),
  );
  expect(response.status).toBe(200);
  expect((await chat("21")).map((entry) => entry.text)).toEqual(["Hi"]);
  await waitFor(() => f.respond.sentTexts("21").length === 1);
  const send = f.respond.calls.find(
    (call) => call.path === "/contact/id:21/message",
  )!;
  expect(send.body).toEqual({ message: { type: "text", text: "Hello Ana" } });
});

test("§1 notifications with an invalid signature are rejected and not recorded", async () => {
  const app = await f.start();
  const response = await deliver(
    app.url,
    incoming("22", { type: "text", text: "Hi" }),
    "rio",
    "forged",
  );
  expect(response.status).toBe(401);
  await Bun.sleep(200);
  expect(await chat("22")).toEqual([]);
  expect(f.gateway.requests).toHaveLength(0);
});

test("§1 malformed notifications are logged without running the agent; irrelevant ones are ignored", async () => {
  const app = await f.start();
  const malformed = { event_type: "message.received", contact: { id: 23 } };
  expect((await deliver(app.url, malformed)).status).toBe(400);
  expect(logEvents(app.logs, "respondio.webhook_malformed")).toHaveLength(1);
  const irrelevant = { event_type: "contact.tag.updated", contact: { id: 23 } };
  expect((await deliver(app.url, irrelevant)).status).toBe(200);
  await Bun.sleep(200);
  expect(f.gateway.requests).toHaveLength(0);
});

test("§1 repeated notifications do not duplicate messages or actions", async () => {
  f.gateway.reply({ text: "Once" });
  const app = await f.start();
  const event = incoming("24", { type: "text", text: "Hi" });
  await deliver(app.url, event);
  await deliver(app.url, event);
  await waitFor(() => f.respond.sentTexts("24").length === 1);
  await Bun.sleep(300);
  expect(
    (await chat("24")).filter((entry) => entry.role === "customer"),
  ).toHaveLength(1);
  expect(f.respond.sentTexts("24")).toHaveLength(1);
});

async function recordMixedTraffic(url: string) {
  await deliver(url, incoming("25", { type: "text", text: "Question" }));
  await waitFor(() => f.respond.sentTexts("25").length === 1);
  const sent = await waitFor(async () =>
    (await chat("25")).find((entry) => entry.role === "agent" && entry.ref),
  );
  const echo = outgoingEvent(
    "25",
    { type: "text", text: "Agent answer" },
    { source: "api" },
    { id: Number(sent.ref) },
  );
  await deliver(url, echo);
  const user = { id: 9, firstName: "Jane", lastName: "Doe" };
  await deliver(
    url,
    outgoingEvent(
      "25",
      { type: "text", text: "Operator note" },
      { source: "user", userId: 9 },
      { user },
    ),
  );
  await deliver(
    url,
    outgoingEvent(
      "25",
      { type: "text", text: "Workflow greeting" },
      { source: "workflow" },
    ),
  );
  await deliver(
    url,
    outgoingEvent("25", { type: "text", text: "Who sent this" }, {}),
  );
  await Bun.sleep(300);
}

test("§1 message classification: operator, workflow, unknown and echoed agent messages keep attribution and never trigger replies", async () => {
  f.gateway.reply({ text: "Agent answer" });
  const app = await f.start();
  await recordMixedTraffic(app.url);
  expect(f.gateway.requests).toHaveLength(1);
  expect(
    (await chat("25")).map((entry) => [entry.role, entry.text, entry.sender]),
  ).toEqual([
    ["customer", "Question", undefined],
    ["agent", "Agent answer", undefined],
    ["operator", "Operator note", { id: "9", name: "Jane Doe" }],
    ["workflow", "Workflow greeting", undefined],
    ["operator", "Who sent this", "unknown"],
  ]);
});

test("§1 operator and workflow content is assistant-side with attribution in model context; agent echoes appear once", async () => {
  f.gateway.reply({ text: "Agent answer" });
  const app = await f.start();
  await recordMixedTraffic(app.url);
  f.gateway.reply({ text: "Next" });
  await deliver(app.url, incoming("25", { type: "text", text: "Follow-up" }));
  await waitFor(() => f.gateway.requests.length === 2);
  expect(conversation(f.gateway.requests[1]!)).toEqual([
    ["user", "Question"],
    ["assistant", "Agent answer"],
    ["assistant", "[Human colleague, Jane Doe] Operator note"],
    ["assistant", "[Automated workflow] Workflow greeting"],
    ["assistant", "[Human colleague, unknown sender] Who sent this"],
    ["user", "Follow-up"],
  ]);
});

test("§1 operator attachments with captions are recorded and stay available to the agent", async () => {
  const files = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
  });
  try {
    f.gateway.reply({ text: "Ok" });
    const app = await f.start();
    const attachment = {
      type: "image",
      url: `http://localhost:${files.port}/a.png`,
      fileName: "a.png",
      mimeType: "image/png",
      description: "Price list",
    };
    await deliver(
      app.url,
      outgoingEvent(
        "26",
        { type: "attachment", attachment },
        { source: "user", userId: 9 },
      ),
    );
    const stored = await waitFor(
      async () => (await chat("26"))[0]?.attachments?.[0]?.file,
    );
    expect(stored).toMatch(/^attachments\/.+\.png$/);
    expect((await chat("26"))[0]!.attachments![0]!.description).toBe(
      "Price list",
    );
  } finally {
    await files.stop(true);
  }
});
