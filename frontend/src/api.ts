import type { Direction, HistoryResponse, JunctionStatus, SimulatorStatus, VehicleType } from "./types";
import { z } from "zod";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
const SignalVectorSchema = z.object({
  NORTH: z.enum(["RED", "YELLOW", "GREEN"]),
  SOUTH: z.enum(["RED", "YELLOW", "GREEN"]),
  EAST: z.enum(["RED", "YELLOW", "GREEN"]),
  WEST: z.enum(["RED", "YELLOW", "GREEN"]),
});
const DirectionSchema = z.enum(["NORTH", "SOUTH", "EAST", "WEST"]);
const PhaseSchema = z.enum(["NORTH_SOUTH", "EAST_WEST"]);
const QueueScoreSchema = z.object({ count: z.number(), weightedScore: z.number(), oldestWaitMs: z.number() });
const JunctionStatusSchema = z.object({
  junction_id: z.string(),
  mode: z.enum(["AUTOMATIC", "MANUAL", "EMERGENCY", "DEGRADED"]),
  stage: z.string(),
  phase: PhaseSchema.nullable(),
  target_phase: PhaseSchema.nullable(),
  manual_phase: PhaseSchema.nullable(),
  intent_revision: z.number(),
  version: z.number(),
  desired_signals: SignalVectorSchema,
  actual_signals: SignalVectorSchema.nullable(),
  physical_state_trust: z.enum(["CONFIRMED", "STALE", "UNKNOWN", "MISMATCH"]),
  actual_observed_at: z.string().nullable(),
  stage_started_at: z.string().nullable(),
  stage_deadline_at: z.string().nullable(),
  manual_lease_expires_at: z.string().nullable(),
  fault_reason: z.string().nullable(),
  controller_status: z.enum(["ONLINE", "OFFLINE", "UNKNOWN"]),
  device_statuses: z.array(z.object({
    device_type: z.enum(["CONTROLLER", "SENSOR", "SIGNAL_CONTROLLER"]),
    direction: DirectionSchema.nullable(),
    health: z.enum(["ONLINE", "OFFLINE", "UNKNOWN"]),
    issue_code: z.string().nullable(),
    last_seen_at: z.string().nullable(),
  })),
  emergency_vehicles: z.array(z.object({ vehicle_id: z.string(), direction: DirectionSchema, wait_ms: z.number() })),
  pending_command: z.object({
    command_id: z.string(),
    status: z.string(),
    desired_signals: SignalVectorSchema,
    attempts: z.number(),
    deadline_at: z.string().nullable(),
  }).nullable(),
  queues: z.record(DirectionSchema, z.number()),
  sequence_cursors: z.record(DirectionSchema, z.number()),
  phase_policy: z.object({
    weights: z.record(z.string(), z.number()),
    phases: z.record(PhaseSchema, QueueScoreSchema),
    emergency_phase: PhaseSchema.nullable(),
    next_phase: PhaseSchema.nullable(),
  }),
  alerts: z.array(z.object({ code: z.string(), severity: z.enum(["WARNING", "CRITICAL"]), message: z.string() })),
});
const SimulatorStatusSchema = z.object({
  junction_id: z.string(),
  health: z.enum(["ONLINE", "OFFLINE"]),
  automatic_ack: z.boolean(),
  ack_delay_ms: z.number(),
  next_ack_behavior: z.enum(["NORMAL", "DROP", "DUPLICATE", "MISMATCH"]),
  actual_signals: SignalVectorSchema,
});
const HistoryResponseSchema = z.object({
  events: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    correlation_id: z.string().nullable(),
    occurred_at: z.string(),
    payload: z.unknown(),
  })),
  next_cursor: z.string().nullable(),
});
const SensorEventResponseSchema = z.union([
  z.object({ accepted: z.literal(true), duplicate: z.literal(false), event_id: z.string(), queue_count: z.number() }),
  z.object({ accepted: z.literal(false), duplicate: z.literal(true), event_id: z.string() }),
]);
const ManualCommandResponseSchema = z.object({ accepted: z.boolean(), command_id: z.string().nullable() });

async function requestJson<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = getErrorMessage(body) ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return schema.parse(body);
}

function getErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = body.error;
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  return typeof error.message === "string" ? error.message : null;
}

export function getJunctionStatus(junctionId: string): Promise<JunctionStatus> {
  return requestJson(`/junctions/${encodeURIComponent(junctionId)}/status`, JunctionStatusSchema);
}

export function getJunctionHistory(junctionId: string): Promise<HistoryResponse> {
  return requestJson(`/junctions/${encodeURIComponent(junctionId)}/history?limit=30`, HistoryResponseSchema);
}

export function getSimulatorStatus(junctionId: string): Promise<SimulatorStatus> {
  return requestJson(`/simulators/${encodeURIComponent(junctionId)}`, SimulatorStatusSchema);
}

export function submitSensorEvent(input: {
  direction: Direction;
  eventType: "VEHICLE_ARRIVED" | "VEHICLE_CLEARED";
  vehicleId: string;
  vehicleType: VehicleType;
  sequenceNo: number;
}) {
  const base = {
    event_id: crypto.randomUUID(),
    junction_id: "A",
    direction: input.direction,
    sequence_no: input.sequenceNo,
    timestamp: new Date().toISOString(),
    event_type: input.eventType,
    vehicle_id: input.vehicleId,
  };
  const payload = input.eventType === "VEHICLE_ARRIVED"
    ? { ...base, vehicle_type: input.vehicleType }
    : base;
  return requestJson("/sensor-events", SensorEventResponseSchema, { method: "POST", body: JSON.stringify(payload) });
}

export type ManualCommandInput =
  | { command_type: "MANUAL_GREEN_REQUEST"; direction: Direction }
  | { command_type: "RETURN_TO_AUTOMATIC" };

export function submitManualCommand(input: ManualCommandInput) {
  const body = input;
  return requestJson("/junctions/A/commands", ManualCommandResponseSchema, { method: "POST", body: JSON.stringify(body) });
}

export function updateSimulator(input: {
  health?: SimulatorStatus["health"];
  automatic_ack?: boolean;
  ack_delay_ms?: number;
  next_ack_behavior?: SimulatorStatus["next_ack_behavior"];
}): Promise<SimulatorStatus> {
  return requestJson("/simulators/A", SimulatorStatusSchema, { method: "PATCH", body: JSON.stringify(input) });
}

export async function submitDeviceStatus(input: {
  junctionId: string;
  deviceType: "SENSOR" | "SIGNAL_CONTROLLER";
  direction?: Direction;
  status: "ONLINE" | "OFFLINE";
}) {
  return requestJson("/controller-events", z.object({ accepted: z.boolean() }), {
    method: "POST",
    body: JSON.stringify({
      event_id: crypto.randomUUID(),
      junction_id: input.junctionId,
      event_type: "DEVICE_STATUS",
      device_type: input.deviceType,
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      status: input.status,
      timestamp: new Date().toISOString(),
    }),
  });
}
