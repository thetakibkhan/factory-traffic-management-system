import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControllerEventService } from "./controllerEventService.js";

describe("controller event validation", () => {
  it("accepts a complete full-junction snapshot", () => {
    const event = ControllerEventService.parse({
      event_id: "snapshot-1",
      junction_id: "A",
      event_type: "STATE_SNAPSHOT",
      actual_signals: { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" },
      timestamp: "2026-10-29T08:15:25Z",
    });

    assert.equal(event.event_type, "STATE_SNAPSHOT");
  });

  it("rejects partial vectors and unknown fields", () => {
    const event = {
      event_id: "snapshot-1",
      junction_id: "A",
      event_type: "STATE_SNAPSHOT",
      actual_signals: { NORTH: "RED", SOUTH: "RED", EAST: "RED" },
      timestamp: "2026-10-29T08:15:25Z",
    };

    assert.throws(() => ControllerEventService.parse(event));
    assert.throws(() => ControllerEventService.parse({ ...event, actual_signals: { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" }, extra: true }));
  });

  it("accepts sensor and directional signal device status while rejecting an unspecified signal direction", () => {
    const base = {
      event_id: "device-status-1",
      junction_id: "A",
      event_type: "DEVICE_STATUS",
      status: "OFFLINE",
      timestamp: "2026-10-29T08:15:25Z",
    };
    assert.equal(ControllerEventService.parse({ ...base, device_type: "SENSOR" }).event_type, "DEVICE_STATUS");
    assert.equal(ControllerEventService.parse({ ...base, device_type: "SIGNAL_CONTROLLER", direction: "WEST" }).event_type, "DEVICE_STATUS");
    assert.throws(() => ControllerEventService.parse({ ...base, device_type: "SIGNAL_CONTROLLER" }));
  });
});
