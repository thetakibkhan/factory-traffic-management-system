import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApplication } from "./app.js";
import { ControllerEventService } from "./application/controllerEventService.js";
import { PerJunctionSerialProcessor } from "./application/perJunctionSerialProcessor.js";

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
  await prisma.junction.deleteMany({ where: { id: junctionId } });
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

  it("keeps queues idempotent through arrival and clearance requests", async () => {
    const eventId = `arrival-${crypto.randomUUID()}`;
    const arrival = {
      event_id: eventId,
      junction_id: junctionId,
      direction: "NORTH",
      event_type: "VEHICLE_ARRIVED",
      vehicle_id: `vehicle-${crypto.randomUUID()}`,
      vehicle_type: "TRUCK",
      sequence_no: 1,
      timestamp: new Date().toISOString(),
    };
    const submit = () => fetch(`${baseUrl}/sensor-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(arrival),
    });
    const first = await submit();
    const duplicate = await submit();
    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 200);
    const duplicateBody: unknown = await duplicate.json();
    assert.equal(isObject(duplicateBody) && duplicateBody.duplicate === true, true);

    const clear = await fetch(`${baseUrl}/sensor-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: `clear-${crypto.randomUUID()}`,
        junction_id: junctionId,
        direction: "NORTH",
        event_type: "VEHICLE_CLEARED",
        vehicle_id: arrival.vehicle_id,
        sequence_no: 2,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(clear.status, 201);
    const status = await fetch(`${baseUrl}/junctions/${junctionId}/status`);
    const body: unknown = await status.json();
    assert.equal(isObject(body) && isObject(body.queues) && body.queues.NORTH === 0, true);
  });

  it("accepts manual control and returns to automatic through command APIs", async () => {
    const manual = await fetch(`${baseUrl}/junctions/${junctionId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command_type: "MANUAL_GREEN_REQUEST", direction: "WEST" }),
    });
    assert.equal(manual.status, 202);
    const manualStatusResponse = await fetch(`${baseUrl}/junctions/${junctionId}/status`);
    const manualStatus: unknown = await manualStatusResponse.json();
    assert.equal(isObject(manualStatus) && manualStatus.mode === "MANUAL", true);
    assert.equal(isObject(manualStatus) && typeof manualStatus.manual_lease_expires_at === "string", true);
    assert.equal(isObject(manualStatus) && manualStatus.pending_command === null, true);

    const automatic = await fetch(`${baseUrl}/junctions/${junctionId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command_type: "RETURN_TO_AUTOMATIC" }),
    });
    assert.equal(automatic.status, 202);
    const automaticStatusResponse = await fetch(`${baseUrl}/junctions/${junctionId}/status`);
    const automaticStatus: unknown = await automaticStatusResponse.json();
    assert.equal(isObject(automaticStatus) && automaticStatus.mode === "AUTOMATIC", true);
  });

  it("keeps concurrent arrivals safe and selects emergency traffic", async () => {
    const submitArrival = (direction: "NORTH" | "EAST", sequenceNo: number, vehicleType: "TRUCK" | "EMERGENCY") => fetch(`${baseUrl}/sensor-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: `${vehicleType.toLowerCase()}-${crypto.randomUUID()}`,
        junction_id: junctionId,
        direction,
        event_type: "VEHICLE_ARRIVED",
        vehicle_id: `${vehicleType}-${crypto.randomUUID()}`,
        vehicle_type: vehicleType,
        sequence_no: sequenceNo,
        timestamp: new Date().toISOString(),
      }),
    });
    const arrivals = await Promise.all([
      submitArrival("NORTH", 3, "TRUCK"),
      submitArrival("EAST", 1, "EMERGENCY"),
    ]);
    assert.deepEqual(arrivals.map((response) => response.status), [201, 201]);
    const response = await fetch(`${baseUrl}/junctions/${junctionId}/status`);
    const status: unknown = await response.json();
    assert.equal(response.status, 200);
    assert.equal(isObject(status) && isObject(status.phase_policy) && status.phase_policy.emergency_phase === "EAST_WEST", true);
    if (isObject(status) && isObject(status.actual_signals)) {
      assert.equal(status.actual_signals.NORTH === "GREEN" && status.actual_signals.EAST === "GREEN", false);
    } else {
      assert.fail("Status response did not include the actual signal vector");
    }
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

    const sensorEvent = await fetch(`${baseUrl}/controller-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: `sensor-${crypto.randomUUID()}`,
        junction_id: junctionId,
        event_type: "DEVICE_STATUS",
        device_type: "SENSOR",
        status: "OFFLINE",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(sensorEvent.status, 202);

    const signalOnline = await fetch(`${baseUrl}/controller-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: `signal-online-${crypto.randomUUID()}`,
        junction_id: junctionId,
        event_type: "DEVICE_STATUS",
        device_type: "SIGNAL_CONTROLLER",
        direction: "WEST",
        status: "ONLINE",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(signalOnline.status, 202);
    const sensorOnline = await fetch(`${baseUrl}/controller-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: `sensor-online-${crypto.randomUUID()}`,
        junction_id: junctionId,
        event_type: "DEVICE_STATUS",
        device_type: "SENSOR",
        status: "ONLINE",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(sensorOnline.status, 202);
    const recoveredResponse = await fetch(`${baseUrl}/junctions/${junctionId}/status`);
    const recovered: unknown = await recoveredResponse.json();
    assert.equal(isObject(recovered) && recovered.physical_state_trust === "CONFIRMED", true);
    assert.equal(isObject(recovered) && Array.isArray(recovered.alerts) && recovered.alerts.some((item) => isObject(item) && ["SIGNAL_OFFLINE", "SENSOR_OFFLINE"].includes(String(item.code))), false);
  });

  it("recovers persisted queue and history through startup reconciliation", async () => {
    const pendingCommandId = `restart-${crypto.randomUUID()}`;
    await prisma.controllerCommand.create({
      data: {
        commandId: pendingCommandId,
        junctionId,
        desiredSignals: { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" },
        runtimeVersion: 0,
        status: "PENDING",
      },
    });
    const service = new ControllerEventService(prisma, new PerJunctionSerialProcessor());
    await service.prepareJunctionForStartup(junctionId);
    const failedCommand = await prisma.controllerCommand.findUnique({ where: { commandId: pendingCommandId } });
    assert.equal(failedCommand?.status, "FAILED");
    const statusResponse = await fetch(`${baseUrl}/junctions/${junctionId}/status`);
    const status: unknown = await statusResponse.json();
    assert.equal(isObject(status) && status.stage === "STARTUP_RECONCILIATION", true);
    assert.equal(isObject(status) && isObject(status.queues) && status.queues.NORTH === 1 && status.queues.EAST === 1, true);

    const historyResponse = await fetch(`${baseUrl}/junctions/${junctionId}/history?limit=100`);
    const history: unknown = await historyResponse.json();
    assert.equal(isObject(history) && Array.isArray(history.events) && history.events.some((item) => isObject(item) && item.kind === "STARTUP_RECONCILIATION_REQUIRED"), true);
    const snapshot = await fetch(`${baseUrl}/simulators/${junctionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ health: "ONLINE" }),
    });
    assert.equal(snapshot.status, 200);
    const recoveredResponse = await fetch(`${baseUrl}/junctions/${junctionId}/status`);
    const recovered: unknown = await recoveredResponse.json();
    assert.equal(isObject(recovered) && recovered.physical_state_trust === "CONFIRMED", true);
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
