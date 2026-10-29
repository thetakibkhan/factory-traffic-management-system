import {
  allRedSignals,
  greenSignals,
  PHASES,
  yellowSignals,
  type EngineResult,
  type JunctionConfig,
  type Phase,
  type RuntimeStage,
  type SignalCommand,
  type SignalVector,
  type TrafficState,
} from "./types.js";

export function createInitialState(): TrafficState {
  return {
    mode: "DEGRADED",
    stage: "STARTUP_RECONCILIATION",
    phase: null,
    targetPhase: null,
    version: 0,
    desiredSignals: allRedSignals(),
    actualSignals: null,
    stateTrust: "UNKNOWN",
    actualObservedAt: null,
    stageStartedAt: null,
    stageDeadlineAt: null,
    pendingCommand: null,
    faultReason: null,
  };
}

export function requestPhase(
  state: TrafficState,
  phase: Phase,
  commandId: string,
  now: number,
  config: JunctionConfig,
  priority: "NORMAL" | "OVERRIDE" = "NORMAL",
): EngineResult {
  if (state.stage === "FAULT_LOCKOUT") return { state, command: null, outcome: "LOCKED" };
  if (state.targetPhase === phase && state.pendingCommand === null
    && !(state.stage === "ALL_RED" && state.stageDeadlineAt === null)) {
    return { state, command: null, outcome: "NO_OP" };
  }

  const next = { ...state, targetPhase: phase, version: state.version + 1 };
  if (next.stateTrust !== "CONFIRMED" || next.actualSignals === null) {
    return { state: next, command: null, outcome: "APPLIED" };
  }

  if (isGreenStage(next.stage) && next.phase !== phase) {
    const minimumGreenEndsAt = (next.stageStartedAt ?? now) + config.timing.minimumGreenMs;
    if (priority === "NORMAL" && now < minimumGreenEndsAt) {
      return { state: next, command: null, outcome: "APPLIED" };
    }
    return issueCommand(next, yellowSignals(next.phase ?? phase, config), commandId, now);
  }
  if (next.stage === "ALL_RED") {
    if (next.stageDeadlineAt === null) {
      return { state: { ...next, stageStartedAt: now, stageDeadlineAt: now + config.timing.allRedMs }, command: null, outcome: "APPLIED" };
    }
    if (now >= next.stageDeadlineAt) return issueCommand(next, greenSignals(phase, config), commandId, now);
  }
  return { state: next, command: null, outcome: "APPLIED" };
}

export function requestAllRed(
  state: TrafficState,
  commandId: string,
  now: number,
  config: JunctionConfig,
): EngineResult {
  if (state.stage === "FAULT_LOCKOUT") return { state, command: null, outcome: "LOCKED" };
  if (state.stage === "NORTH_SOUTH_GREEN" || state.stage === "EAST_WEST_GREEN") {
    const phase = state.phase;
    if (phase !== null) {
      return issueCommand({ ...state, targetPhase: null }, yellowSignals(phase, config), commandId, now);
    }
  }
  return { state: { ...state, targetPhase: null, version: state.version + 1 }, command: null, outcome: "APPLIED" };
}

export function acceptControllerSnapshot(
  state: TrafficState,
  actualSignals: SignalVector,
  commandId: string,
  now: number,
  config: JunctionConfig,
): EngineResult {
  const observed: TrafficState = { ...state, actualSignals, actualObservedAt: now, stateTrust: "CONFIRMED" };
  if (isAllRed(actualSignals)) {
    return {
      state: {
        ...observed,
        mode: "AUTOMATIC",
        stage: "ALL_RED",
        phase: null,
        desiredSignals: allRedSignals(),
        pendingCommand: null,
        stageStartedAt: now,
        stageDeadlineAt: now + config.timing.allRedMs,
        faultReason: null,
      },
      command: null,
      outcome: "APPLIED",
    };
  }

  const observedPhase = phaseForSignals(actualSignals, config);
  if (observedPhase === null) return lockout(observed, "Controller snapshot is not a safe complete phase vector");

  const hasGreen = config.phases[observedPhase].every((direction) => actualSignals[direction] === "GREEN");
  const hasYellow = config.phases[observedPhase].every((direction) => actualSignals[direction] === "YELLOW");
  if (hasGreen) {
    const yellow = yellowSignals(observedPhase, config);
    return issueCommand(
      { ...observed, stage: yellowStage(observedPhase), phase: observedPhase, targetPhase: state.targetPhase ?? observedPhase },
      yellow,
      commandId,
      now,
    );
  }
  if (hasYellow) {
    return {
      state: {
        ...observed,
        mode: "AUTOMATIC",
        stage: yellowStage(observedPhase),
        phase: observedPhase,
        desiredSignals: actualSignals,
        pendingCommand: null,
        stageStartedAt: now,
        stageDeadlineAt: now + config.timing.yellowMs,
        faultReason: null,
      },
      command: null,
      outcome: "APPLIED",
    };
  }
  return lockout(observed, "Controller snapshot contains an unsupported signal combination");
}

