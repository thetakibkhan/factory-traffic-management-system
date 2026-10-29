import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApplication } from "./app.js";

const prisma = new PrismaClient();
const junctionId = `test-${crypto.randomUUID().slice(0, 12)}`;
let server: Server;
let baseUrl: string;

before(async () => {
  await prisma.$connect();
  server = createServer(createApplication(prisma).app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await prisma.junction.deleteMany({ where: { id: { startsWith: "test-" } } });
  await prisma.$disconnect();
});

describe("junction and device APIs", () => {
  it("creates a junction with safe startup state and serves its detail", async () => {
    const created = await fetch(`${baseUrl}/junctions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: junctionId }),
    });
    assert.equal(created.status, 201);

    const detail = await fetch(`${baseUrl}/junctions/${junctionId}`);
    assert.equal(detail.status, 200);
    const body: unknown = await detail.json();
    assert.equal(isObject(body) && body.junction_id === junctionId, true);

    const duplicate = await fetch(`${baseUrl}/junctions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: junctionId }),
    });
    assert.equal(duplicate.status, 409);
  });

  it("records signal and sensor health and exposes failure alerts", async () => {
    const event = await fetch(`${baseUrl}/controller-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: `failure-${crypto.randomUUID()}`,
        junction_id: junctionId,
        event_type: "DEVICE_STATUS",
        device_type: "SIGNAL_CONTROLLER",
        direction: "WEST",
        status: "OFFLINE",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(event.status, 202);

    const status = await fetch(`${baseUrl}/junctions/${junctionId}/status`);
    const body: unknown = await status.json();
    assert.equal(status.status, 200);
    assert.equal(isObject(body) && Array.isArray(body.device_statuses), true);
    assert.equal(isObject(body) && Array.isArray(body.alerts) && body.alerts.some((item) => isObject(item) && item.code === "SIGNAL_OFFLINE"), true);
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
