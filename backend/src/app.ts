import express, { type Request, type Response } from "express";
import { PrismaClient } from "@prisma/client";
import { ZodError, z } from "zod";
import { ControllerEventService } from "./application/controllerEventService.js";
import { PerJunctionSerialProcessor } from "./application/perJunctionSerialProcessor.js";
import { SensorEventService } from "./application/sensorEventService.js";
import { allRedSignals, DEFAULT_JUNCTION_CONFIG, DIRECTIONS, phaseForDirection, type Direction } from "./domain/traffic/types.js";
import { buildPhaseQueues, chooseAutomaticPhase, chooseEmergencyPhase, isDirection } from "./domain/traffic/schedulingPolicy.js";
import { SimulatorAdapter } from "./infrastructure/controllers/simulatorAdapter.js";
import { ControllerScheduler } from "./infrastructure/scheduler/controllerScheduler.js";

type JsonRequest = Request<Record<string, string>, unknown, unknown>;

const ManualCommandSchema = z.discriminatedUnion("command_type", [
  z.object({ command_type: z.literal("MANUAL_GREEN_REQUEST"), direction: z.enum(["NORTH", "SOUTH", "EAST", "WEST"]) }).strict(),
  z.object({ command_type: z.literal("RETURN_TO_AUTOMATIC") }).strict(),
]);
const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
}).strict();
const JunctionCreateSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
}).strict();

interface StatusAlert {
  code: string;
  severity: "WARNING" | "CRITICAL";
  message: string;
}