export function acknowledgeCommand(
  state: TrafficState,
  commandId: string,
  actualSignals: SignalVector,
  now: number,
  config: JunctionConfig,
): EngineResult {
  const pending = state.pendingCommand;
  if (pending === null || pending.commandId !== commandId || pending.runtimeVersion !== state.version) {
    return { state, command: null, outcome: "NO_OP" };
  }
  if (!sameSignals(pending.desiredSignals, actualSignals)) {
    return lockout({ ...state, actualSignals, actualObservedAt: now, stateTrust: "MISMATCH" }, "Controller ACK did not match the requested signal vector");
  }

  const observed = {
    ...state,
    actualSignals,
    actualObservedAt: now,
    stateTrust: "CONFIRMED",
    desiredSignals: pending.desiredSignals,
    pendingCommand: null,
    stageStartedAt: now,
    faultReason: null,
  };
  if (isAllRed(actualSignals)) {
    return {
      state: { ...observed, mode: "AUTOMATIC", stage: "ALL_RED", phase: null, stageDeadlineAt: now + config.timing.allRedMs },
      command: null,
      outcome: "APPLIED",
    };
  }
  const greenPhase = phaseForColor(actualSignals, "GREEN", config);
  if (greenPhase !== null) {
    return {
      state: {
        ...observed,
        mode: "AUTOMATIC",
        stage: greenStage(greenPhase),
        phase: greenPhase,
        targetPhase: greenPhase,
        stageDeadlineAt: now + Math.min(config.timing.normalGreenMs, 5_000),
      },
      command: null,
      outcome: "APPLIED",
    };
  }
  const yellowPhase = phaseForColor(actualSignals, "YELLOW", config);
  if (yellowPhase !== null) {
    return {
      state: {
        ...observed,
        stage: yellowStage(yellowPhase),
        phase: yellowPhase,
        stageDeadlineAt: now + config.timing.yellowMs,
      },
      command: null,
      outcome: "APPLIED",
    };
  }
  return lockout(observed, "Acknowledged signal vector is not a recognized safe state");
}

export function advanceTime(
  state: TrafficState,
  commandId: string,
  now: number,
  config: JunctionConfig,
): EngineResult {
  if (state.stage === "FAULT_LOCKOUT" || state.pendingCommand !== null) {
    return { state, command: null, outcome: "NO_OP" };
  }
  if (state.stateTrust !== "CONFIRMED" || state.stageDeadlineAt === null || now < state.stageDeadlineAt) {
    return { state, command: null, outcome: "NO_OP" };
  }
  if (isYellowStage(state.stage)) {
    return issueCommand({ ...state, stageDeadlineAt: null }, allRedSignals(), commandId, now);
  }
  if (state.stage === "ALL_RED" && state.targetPhase !== null) {
    return issueCommand({ ...state, stageDeadlineAt: null }, greenSignals(state.targetPhase, config), commandId, now);
  }
  return {
    state: { ...state, stageDeadlineAt: null, stageStartedAt: now },
    command: null,
    outcome: "APPLIED",
  };
}

export function markUnknown(state: TrafficState, reason: string): TrafficState {
  return {
    ...state,
    mode: "DEGRADED",
    stage: "FAULT_LOCKOUT",
    stateTrust: "UNKNOWN",
    actualSignals: null,
    actualObservedAt: null,
    stageDeadlineAt: null,
    pendingCommand: null,
    version: state.version + 1,
    faultReason: reason,
  };
}

function issueCommand(
  state: TrafficState,
  desiredSignals: SignalVector,
  commandId: string,
  now: number,
): EngineResult {
  const runtimeVersion = state.version + 1;
  const command: SignalCommand = { commandId, desiredSignals, runtimeVersion };
  const next = {
    ...state,
    desiredSignals,
    pendingCommand: command,
    version: runtimeVersion,
    stageStartedAt: now,
    stageDeadlineAt: null,
  };
  return { state: next, command, outcome: "APPLIED" };
}

function lockout(state: TrafficState, reason: string): EngineResult {
  const next: TrafficState = {
    ...state,
    mode: "DEGRADED",
    stage: "FAULT_LOCKOUT",
    stateTrust: state.stateTrust === "MISMATCH" ? "MISMATCH" : "UNKNOWN",
    stageDeadlineAt: null,
    pendingCommand: null,
    version: state.version + 1,
    faultReason: reason,
  };
  return { state: next, command: null, outcome: "LOCKED" };
}

function isGreenStage(stage: RuntimeStage): boolean {
  return stage === "NORTH_SOUTH_GREEN" || stage === "EAST_WEST_GREEN";
}

function isYellowStage(stage: RuntimeStage): boolean {
  return stage === "NORTH_SOUTH_YELLOW" || stage === "EAST_WEST_YELLOW";
}

function greenStage(phase: Phase): RuntimeStage {
  return phase === "NORTH_SOUTH" ? "NORTH_SOUTH_GREEN" : "EAST_WEST_GREEN";
}

function yellowStage(phase: Phase): RuntimeStage {
  return phase === "NORTH_SOUTH" ? "NORTH_SOUTH_YELLOW" : "EAST_WEST_YELLOW";
}

function phaseForSignals(signals: SignalVector, config: JunctionConfig): Phase | null {
  const green = phaseForColor(signals, "GREEN", config);
  if (green !== null) return green;
  return phaseForColor(signals, "YELLOW", config);
}

function phaseForColor(signals: SignalVector, color: "GREEN" | "YELLOW", config: JunctionConfig): Phase | null {
  for (const phase of PHASES) {
    const active = config.phases[phase].every((direction) => signals[direction] === color);
    const other = phase === "NORTH_SOUTH" ? "EAST_WEST" : "NORTH_SOUTH";
    const inactive = config.phases[other].every((direction) => signals[direction] === "RED");
    if (active && inactive) return phase;
  }
  return null;
}

function isAllRed(signals: SignalVector): boolean {
  return Object.values(signals).every((color) => color === "RED");
}

function sameSignals(left: SignalVector, right: SignalVector): boolean {
  return left.NORTH === right.NORTH
    && left.SOUTH === right.SOUTH
    && left.EAST === right.EAST
    && left.WEST === right.WEST;
}
