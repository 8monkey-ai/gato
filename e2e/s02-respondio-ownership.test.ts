import { expect, test } from "bun:test";

import { waitFor } from "./support/app.ts";
import { useHarness } from "./support/fixture.ts";
import {
  agentUserId,
  assignment,
  closure,
  deliver,
  incoming,
} from "./support/respondio.ts";
import { readChat, readState } from "./support/setup.ts";

const f = useHarness(["rio"]);
const human = 12;

test("§2 default policy: unassigned and human-owned conversations are history only", async () => {
  const app = await f.start();
  await deliver(
    app.url,
    incoming("31", { type: "text", text: "Unassigned" }, { assignee: null }),
  );
  await deliver(
    app.url,
    incoming("32", { type: "text", text: "Human owned" }, { assignee: human }),
  );
  await Bun.sleep(400);
  expect(f.gateway.requests).toHaveLength(0);
  expect(
    (await readChat(app.dataDir, "rio", "31")).map((entry) => entry.text),
  ).toEqual(["Unassigned"]);
  expect((await readState(app.dataDir, "rio", "32")).assignee).toBe("human");
});

test("§2 assignment back to the agent prompts one review; a repeated unchanged assignment does not", async () => {
  f.gateway.reply({ text: "I can help now" });
  const app = await f.start();
  await deliver(
    app.url,
    incoming("33", { type: "text", text: "Help?" }, { assignee: human }),
  );
  await deliver(app.url, assignment("33", agentUserId));
  await waitFor(() => f.respond.sentTexts("33").length === 1);
  await deliver(app.url, assignment("33", agentUserId));
  await Bun.sleep(400);
  expect(f.respond.sentTexts("33")).toEqual(["I can help now"]);
});

test("§2 shared-inbox policy answers unassigned conversations but not human-owned ones", async () => {
  f.gateway.reply({ text: "Shared answer" });
  const app = await f.start({ OWNERSHIP_POLICY: "shared" });
  await deliver(
    app.url,
    incoming("34", { type: "text", text: "Hi" }, { assignee: null }),
  );
  await deliver(
    app.url,
    incoming("35", { type: "text", text: "Hi" }, { assignee: human }),
  );
  await waitFor(() => f.respond.sentTexts("34").length === 1);
  await Bun.sleep(300);
  expect(f.respond.sentTexts("35")).toHaveLength(0);
});

test("§2 unrestricted policy answers regardless of assignment", async () => {
  f.gateway.reply({ text: "Always" });
  const app = await f.start({ OWNERSHIP_POLICY: "unrestricted" });
  await deliver(
    app.url,
    incoming("36", { type: "text", text: "Hi" }, { assignee: human }),
  );
  await waitFor(() => f.respond.sentTexts("36").length === 1);
});

test("§2 a human taking ownership lets the current reply finish, then no further replies start", async () => {
  f.gateway.reply({ text: "One\n\nTwo\n\nThree" });
  const app = await f.start({ DELIVERY_PAUSE: "300ms" });
  await deliver(app.url, incoming("37", { type: "text", text: "Tell me" }));
  await waitFor(() => f.respond.sentTexts("37").length === 1);
  await deliver(app.url, assignment("37", human));
  await waitFor(() => f.respond.sentTexts("37").length === 3);
  expect(f.respond.sentTexts("37")).toEqual(["One", "Two", "Three"]);
  await deliver(
    app.url,
    incoming("37", { type: "text", text: "More?" }, { assignee: human }),
  );
  await Bun.sleep(500);
  expect(f.gateway.requests).toHaveLength(1);
});

test("§2 closing records no reply; reopening follows the current ownership policy with the same history", async () => {
  f.gateway.reply({ text: "Reply" });
  const app = await f.start();
  await deliver(app.url, incoming("38", { type: "text", text: "First" }));
  await waitFor(() => f.respond.sentTexts("38").length === 1);
  await deliver(app.url, closure("38", true));
  await Bun.sleep(300);
  expect((await readState(app.dataDir, "rio", "38")).open).toBe(false);
  expect(f.respond.sentTexts("38")).toHaveLength(1);
  expect(f.gateway.requests).toHaveLength(1);
  await deliver(app.url, closure("38", false));
  await deliver(app.url, incoming("38", { type: "text", text: "Back again" }));
  await waitFor(() => f.respond.sentTexts("38").length === 2);
  expect(
    (await readChat(app.dataDir, "rio", "38")).filter(
      (entry) => entry.role === "customer",
    ),
  ).toHaveLength(2);
});
