import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SensorEventService } from "./sensorEventService.js";

describe("sensor event validation", () => {
  it("normalizes identifiers and accepts a complete arrival", () => {
    const event = SensorEventService.parse({
      event_id: "  arrival-1 ",
      junction_id: " A ",
      direction: "NORTH",
      event_type: "VEHICLE_ARRIVED",
      vehicle_id: " VH-1 ",
      vehicle_type: "TRUCK",
      sequence_no: 7,
      timestamp: "2026-10-29T08:15:20Z",
    });

    assert.equal(event.event_id, "arrival-1");
    assert.equal(event.junction_id, "A");
    assert.equal(event.vehicle_id, "VH-1");
  });

  it("accepts a clearance without a vehicle type", () => {
    const event = SensorEventService.parse({
      event_id: "clear-1",
      junction_id: "A",
      direction: "NORTH",
      event_type: "VEHICLE_CLEARED",
      vehicle_id: "VH-1",
      sequence_no: 8,
      timestamp: "2026-10-29T08:15:25Z",
    });

    assert.equal(event.event_type, "VEHICLE_CLEARED");
  });

  it("rejects unknown fields, nonpositive sequences, and a clearance vehicle type", () => {
    const baseEvent = {
      event_id: "event-1",
      junction_id: "A",
      direction: "NORTH",
      event_type: "VEHICLE_CLEARED",
      vehicle_id: "VH-1",
      sequence_no: 0,
      timestamp: "2026-10-29T08:15:25Z",
    };

    assert.throws(() => SensorEventService.parse({ ...baseEvent, ignored: true }));
    assert.throws(() => SensorEventService.parse(baseEvent));
    assert.throws(() => SensorEventService.parse({ ...baseEvent, sequence_no: 8, vehicle_type: "TRUCK" }));
  });
});
