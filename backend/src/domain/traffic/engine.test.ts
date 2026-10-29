import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptControllerSnapshot,
  acknowledgeCommand,
  advanceTime,
  createInitialState,
  markUnknown,
  requestAllRed,
  requestPhase,
} from "./engine.js";
import {
  DEFAULT_JUNCTION_CONFIG,
  allRedSignals,
  greenSignals,
  yellowSignals,
  type SignalVector,
  type TrafficState,
} from "./types.js";

const config = DEFAULT_JUNCTION_CONFIG;

describe("traffic safety engine", () => {
  it("starts without trusting a previous controller state", () => {
    const state = createInitialState();

    assert.equal(state.stage, "STARTUP_RECONCILIATION");
    assert.equal(state.mode, "DEGRADED");
    assert.equal(state.stateTrust, "UNKNOWN");
    assert.equal(state.actualSignals, null);
  });

  it("waits for confirmed all-red clearance before requesting green", () => {
    const snapshot = acceptControllerSnapshot(createInitialState(), allRedSignals(), "snapshot", 0, config);
    const request = requestPhase(snapshot.state, "NORTH_SOUTH", "unused", 1_000, config);
    const tooEarly = advanceTime(request.state, "too-early", 1_999, config);
    const due = advanceTime(request.state, "green-ns", 2_000, config);

    assert.equal(tooEarly.command, null);
    assert.deepEqual(due.command?.desiredSignals, greenSignals("NORTH_SOUTH", config));
  });

  it("uses confirmed yellow and all-red intervals when changing phases", () => {
    const startup = acceptControllerSnapshot(
      createInitialState(),
      greenSignals("NORTH_SOUTH", config),
      "startup-yellow",
      0,
      config,
    );
    const yellowAck = acknowledgeCommand(
      startup.state,
      "startup-yellow",
      yellowSignals("NORTH_SOUTH", config),
      1,
      config,
    );
    const eastWestTarget = requestPhase(yellowAck.state, "EAST_WEST", "request-ew", 2, config);
    const redCommand = advanceTime(eastWestTarget.state, "all-red", 5_001, config);
    const redAck = acknowledgeCommand(redCommand.state, "all-red", allRedSignals(), 5_002, config);
    const greenCommand = advanceTime(redAck.state, "green-ew", 7_002, config);

    assert.deepEqual(startup.command?.desiredSignals, yellowSignals("NORTH_SOUTH", config));
    assert.deepEqual(redCommand.command?.desiredSignals, allRedSignals());
    assert.deepEqual(greenCommand.command?.desiredSignals, greenSignals("EAST_WEST", config));
    assertNoConflictingGreen(startup.command?.desiredSignals);
    assertNoConflictingGreen(redCommand.command?.desiredSignals);
    assertNoConflictingGreen(greenCommand.command?.desiredSignals);
  });

  it("enforces minimum green for normal requests but permits safe overrides", () => {
    const green = confirmedNorthSouthGreen();
    const greenStartedAt = green.stageStartedAt ?? 0;
    const beforeMinimum = requestPhase(green, "EAST_WEST", "early", greenStartedAt + 9_999, config);
    const afterMinimum = requestPhase(green, "EAST_WEST", "normal-yellow", greenStartedAt + 10_000, config);
    const override = requestPhase(green, "EAST_WEST", "override-yellow", 2_001, config, "OVERRIDE");

    assert.equal(beforeMinimum.command, null);
    assert.deepEqual(afterMinimum.command?.desiredSignals, yellowSignals("NORTH_SOUTH", config));
    assert.deepEqual(override.command?.desiredSignals, yellowSignals("NORTH_SOUTH", config));
  });

  it("ignores stale acknowledgements", () => {
    const pending = acceptControllerSnapshot(
      createInitialState(),
      greenSignals("NORTH_SOUTH", config),
      "current-command",
      0,
      config,
    ).state;
    const result = acknowledgeCommand(pending, "old-command", allRedSignals(), 1, config);

    assert.equal(result.outcome, "NO_OP");
    assert.equal(result.state, pending);
  });

  it("locks out when an ACK does not match the pending command", () => {
    const pending = acceptControllerSnapshot(
      createInitialState(),
      greenSignals("NORTH_SOUTH", config),
      "yellow-command",
      0,
      config,
    ).state;
    const result = acknowledgeCommand(pending, "yellow-command", allRedSignals(), 1, config);

    assert.equal(result.state.stage, "FAULT_LOCKOUT");
    assert.equal(result.state.stateTrust, "MISMATCH");
    assert.equal(result.command, null);
  });

  it("locks out an unsafe mixed-phase controller snapshot", () => {
    const unsafeSignals: SignalVector = {
      NORTH: "GREEN",
      SOUTH: "RED",
      EAST: "GREEN",
      WEST: "RED",
    };
    const result = acceptControllerSnapshot(createInitialState(), unsafeSignals, "snapshot", 1, config);

    assert.equal(result.state.stage, "FAULT_LOCKOUT");
    assert.equal(result.state.faultReason, "Controller snapshot is not a safe complete phase vector");
  });

  it("allows a fresh all-red snapshot to recover from lockout", () => {
    const locked = markUnknown(createInitialState(), "controller went offline");
    const recovered = acceptControllerSnapshot(locked, allRedSignals(), "recovery-snapshot", 10, config);

    assert.equal(recovered.state.stage, "ALL_RED");
    assert.equal(recovered.state.stateTrust, "CONFIRMED");
    assert.equal(recovered.state.mode, "AUTOMATIC");
    assert.equal(recovered.state.stageDeadlineAt, 10 + config.timing.allRedMs);
  });

  it("returns an empty green phase to all-red through yellow", () => {
    const result = requestAllRed(confirmedNorthSouthGreen(), "clear-phase", 40_000, config);

    assert.equal(result.command?.desiredSignals.NORTH, "YELLOW");
    assert.equal(result.state.targetPhase, null);
    assertNoConflictingGreen(result.command?.desiredSignals);
  });

  it("starts a fresh all-red clearance interval when traffic arrives after an empty phase", () => {
    const emptyAllRed: TrafficState = {
      ...createInitialState(),
      stage: "ALL_RED",
      stateTrust: "CONFIRMED",
      actualSignals: allRedSignals(),
      stageDeadlineAt: null,
    };
    const requested = requestPhase(emptyAllRed, "EAST_WEST", "arrival", 10_000, config);

    assert.equal(requested.command, null);
    assert.equal(requested.state.stageDeadlineAt, 12_000);
    assert.deepEqual(advanceTime(requested.state, "green-ew", 12_000, config).command?.desiredSignals, greenSignals("EAST_WEST", config));
  });
});

function confirmedNorthSouthGreen() {
  const startup = acceptControllerSnapshot(
    createInitialState(),
    greenSignals("NORTH_SOUTH", config),
    "startup-yellow",
    0,
    config,
  );
  const yellowAck = acknowledgeCommand(
    startup.state,
    "startup-yellow",
    yellowSignals("NORTH_SOUTH", config),
    1,
    config,
  );
  const allRed = advanceTime(yellowAck.state, "all-red", 5_001, config);
  const allRedAck = acknowledgeCommand(allRed.state, "all-red", allRedSignals(), 5_002, config);
  const green = advanceTime(allRedAck.state, "green-ns", 7_002, config);
  return acknowledgeCommand(green.state, "green-ns", greenSignals("NORTH_SOUTH", config), 7_003, config).state;
}

function assertNoConflictingGreen(signals: SignalVector | undefined): void {
  if (signals === undefined) return;
  const northSouthIsGreen = signals.NORTH === "GREEN" || signals.SOUTH === "GREEN";
  const eastWestIsGreen = signals.EAST === "GREEN" || signals.WEST === "GREEN";
  assert.equal(northSouthIsGreen && eastWestIsGreen, false);
}
