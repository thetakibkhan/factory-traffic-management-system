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
});
