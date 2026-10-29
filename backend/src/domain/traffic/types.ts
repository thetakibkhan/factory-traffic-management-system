export type Direction = "NORTH" | "SOUTH" | "EAST" | "WEST";
export const DIRECTIONS: readonly Direction[] = ["NORTH", "SOUTH", "EAST", "WEST"];

export type Phase = "NORTH_SOUTH" | "EAST_WEST";
export const PHASES: readonly Phase[] = ["NORTH_SOUTH", "EAST_WEST"];
export type SignalColor = "RED" | "YELLOW" | "GREEN";
export type SignalVector = Record<Direction, SignalColor>;
export type RuntimeMode = "AUTOMATIC" | "MANUAL" | "EMERGENCY" | "DEGRADED";
export type RuntimeStage =
  | "STARTUP_RECONCILIATION"
  | "ALL_RED"
  | "NORTH_SOUTH_GREEN"
  | "NORTH_SOUTH_YELLOW"
  | "EAST_WEST_GREEN"
  | "EAST_WEST_YELLOW"
  | "FAULT_LOCKOUT";
export type StateTrust = "CONFIRMED" | "STALE" | "UNKNOWN" | "MISMATCH";

export interface TimingConfig {
  normalGreenMs: number;
  minimumGreenMs: number;
  yellowMs: number;
  allRedMs: number;
  ackTimeoutMs: number;
}

export interface JunctionConfig {
  id: string;
  directions: readonly Direction[];
  phases: Readonly<Record<Phase, readonly Direction[]>>;
  timing: TimingConfig;
}

export interface SignalCommand {
  commandId: string;
  desiredSignals: SignalVector;
  runtimeVersion: number;
}

export interface TrafficState {
  mode: RuntimeMode;
  stage: RuntimeStage;
  phase: Phase | null;
  targetPhase: Phase | null;
  version: number;
  desiredSignals: SignalVector;
  actualSignals: SignalVector | null;
  stateTrust: StateTrust;
  actualObservedAt: number | null;
  stageStartedAt: number | null;
  stageDeadlineAt: number | null;
  pendingCommand: SignalCommand | null;
  faultReason: string | null;
}

export type EngineResult =
  | { state: TrafficState; command: SignalCommand | null; outcome: "APPLIED" | "NO_OP" | "LOCKED" };

export const DEFAULT_JUNCTION_CONFIG: JunctionConfig = {
  id: "A",
  directions: DIRECTIONS,
  phases: {
    NORTH_SOUTH: ["NORTH", "SOUTH"],
    EAST_WEST: ["EAST", "WEST"],
  },
  timing: {
    normalGreenMs: 30_000,
    minimumGreenMs: 10_000,
    yellowMs: 5_000,
    allRedMs: 2_000,
    ackTimeoutMs: 3_000,
  },
};

export function allRedSignals(): SignalVector {
  return { NORTH: "RED", SOUTH: "RED", EAST: "RED", WEST: "RED" };
}

export function phaseForDirection(direction: Direction): Phase {
  return direction === "NORTH" || direction === "SOUTH" ? "NORTH_SOUTH" : "EAST_WEST";
}

export function greenSignals(phase: Phase, config: JunctionConfig): SignalVector {
  const signals = allRedSignals();
  for (const direction of config.phases[phase]) signals[direction] = "GREEN";
  return signals;
}

export function yellowSignals(phase: Phase, config: JunctionConfig): SignalVector {
  const signals = allRedSignals();
  for (const direction of config.phases[phase]) signals[direction] = "YELLOW";
  return signals;
}
