export type Direction = "NORTH" | "SOUTH" | "EAST" | "WEST";
export type Phase = "NORTH_SOUTH" | "EAST_WEST";
export type SignalColor = "RED" | "YELLOW" | "GREEN";
export type VehicleType = "EMPLOYEE_VEHICLE" | "FORKLIFT" | "TRUCK" | "EMERGENCY";

export interface SignalVector {
  NORTH: SignalColor;
  SOUTH: SignalColor;
  EAST: SignalColor;
  WEST: SignalColor;
}

export interface QueueScore {
  count: number;
  weightedScore: number;
  oldestWaitMs: number;
}

export interface StatusAlert {
  code: string;
  severity: "WARNING" | "CRITICAL";
  message: string;
}

export interface JunctionStatus {
  junction_id: string;
  mode: "AUTOMATIC" | "MANUAL" | "EMERGENCY" | "DEGRADED";
  stage: string;
  phase: Phase | null;
  target_phase: Phase | null;
  manual_phase: Phase | null;
  intent_revision: number;
  version: number;
  desired_signals: SignalVector;
  actual_signals: SignalVector | null;
  physical_state_trust: "CONFIRMED" | "STALE" | "UNKNOWN" | "MISMATCH";
  actual_observed_at: string | null;
  stage_started_at: string | null;
  stage_deadline_at: string | null;
  manual_lease_expires_at: string | null;
  fault_reason: string | null;
  controller_status: "ONLINE" | "OFFLINE" | "UNKNOWN";
  pending_command: null | {
    command_id: string;
    status: string;
    desired_signals: SignalVector;
    attempts: number;
    deadline_at: string | null;
  };
  queues: Record<Direction, number>;
  sequence_cursors: Record<Direction, number>;
  phase_policy: {
    weights: Record<string, number>;
    phases: Record<Phase, QueueScore>;
    emergency_phase: Phase | null;
    next_phase: Phase | null;
  };
  alerts: StatusAlert[];
}

export interface SimulatorStatus {
  junction_id: string;
  health: "ONLINE" | "OFFLINE";
  automatic_ack: boolean;
  ack_delay_ms: number;
  next_ack_behavior: "NORMAL" | "DROP" | "DUPLICATE" | "MISMATCH";
  actual_signals: SignalVector;
}

export interface HistoryEvent {
  id: string;
  kind: string;
  correlation_id: string | null;
  occurred_at: string;
  payload: unknown;
}

export interface HistoryResponse {
  events: HistoryEvent[];
  next_cursor: string | null;
}