export function createApplication(prisma: PrismaClient) {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  const serialProcessor = new PerJunctionSerialProcessor();
  const sensorEventService = new SensorEventService(prisma, serialProcessor);
  const controllerEventService = new ControllerEventService(prisma, serialProcessor);
  const simulator = new SimulatorAdapter(prisma, controllerEventService);
  const scheduler = new ControllerScheduler(prisma, controllerEventService, simulator);

  app.get("/api/health", async (_request: Request, response: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      response.json({ status: "ok", database: "connected" });
    } catch {
      response.status(503).json({ status: "unavailable", database: "disconnected" });
    }
  });

  app.get("/api/junctions", async (_request: Request, response: Response) => {
    try {
      const junctions = await prisma.junction.findMany({
        select: { id: true, config: true, createdAt: true },
        orderBy: { id: "asc" },
      });
      response.json({ junctions });
    } catch {
      response.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Junction status is unavailable" } });
    }
  });

  app.get("/api/junctions/:id", async (request: Request, response: Response) => {
    try {
      const junction = await prisma.junction.findUnique({
        where: { id: getRouteId(request.params.id) },
        select: { id: true, config: true, createdAt: true },
      });
      if (junction === null) {
        response.status(404).json({ error: { code: "JUNCTION_NOT_FOUND", message: "Junction was not found" } });
        return;
      }
      response.json({ junction_id: junction.id, config: junction.config, created_at: junction.createdAt });
    } catch {
      response.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Junction details are unavailable" } });
    }
  });

  app.post("/api/junctions", async (request: JsonRequest, response: Response) => {
    const parsed = JunctionCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "INVALID_JUNCTION", message: "Junction payload is invalid", details: parsed.error.issues } });
      return;
    }
    const { id } = parsed.data;
    const config = {
      directions: [...DEFAULT_JUNCTION_CONFIG.directions],
      phases: {
        NORTH_SOUTH: [...DEFAULT_JUNCTION_CONFIG.phases.NORTH_SOUTH],
        EAST_WEST: [...DEFAULT_JUNCTION_CONFIG.phases.EAST_WEST],
      },
      timing: {
        normalGreenSeconds: DEFAULT_JUNCTION_CONFIG.timing.normalGreenMs / 1_000,
        minimumGreenSeconds: DEFAULT_JUNCTION_CONFIG.timing.minimumGreenMs / 1_000,
        yellowSeconds: DEFAULT_JUNCTION_CONFIG.timing.yellowMs / 1_000,
        allRedSeconds: DEFAULT_JUNCTION_CONFIG.timing.allRedMs / 1_000,
        ackTimeoutSeconds: DEFAULT_JUNCTION_CONFIG.timing.ackTimeoutMs / 1_000,
      },
    };
    try {
      await prisma.$transaction(async (transaction) => {
        await transaction.junction.create({
          data: {
            id,
            config,
            runtime: { create: { mode: "DEGRADED", stage: "STARTUP_RECONCILIATION", desiredSignals: allRedSignals(), stateTrust: "UNKNOWN" } },
            simulatorState: { create: { actualSignals: allRedSignals(), health: "ONLINE", automaticAck: true, ackDelayMs: 0, nextAckBehavior: "NORMAL" } },
          },
        });
        await transaction.auditEvent.create({ data: { junctionId: id, kind: "JUNCTION_CREATED", payload: { junction_id: id } } });
      });
    } catch (error: unknown) {
      if (isPrismaUniqueConstraintError(error)) {
        response.status(409).json({ error: { code: "JUNCTION_ALREADY_EXISTS", message: "Junction ID already exists" } });
        return;
      }
      response.status(503).json({ error: { code: "JUNCTION_CREATE_FAILED", message: "Junction could not be created" } });
      return;
    }
    let controllerSync: "CONFIRMED" | "PENDING" = "CONFIRMED";
    try {
      await simulator.requestSnapshot(id);
    } catch {
      controllerSync = "PENDING";
    }
    response.status(201).json({ junction_id: id, config, controller_sync: controllerSync });
  });

  app.post("/api/sensor-events", async (request: JsonRequest, response: Response) => {
    try {
      const event = SensorEventService.parse(request.body);
      const result = await sensorEventService.process(event);
      if (result.httpStatus === 201) {
        const command = await controllerEventService.reevaluatePolicy(event.junction_id);
        if (command !== null) await simulator.dispatch(command, event.junction_id);
      }
      response.status(result.httpStatus).json(result.body);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        response.status(400).json({
          error: {
            code: "INVALID_SENSOR_EVENT",
            message: "Sensor event payload is invalid",
            details: error.issues,
          },
        });
        return;
      }
      response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Sensor event could not be processed" } });
    }
  });

  app.post("/api/junctions/:id/commands", async (request: JsonRequest, response: Response) => {
    try {
      const commandRequest = ManualCommandSchema.parse(request.body);
      const junctionId = getRouteId(request.params.id);
      const junction = await prisma.junction.findUnique({ where: { id: junctionId }, select: { id: true } });
      if (junction === null) {
        response.status(404).json({ error: { code: "JUNCTION_NOT_FOUND", message: "Junction was not found" } });
        return;
      }
      const command = commandRequest.command_type === "MANUAL_GREEN_REQUEST"
        ? await controllerEventService.requestIntent(
          junctionId,
          phaseForDirection(commandRequest.direction),
          "MANUAL",
        )
        : await controllerEventService.requestIntent(junctionId, null, "AUTOMATIC");
      if (command !== null) await simulator.dispatch(command, junctionId);
      response.status(202).json({ accepted: true, command_id: command?.commandId ?? null });
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        response.status(400).json({ error: { code: "INVALID_COMMAND", message: "Command payload is invalid", details: error.issues } });
        return;
      }
      response.status(500).json({ error: { code: "COMMAND_FAILED", message: "Command could not be processed" } });
    }
  });

  app.post("/api/controller-events", async (request: JsonRequest, response: Response) => {
    try {
      const event = ControllerEventService.parse(request.body);
      const result = await controllerEventService.process(event);
      if (result.dispatchCommand !== null) await simulator.dispatch(result.dispatchCommand, event.junction_id);
      if (result.httpStatus === 202 && event.event_type === "DEVICE_STATUS" && event.status === "ONLINE"
        && (event.device_type === "CONTROLLER" || event.device_type === "SIGNAL_CONTROLLER")) {
        await simulator.requestSnapshot(event.junction_id);
      }
      if (result.httpStatus === 202 && (event.event_type === "COMMAND_ACK" || event.event_type === "STATE_SNAPSHOT")) {
        const policyCommand = await controllerEventService.reevaluatePolicy(event.junction_id);
        if (policyCommand !== null) await simulator.dispatch(policyCommand, event.junction_id);
      }
      response.status(result.httpStatus).json(result.body);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        response.status(400).json({
          error: {
            code: "INVALID_CONTROLLER_EVENT",
            message: "Controller event payload is invalid",
            details: error.issues,
          },
        });
        return;
      }
      response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Controller event could not be processed" } });
    }
  });

  app.get("/api/simulators/:id", async (request: Request, response: Response) => {
    try {
      const simulatorState = await prisma.controllerSimulatorState.findUnique({ where: { junctionId: getRouteId(request.params.id) } });
      if (simulatorState === null) {
        response.status(404).json({ error: { code: "SIMULATOR_NOT_FOUND", message: "Controller simulator was not found" } });
        return;
      }
      response.json({
        junction_id: simulatorState.junctionId,
        health: simulatorState.health,
        automatic_ack: simulatorState.automaticAck,
        ack_delay_ms: simulatorState.ackDelayMs,
        next_ack_behavior: simulatorState.nextAckBehavior,
        actual_signals: simulatorState.actualSignals,
      });
    } catch {
      response.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Simulator state is unavailable" } });
    }
  });

  app.patch("/api/simulators/:id", async (request: JsonRequest, response: Response) => {
    try {
      const result = await simulator.configure(getRouteId(request.params.id), request.body);
      response.status(result.status).json(result.body);
    } catch {
      response.status(503).json({ error: { code: "SIMULATOR_UNAVAILABLE", message: "Simulator settings could not be updated" } });
    }
  });

  app.get("/api/junctions/:id/history", async (request: Request, response: Response) => {
    const parsedQuery = HistoryQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      response.status(400).json({ error: { code: "INVALID_HISTORY_QUERY", message: "History query is invalid", details: parsedQuery.error.issues } });
      return;
    }
    try {
      const junctionId = getRouteId(request.params.id);
      const junction = await prisma.junction.findUnique({ where: { id: junctionId }, select: { id: true } });
      if (junction === null) {
        response.status(404).json({ error: { code: "JUNCTION_NOT_FOUND", message: "Junction was not found" } });
        return;
      }
      const cursor = parsedQuery.data.cursor === undefined ? null : await prisma.auditEvent.findFirst({
        where: { id: parsedQuery.data.cursor, junctionId },
        select: { id: true },
      });
      if (parsedQuery.data.cursor !== undefined && cursor === null) {
        response.status(400).json({ error: { code: "INVALID_HISTORY_CURSOR", message: "History cursor was not found for this junction" } });
        return;
      }
      const rows = await prisma.auditEvent.findMany({
        where: { junctionId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: parsedQuery.data.limit + 1,
        ...(cursor === null ? {} : { cursor: { id: cursor.id }, skip: 1 }),
      });
      const hasMore = rows.length > parsedQuery.data.limit;
      const events = rows.slice(0, parsedQuery.data.limit);
      response.json({
        events: events.map((event) => ({
          id: event.id,
          kind: event.kind,
          correlation_id: event.correlationId,
          occurred_at: event.occurredAt,
          payload: event.payload,
        })),
        next_cursor: hasMore ? events.at(-1)?.id ?? null : null,
      });
    } catch {
      response.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Junction history is unavailable" } });
    }
  });

  app.get("/api/junctions/:id/status", async (request: Request, response: Response) => {
    const junctionId = getRouteId(request.params.id);
    try {
      const junction = await prisma.junction.findUnique({
        where: { id: junctionId },
        include: { runtime: true },
      });
      if (junction === null || junction.runtime === null) {
        response.status(404).json({ error: { code: "JUNCTION_NOT_FOUND", message: "Junction was not found" } });
        return;
      }

      const [queueCounts, waitingRows, directionCursors, pendingCommand, deviceStatuses, lastFailedCommand] = await Promise.all([
        Promise.all(DIRECTIONS.map(async (direction): Promise<[Direction, number]> => {
          const count = await prisma.vehicle.count({
            where: { junctionId, direction, status: "WAITING" },
          });
          return [direction, count];
        })),
        prisma.vehicle.findMany({
          where: { junctionId, status: "WAITING" },
          select: { direction: true, type: true, arrivedAtServer: true, vehicleId: true, arrivalEventId: true },
        }),
        prisma.directionCursor.findMany({ where: { junctionId }, select: { direction: true, lastSequence: true } }),
        prisma.controllerCommand.findFirst({
          where: { junctionId, status: { in: ["PENDING", "SENT"] } },
          orderBy: { createdAt: "desc" },
          select: { commandId: true, status: true, desiredSignals: true, attempts: true, deadlineAt: true },
        }),
        prisma.deviceStatus.findMany({ where: { junctionId }, orderBy: [{ deviceType: "asc" }, { direction: "asc" }] }),
        prisma.controllerCommand.findFirst({
          where: { junctionId, status: { in: ["TIMED_OUT", "FAILED"] } },
          orderBy: { createdAt: "desc" },
          select: { commandId: true, status: true },
        }),
      ]);
      const waitingVehicles = waitingRows.flatMap((vehicle) => isDirection(vehicle.direction)
        ? [{ direction: vehicle.direction, type: vehicle.type, arrivedAtServer: vehicle.arrivedAtServer, vehicleId: vehicle.vehicleId, eventId: vehicle.arrivalEventId }]
        : []);
      const sequenceCursors: Record<Direction, number> = { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 };
      for (const cursor of directionCursors) {
        if (isDirection(cursor.direction)) sequenceCursors[cursor.direction] = cursor.lastSequence;
      }
      const phaseQueues = buildPhaseQueues(waitingVehicles.filter((vehicle) => vehicle.type !== "EMERGENCY"), Date.now());
      const emergencyPhase = chooseEmergencyPhase(waitingVehicles);
      const manualLeaseIsActive = junction.runtime.manualExpiresAt !== null
        && junction.runtime.manualExpiresAt.getTime() > Date.now();
      const nextPhase = emergencyPhase
        ?? (manualLeaseIsActive ? junction.runtime.manualPhase : chooseAutomaticPhase(phaseQueues, junction.runtime.phase));
      const now = Date.now();
      const alerts: StatusAlert[] = [];
      if (junction.runtime.stage === "FAULT_LOCKOUT") {
        alerts.push({ code: "FAULT_LOCKOUT", severity: "CRITICAL", message: junction.runtime.faultReason ?? "Controller state is locked out" });
      }
      if (junction.runtime.controllerHealth === "OFFLINE") {
        alerts.push({ code: "CONTROLLER_OFFLINE", severity: "CRITICAL", message: "Controller is offline; signal state is not confirmed" });
      }
      if (junction.runtime.actualSignals === null || junction.runtime.stateTrust === "UNKNOWN") {
        alerts.push({ code: "PHYSICAL_STATE_UNKNOWN", severity: "CRITICAL", message: "The actual signal state has not been confirmed by the controller" });
      }
      if (junction.runtime.stateTrust === "STALE") {
        alerts.push({ code: "CONTROLLER_REPORT_STALE", severity: "WARNING", message: "The last controller report is stale" });
      }
      if (junction.runtime.stateTrust === "MISMATCH") {
        alerts.push({ code: "DESIRED_ACTUAL_MISMATCH", severity: "CRITICAL", message: "Controller-reported signals do not match the requested safe state" });
      }
      if (lastFailedCommand !== null && junction.runtime.stage === "FAULT_LOCKOUT") {
        alerts.push({
          code: lastFailedCommand.status === "TIMED_OUT" ? "COMMAND_TIMEOUT" : "COMMAND_FAILED",
          severity: "CRITICAL",
          message: `Controller command ${lastFailedCommand.commandId} ${lastFailedCommand.status.toLowerCase()}`,
        });
      }
      for (const device of deviceStatuses) {
        if (device.health !== "OFFLINE" || device.deviceType === "CONTROLLER") continue;
        const label = device.deviceType === "SIGNAL_CONTROLLER" ? `Signal ${device.direction ?? "device"}` : device.deviceType.toLowerCase();
        alerts.push({
          code: device.deviceType === "SIGNAL_CONTROLLER" ? "SIGNAL_OFFLINE" : `${device.deviceType}_OFFLINE`,
          severity: "CRITICAL",
          message: `${label} is offline`,
        });
      }
      for (const vehicle of waitingVehicles) {
        if (vehicle.type === "EMERGENCY" && now - vehicle.arrivedAtServer.getTime() >= 60_000) {
          alerts.push({ code: "EMERGENCY_STALE", severity: "CRITICAL", message: `Emergency vehicle ${vehicle.vehicleId} has waited over 60 seconds` });
        }
      }
      for (const [phase, queue] of Object.entries(phaseQueues)) {
        if (queue.count > 0 && queue.oldestWaitMs >= 90_000) {
          alerts.push({ code: "NORMAL_TRAFFIC_STARVATION", severity: "WARNING", message: `${phase.replace("_", "/")} queue has waited over 90 seconds` });
        }
      }

      response.json({
        junction_id: junctionId,
        mode: junction.runtime.mode,
        stage: junction.runtime.stage,
        phase: junction.runtime.phase,
        target_phase: junction.runtime.targetPhase,
        manual_phase: junction.runtime.manualPhase,
        intent_revision: junction.runtime.intentRevision,
        version: junction.runtime.version,
        desired_signals: junction.runtime.desiredSignals,
        actual_signals: junction.runtime.actualSignals,
        physical_state_trust: junction.runtime.stateTrust,
        actual_observed_at: junction.runtime.actualObservedAt,
        stage_started_at: junction.runtime.stageStartedAt,
        stage_deadline_at: junction.runtime.stageDeadlineAt,
        manual_lease_expires_at: junction.runtime.manualExpiresAt,
        fault_reason: junction.runtime.faultReason,
        controller_status: junction.runtime.controllerHealth,
        device_statuses: deviceStatuses.map((device) => ({
          device_type: device.deviceType,
          direction: device.direction,
          health: device.health,
          issue_code: device.issueCode,
          last_seen_at: device.lastSeenAt,
        })),
        emergency_vehicles: waitingVehicles
          .filter((vehicle) => vehicle.type === "EMERGENCY")
          .map((vehicle) => ({
            vehicle_id: vehicle.vehicleId,
            direction: vehicle.direction,
            wait_ms: Math.max(0, now - vehicle.arrivedAtServer.getTime()),
          })),
        pending_command: pendingCommand === null ? null : {
          command_id: pendingCommand.commandId,
          status: pendingCommand.status,
          desired_signals: pendingCommand.desiredSignals,
          attempts: pendingCommand.attempts,
          deadline_at: pendingCommand.deadlineAt,
        },
        queues: Object.fromEntries(queueCounts),
        sequence_cursors: sequenceCursors,
        phase_policy: {
          weights: { EMPLOYEE_VEHICLE: 1, FORKLIFT: 2, TRUCK: 4 },
          phases: phaseQueues,
          emergency_phase: emergencyPhase,
          next_phase: nextPhase,
        },
        alerts,
      });
    } catch {
      response.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Junction status is unavailable" } });
    }
  });

  return { app, controllerScheduler: scheduler };
}

export function createApp(prisma: PrismaClient) {
  return createApplication(prisma).app;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function getRouteId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
