import { DIRECTIONS, PHASES, phaseForDirection, type Direction, type Phase } from "./types.js";

export interface WaitingVehicle {
  direction: Direction;
  type: "EMERGENCY" | "TRUCK" | "FORKLIFT" | "EMPLOYEE_VEHICLE";
  arrivedAtServer: Date;
  vehicleId: string;
  eventId: string;
}

export interface PhaseQueue {
  count: number;
  weightedScore: number;
  oldestWaitMs: number;
}

const VEHICLE_WEIGHTS: Record<WaitingVehicle["type"], number> = {
  EMPLOYEE_VEHICLE: 1,
  FORKLIFT: 2,
  TRUCK: 4,
  EMERGENCY: 0,
};

export function buildPhaseQueues(vehicles: readonly WaitingVehicle[], now: number): Record<Phase, PhaseQueue> {
  const queues: Record<Phase, PhaseQueue> = {
    NORTH_SOUTH: { count: 0, weightedScore: 0, oldestWaitMs: 0 },
    EAST_WEST: { count: 0, weightedScore: 0, oldestWaitMs: 0 },
  };
  for (const vehicle of vehicles) {
    const phase = phaseForDirection(vehicle.direction);
    const wait = Math.max(0, now - vehicle.arrivedAtServer.getTime());
    const queue = queues[phase];
    queue.count += 1;
    queue.weightedScore += VEHICLE_WEIGHTS[vehicle.type];
    queue.oldestWaitMs = Math.max(queue.oldestWaitMs, wait);
  }
  for (const phase of PHASES) {
    const queue = queues[phase];
    queue.weightedScore += Math.min(Math.floor(queue.oldestWaitMs / 15_000), 8);
  }
  return queues;
}

export function chooseEmergencyPhase(vehicles: readonly WaitingVehicle[]): Phase | null {
  const emergencies = vehicles
    .filter((vehicle) => vehicle.type === "EMERGENCY")
    .sort((left, right) => left.arrivedAtServer.getTime() - right.arrivedAtServer.getTime()
      || left.eventId.localeCompare(right.eventId)
      || PHASES.indexOf(phaseForDirection(left.direction)) - PHASES.indexOf(phaseForDirection(right.direction)));
  const earliest = emergencies[0];
  return earliest === undefined ? null : phaseForDirection(earliest.direction);
}

export function isDirection(value: string): value is Direction {
  return DIRECTIONS.some((direction) => direction === value);
}

export function chooseAutomaticPhase(
  queues: Record<Phase, PhaseQueue>,
  currentPhase: Phase | null,
): Phase | null {
  const northSouth = queues.NORTH_SOUTH;
  const eastWest = queues.EAST_WEST;
  const starved = PHASES.filter((phase) => queues[phase].count > 0 && queues[phase].oldestWaitMs >= 90_000);
  if (starved.length === 1) return starved[0] ?? null;
  if (starved.length === 2) {
    if (northSouth.oldestWaitMs !== eastWest.oldestWaitMs) {
      return northSouth.oldestWaitMs > eastWest.oldestWaitMs ? "NORTH_SOUTH" : "EAST_WEST";
    }
    return "NORTH_SOUTH";
  }
  if (northSouth.count === 0 && eastWest.count === 0) return null;
  if (northSouth.weightedScore === eastWest.weightedScore) {
    return currentPhase ?? (northSouth.count > 0 ? "NORTH_SOUTH" : "EAST_WEST");
  }
  return northSouth.weightedScore > eastWest.weightedScore ? "NORTH_SOUTH" : "EAST_WEST";
}
