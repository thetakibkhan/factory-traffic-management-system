import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPhaseQueues, chooseAutomaticPhase, chooseEmergencyPhase, type WaitingVehicle } from "./schedulingPolicy.js";

describe("traffic scheduling policy", () => {
  it("scores vehicle classes and caps the oldest-wait age bonus", () => {
    const queues = buildPhaseQueues([
      vehicle("NORTH", "EMPLOYEE_VEHICLE", 20_000, "employee"),
      vehicle("SOUTH", "FORKLIFT", 10_000, "forklift"),
      vehicle("EAST", "TRUCK", 150_000, "truck"),
    ], 160_000);

    assert.deepEqual(queues.NORTH_SOUTH, { count: 2, weightedScore: 11, oldestWaitMs: 150_000 });
    assert.deepEqual(queues.EAST_WEST, { count: 1, weightedScore: 4, oldestWaitMs: 10_000 });
  });

  it("gives 90-second starvation precedence and uses configured phase order for ties", () => {
    const queues = buildPhaseQueues([
      vehicle("NORTH", "EMPLOYEE_VEHICLE", 0, "north"),
      vehicle("EAST", "TRUCK", 50_000, "east"),
    ], 90_000);

    assert.equal(chooseAutomaticPhase(queues, "EAST_WEST"), "NORTH_SOUTH");
    assert.equal(chooseAutomaticPhase({
      NORTH_SOUTH: { count: 1, weightedScore: 8, oldestWaitMs: 100_000 },
      EAST_WEST: { count: 1, weightedScore: 8, oldestWaitMs: 100_000 },
    }, null), "NORTH_SOUTH");
  });

  it("retains the current phase on a score tie and returns no phase for empty queues", () => {
    const equal = {
      NORTH_SOUTH: { count: 1, weightedScore: 4, oldestWaitMs: 0 },
      EAST_WEST: { count: 1, weightedScore: 4, oldestWaitMs: 0 },
    };
    assert.equal(chooseAutomaticPhase(equal, "EAST_WEST"), "EAST_WEST");
    assert.equal(chooseAutomaticPhase({
      NORTH_SOUTH: { count: 0, weightedScore: 0, oldestWaitMs: 0 },
      EAST_WEST: { count: 0, weightedScore: 0, oldestWaitMs: 0 },
    }, "NORTH_SOUTH"), null);
  });

  it("selects the earliest active emergency and resolves equal arrival times by event ID", () => {
    const winner = chooseEmergencyPhase([
      vehicle("EAST", "EMERGENCY", 10_000, "vehicle-z", "z-event"),
      vehicle("NORTH", "EMERGENCY", 10_000, "vehicle-a", "a-event"),
      vehicle("WEST", "EMERGENCY", 20_000, "later", "later-event"),
    ]);
    assert.equal(winner, "NORTH_SOUTH");
  });
});

function vehicle(
  direction: WaitingVehicle["direction"],
  type: WaitingVehicle["type"],
  arrivedAt: number,
  vehicleId: string,
  eventId = vehicleId,
): WaitingVehicle {
  return { direction, type, arrivedAtServer: new Date(arrivedAt), vehicleId, eventId };
}
