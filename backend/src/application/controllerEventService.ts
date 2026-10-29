import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { acknowledgeCommand, acceptControllerSnapshot, advanceTime, markUnknown, requestAllRed, requestPhase } from "../domain/traffic/engine.js";
import { buildPhaseQueues, chooseAutomaticPhase, chooseEmergencyPhase, isDirection, type WaitingVehicle } from "../domain/traffic/schedulingPolicy.js";
import {
  DEFAULT_JUNCTION_CONFIG,
  type EngineResult,
  type SignalCommand,
  type SignalVector,
  type TrafficState,
} from "../domain/traffic/types.js";
import { PerJunctionSerialProcessor } from "./perJunctionSerialProcessor.js";

const SignalColorSchema = z.enum(["RED", "YELLOW", "GREEN"]);
const SignalVectorSchema = z.object({
  NORTH: SignalColorSchema,
  SOUTH: SignalColorSchema,
  EAST: SignalColorSchema,
  WEST: SignalColorSchema,
}).strict();

const ControllerEventBaseSchema = z.object({
  event_id: z.string().trim().min(1).max(128),
  junction_id: z.string().trim().min(1).max(64),
  timestamp: z.string().datetime({ offset: true }),
});

const ControllerEventSchema = z.discriminatedUnion("event_type", [
  ControllerEventBaseSchema.extend({
    event_type: z.literal("COMMAND_ACK"),
    command_id: z.string().trim().min(1).max(128),
    actual_signals: SignalVectorSchema,
  }).strict(),
  ControllerEventBaseSchema.extend({
    event_type: z.literal("STATE_SNAPSHOT"),
    actual_signals: SignalVectorSchema,
  }).strict(),
  ControllerEventBaseSchema.extend({
    event_type: z.literal("DEVICE_STATUS"),
    device_type: z.enum(["CONTROLLER", "SENSOR", "SIGNAL_CONTROLLER"]).default("CONTROLLER"),
    direction: z.enum(["NORTH", "SOUTH", "EAST", "WEST"]).optional(),
    status: z.enum(["ONLINE", "OFFLINE"]),
  }).strict().refine((event) => event.device_type !== "SIGNAL_CONTROLLER" || event.direction !== undefined, {
    message: "Signal controller status requires a direction",
    path: ["direction"],
  }),
]);

export type ControllerEventInput = z.infer<typeof ControllerEventSchema>;

export interface ControllerEventResult {
  httpStatus: number;
  body: Record<string, unknown>;
  dispatchCommand: SignalCommand | null;
}

export class ControllerEventService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly serialProcessor: PerJunctionSerialProcessor,
  ) {}

  static parse(input: unknown): ControllerEventInput {
    return ControllerEventSchema.parse(input);
  }

  async process(input: ControllerEventInput): Promise<ControllerEventResult> {
    return this.serialProcessor.run(input.junction_id, () => this.prisma.$transaction(async (transaction) => {
      const junction = await transaction.junction.findUnique({ where: { id: input.junction_id }, select: { id: true } });
      if (junction === null) {
        return eventError(404, "JUNCTION_NOT_FOUND", "Junction was not found");
      }

      const payloadHash = hashControllerEvent(input);
      const previousEvent = await transaction.controllerEvent.findUnique({ where: { eventId: input.event_id } });
      if (previousEvent !== null) {
        if (previousEvent.payloadHash === payloadHash) {
          await transaction.auditEvent.create({
            data: {
              junctionId: input.junction_id,
              kind: "CONTROLLER_EVENT_DUPLICATE",
              correlationId: input.event_id,
              payload: { event_id: input.event_id, event_type: input.event_type },
            },
          });
          return { httpStatus: 200, body: { accepted: false, duplicate: true, event_id: input.event_id }, dispatchCommand: null };
        }
        await transaction.auditEvent.create({
          data: {
            junctionId: input.junction_id,
            kind: "CONTROLLER_EVENT_ID_CONFLICT",
            correlationId: input.event_id,
            payload: { event_id: input.event_id, event_type: input.event_type },
          },
        });
        return eventError(409, "EVENT_ID_CONFLICT", "Controller event ID was reused with a different payload");
      }

      let acknowledgedCommandStatus: "PENDING" | "SENT" | "ACKNOWLEDGED" | "TIMED_OUT" | "FAILED" | null = null;
      if (input.event_type === "COMMAND_ACK") {
        const acknowledgedCommand = await transaction.controllerCommand.findUnique({ where: { commandId: input.command_id } });
        if (acknowledgedCommand === null) return eventError(404, "COMMAND_NOT_FOUND", "Controller command was not found");
        if (acknowledgedCommand.junctionId !== input.junction_id) {
          return eventError(409, "COMMAND_JUNCTION_MISMATCH", "Controller command belongs to a different junction");
        }
        acknowledgedCommandStatus = acknowledgedCommand.status;
      }

      const runtime = await transaction.junctionRuntime.findUnique({ where: { junctionId: input.junction_id } });
      if (runtime === null) return eventError(404, "RUNTIME_NOT_FOUND", "Junction runtime was not initialized");

      const pending = await transaction.controllerCommand.findFirst({
        where: { junctionId: input.junction_id, status: { in: ["PENDING", "SENT"] } },
        orderBy: { createdAt: "desc" },
      });
      const state = toTrafficState(runtime, pending);
      const now = new Date();
      let nextState = state;
      let outcome = "RECORDED";
      let dispatchCommand: SignalCommand | null = null;

      if (input.event_type === "COMMAND_ACK") {
        const ack = acknowledgeCommand(state, input.command_id, input.actual_signals, now.getTime(), DEFAULT_JUNCTION_CONFIG);
        nextState = ack.state;
        outcome = ack.outcome;
        const matchingCommand = pending?.commandId === input.command_id;
        if (matchingCommand) {
          await transaction.controllerCommand.update({
            where: { commandId: input.command_id },
            data: {
              status: ack.state.stage === "FAULT_LOCKOUT" ? "FAILED" : "ACKNOWLEDGED",
              acknowledgedAt: now,
            },
          });
        } else if (acknowledgedCommandStatus === "SENT") {
          await transaction.controllerCommand.update({
            where: { commandId: input.command_id },
            data: { status: "ACKNOWLEDGED", acknowledgedAt: now },
          });
        }
      } else if (input.event_type === "STATE_SNAPSHOT") {
        const pendingIsCurrent = pending !== null
          && pending.runtimeVersion === state.version
          && state.stage !== "FAULT_LOCKOUT";
        if (pendingIsCurrent && pending !== null) {
          const snapshotAck = acknowledgeCommand(state, pending.commandId, input.actual_signals, now.getTime(), DEFAULT_JUNCTION_CONFIG);
          nextState = snapshotAck.state;
          outcome = snapshotAck.outcome;
          await transaction.controllerCommand.update({
            where: { commandId: pending.commandId },
            data: {
              status: snapshotAck.state.stage === "FAULT_LOCKOUT" ? "FAILED" : "ACKNOWLEDGED",
              acknowledgedAt: now,
            },
          });
        } else {
          if (pending !== null) {
            await transaction.controllerCommand.update({
              where: { commandId: pending.commandId },
              data: { status: "FAILED" },
            });
          }
          const snapshot = acceptControllerSnapshot(
            { ...state, pendingCommand: null },
            input.actual_signals,
            randomUUID(),
            now.getTime(),
            DEFAULT_JUNCTION_CONFIG,
          );
          nextState = snapshot.state;
          outcome = snapshot.outcome;
          dispatchCommand = snapshot.command;
        }
      } else if (input.device_type === "CONTROLLER" && input.status === "OFFLINE") {
        nextState = markUnknown(state, "Controller reported OFFLINE");
        outcome = "LOCKED";
      } else if (input.device_type === "SIGNAL_CONTROLLER" && input.status === "OFFLINE") {
        nextState = markUnknown(state, `Signal controller ${input.direction} reported OFFLINE`);
        outcome = "LOCKED";
      }

      const simulatorStatus = input.event_type === "DEVICE_STATUS" ? input.status : null;
      await transaction.controllerEvent.create({
        data: {
          eventId: input.event_id,
          junctionId: input.junction_id,
          commandId: input.event_type === "COMMAND_ACK" ? input.command_id : null,
          payloadHash,
          reportedSignals: input.event_type === "DEVICE_STATUS" ? Prisma.DbNull : input.actual_signals,
          status: simulatorStatus ?? outcome,
          reportedAt: new Date(input.timestamp),
          receivedAt: now,
        },
      });

      if (input.event_type === "DEVICE_STATUS") {
        await upsertDeviceStatus(transaction, input.junction_id, input.device_type, input.direction ?? null, input.status, now);
      } else {
        await upsertDeviceStatus(transaction, input.junction_id, "CONTROLLER", null, "ONLINE", now);
      }

      const updateResult = await transaction.junctionRuntime.updateMany({
        where: { junctionId: input.junction_id, version: runtime.version },
        data: {
          mode: nextState.mode,
          stage: nextState.stage,
          phase: nextState.phase,
          targetPhase: nextState.targetPhase,
          version: nextState.version,
          desiredSignals: nextState.desiredSignals,
          actualSignals: nextState.actualSignals ?? Prisma.DbNull,
          stateTrust: nextState.stateTrust,
          actualObservedAt: nextState.actualObservedAt === null ? null : new Date(nextState.actualObservedAt),
          stageStartedAt: nextState.stageStartedAt === null ? null : new Date(nextState.stageStartedAt),
          stageDeadlineAt: nextState.stageDeadlineAt === null ? null : new Date(nextState.stageDeadlineAt),
          faultReason: nextState.faultReason,
          controllerHealth: input.event_type === "DEVICE_STATUS" && input.device_type === "CONTROLLER"
            ? input.status
            : input.event_type === "STATE_SNAPSHOT" || input.event_type === "COMMAND_ACK" ? "ONLINE" : runtime.controllerHealth,
        },
      });
      if (updateResult.count !== 1) return eventError(409, "RUNTIME_VERSION_CONFLICT", "Junction changed while the controller event was being processed");

      if (dispatchCommand !== null) {
        await transaction.controllerCommand.create({
          data: {
            commandId: dispatchCommand.commandId,
            junctionId: input.junction_id,
            desiredSignals: dispatchCommand.desiredSignals,
            runtimeVersion: dispatchCommand.runtimeVersion,
            status: "PENDING",
            deadlineAt: new Date(now.getTime() + DEFAULT_JUNCTION_CONFIG.timing.ackTimeoutMs),
          },
        });
      }

      await transaction.auditEvent.create({
        data: {
          junctionId: input.junction_id,
          kind: `CONTROLLER_${input.event_type}`,
          correlationId: input.event_id,
          payload: {
            event_id: input.event_id,
            event_type: input.event_type,
            command_id: input.event_type === "COMMAND_ACK" ? input.command_id : null,
            device_type: input.event_type === "DEVICE_STATUS" ? input.device_type : null,
            direction: input.event_type === "DEVICE_STATUS" ? input.direction ?? null : null,
            reported_status: input.event_type === "DEVICE_STATUS" ? input.status : null,
            outcome,
            prior_stage: state.stage,
            next_stage: nextState.stage,
          },
          occurredAt: now,
        },
      });

      return {
        httpStatus: 202,
        body: { accepted: true, duplicate: false, event_id: input.event_id, outcome, stage: nextState.stage },
        dispatchCommand,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async requestIntent(
    junctionId: string,
    phase: TrafficState["phase"],
    intent: "MANUAL" | "RESUME_MANUAL" | "EMERGENCY" | "AUTOMATIC",
    now = Date.now(),
    auditReason: "USER_COMMAND" | "POLICY_REEVALUATION" = "USER_COMMAND",
  ): Promise<SignalCommand | null> {
    return this.serialProcessor.run(junctionId, () => this.prisma.$transaction(async (transaction) => {
      const runtime = await transaction.junctionRuntime.findUnique({ where: { junctionId } });
      if (runtime === null) return null;
      const pending = await transaction.controllerCommand.findFirst({
        where: { junctionId, status: { in: ["PENDING", "SENT"] } },
        orderBy: { createdAt: "desc" },
      });
      const state = toTrafficState(runtime, pending);
      const rows = await transaction.vehicle.findMany({
        where: { junctionId, status: "WAITING" },
        select: { direction: true, type: true, arrivedAtServer: true, vehicleId: true, arrivalEventId: true },
      });
      const vehicles = asWaitingVehicles(rows);
      const emergencyPhase = chooseEmergencyPhase(vehicles);
      const automaticPhase = chooseAutomaticPhase(
        buildPhaseQueues(vehicles.filter((vehicle) => vehicle.type !== "EMERGENCY"), now),
        state.phase,
      );
      const requestedManualPhase = intent === "MANUAL" ? phase : intent === "RESUME_MANUAL" ? runtime.manualPhase : null;
      const manualLeaseActive = intent === "MANUAL"
        || (intent === "RESUME_MANUAL" && runtime.manualExpiresAt !== null && runtime.manualExpiresAt.getTime() > now);
      const activeEmergency = emergencyPhase !== null;
      const activeManual = manualLeaseActive && requestedManualPhase !== null;
      const expiry = intent === "MANUAL" ? new Date(now + 120_000)
        : intent === "AUTOMATIC" ? null
          : runtime.manualExpiresAt !== null && runtime.manualExpiresAt.getTime() > now ? runtime.manualExpiresAt : null;
      const target = emergencyPhase ?? (activeManual ? requestedManualPhase : automaticPhase);
      const requestedMode: TrafficState["mode"] = activeEmergency ? "EMERGENCY" : activeManual ? "MANUAL" : "AUTOMATIC";
      const baseState = { ...state, mode: requestedMode };
      const result: EngineResult = state.pendingCommand !== null
        ? { state: { ...baseState, targetPhase: target }, command: null, outcome: "APPLIED" }
        : target === null
          ? requestAllRed(baseState, randomUUID(), now, DEFAULT_JUNCTION_CONFIG)
          : requestPhase(baseState, target, randomUUID(), now, DEFAULT_JUNCTION_CONFIG, activeEmergency || activeManual ? "OVERRIDE" : "NORMAL");
      const resultingState = result.state;
      const nextMode = result.outcome === "LOCKED" ? resultingState.mode : requestedMode;
      const update = await transaction.junctionRuntime.updateMany({
        where: { junctionId, version: runtime.version },
        data: {
          mode: nextMode,
          targetPhase: resultingState.targetPhase,
          manualPhase: intent === "MANUAL" ? phase : intent === "AUTOMATIC" ? null : runtime.manualPhase,
          intentRevision: runtime.intentRevision + 1,
          version: resultingState.version,
          desiredSignals: resultingState.desiredSignals,
          actualSignals: resultingState.actualSignals ?? Prisma.DbNull,
          stateTrust: resultingState.stateTrust,
          stageStartedAt: resultingState.stageStartedAt === null ? null : new Date(resultingState.stageStartedAt),
          stageDeadlineAt: resultingState.stageDeadlineAt === null ? null : new Date(resultingState.stageDeadlineAt),
          manualExpiresAt: expiry,
          faultReason: result.state.faultReason,
        },
      });
      if (update.count !== 1) return null;
      await transaction.auditEvent.create({
        data: {
          junctionId,
          kind: intent === "MANUAL" ? "MANUAL_INTENT_ACCEPTED"
            : intent === "EMERGENCY" ? "EMERGENCY_PREEMPTION_REQUESTED"
              : intent === "AUTOMATIC" && auditReason === "USER_COMMAND" ? "RETURNED_TO_AUTOMATIC"
                : intent === "AUTOMATIC" ? "AUTOMATIC_POLICY_REEVALUATED" : "MANUAL_INTENT_RESUMED",
          payload: {
            phase: target,
            intent,
            lease_expires_at: expiry?.toISOString() ?? null,
            outcome: result.outcome,
            intent_revision: runtime.intentRevision + 1,
          },
          occurredAt: new Date(now),
        },
      });
      if (result.command === null) return null;
      await transaction.controllerCommand.create({
        data: {
          commandId: result.command.commandId,
          junctionId,
          desiredSignals: result.command.desiredSignals,
          runtimeVersion: result.command.runtimeVersion,
          status: "PENDING",
          deadlineAt: new Date(now + DEFAULT_JUNCTION_CONFIG.timing.ackTimeoutMs),
        },
      });
      return result.command;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async reevaluatePolicy(junctionId: string, now = Date.now()): Promise<SignalCommand | null> {
    const rows = await this.prisma.vehicle.findMany({
      where: { junctionId, status: "WAITING" },
      select: { direction: true, type: true, arrivedAtServer: true, vehicleId: true, arrivalEventId: true },
    });
    const emergencyPhase = chooseEmergencyPhase(asWaitingVehicles(rows));
    if (emergencyPhase !== null) return this.requestIntent(junctionId, emergencyPhase, "EMERGENCY", now);
    const runtime = await this.prisma.junctionRuntime.findUnique({ where: { junctionId } });
    if (runtime?.manualExpiresAt !== null && runtime?.manualExpiresAt !== undefined && runtime.manualExpiresAt.getTime() > now)
      return this.requestIntent(junctionId, runtime.manualPhase, "RESUME_MANUAL", now);
    return this.requestIntent(junctionId, null, "AUTOMATIC", now, "POLICY_REEVALUATION");
  }

  async prepareForStartup(): Promise<void> {
    const runtimes = await this.prisma.junctionRuntime.findMany({ select: { junctionId: true } });
    for (const runtime of runtimes) await this.prepareJunctionForStartup(runtime.junctionId);
  }

  async prepareJunctionForStartup(junctionId: string): Promise<void> {
    await this.serialProcessor.run(junctionId, () => this.prisma.$transaction(async (transaction) => {
      const current = await transaction.junctionRuntime.findUnique({ where: { junctionId } });
      if (current === null) return;
      const now = new Date();
      const update = await transaction.junctionRuntime.updateMany({
        where: { junctionId: current.junctionId, version: current.version },
        data: {
          mode: "DEGRADED",
          stage: "STARTUP_RECONCILIATION",
          phase: null,
          version: current.version + 1,
          stateTrust: current.actualSignals === null ? "UNKNOWN" : "STALE",
          actualObservedAt: null,
          stageStartedAt: null,
          stageDeadlineAt: null,
          faultReason: "Process restarted; awaiting a fresh controller snapshot",
          controllerHealth: "UNKNOWN",
        },
      });
      if (update.count !== 1) return;

      const pendingCommands = await transaction.controllerCommand.findMany({
        where: { junctionId: current.junctionId, status: { in: ["PENDING", "SENT"] } },
        select: { commandId: true },
      });
      await transaction.controllerCommand.updateMany({
        where: { junctionId: current.junctionId, status: { in: ["PENDING", "SENT"] } },
        data: { status: "FAILED" },
      });
      await transaction.auditEvent.create({
        data: {
          junctionId: current.junctionId,
          kind: "STARTUP_RECONCILIATION_REQUIRED",
          payload: {
            failed_pending_commands: pendingCommands.map((command) => command.commandId),
            prior_actual_state_trust: current.stateTrust,
          },
          occurredAt: now,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async advanceDue(junctionId: string, now = Date.now()): Promise<SignalCommand | null> {
    return this.serialProcessor.run(junctionId, () => this.prisma.$transaction(async (transaction) => {
      const runtime = await transaction.junctionRuntime.findUnique({ where: { junctionId } });
      if (runtime === null) return null;
      const pending = await transaction.controllerCommand.findFirst({
        where: { junctionId, status: { in: ["PENDING", "SENT"] } },
        orderBy: { createdAt: "desc" },
      });
      const state = toTrafficState(runtime, pending);
      let transition = advanceTime(state, randomUUID(), now, DEFAULT_JUNCTION_CONFIG);
      let mode = transition.state.mode;
      let manualExpiresAt = runtime.manualExpiresAt;
      const manualIsActive = runtime.manualPhase !== null
        && runtime.manualExpiresAt !== null
        && runtime.manualExpiresAt.getTime() > now;
      let emergencyPhase: typeof runtime.manualPhase = null;
      const isGreen = transition.state.stage === "NORTH_SOUTH_GREEN" || transition.state.stage === "EAST_WEST_GREEN";
      if (transition.command === null && isGreen && transition.state.pendingCommand === null) {
        const rows = await transaction.vehicle.findMany({
          where: { junctionId, status: "WAITING" },
          select: { direction: true, type: true, arrivedAtServer: true, vehicleId: true, arrivalEventId: true },
        });
        const vehicles = asWaitingVehicles(rows);
        emergencyPhase = chooseEmergencyPhase(vehicles);
        const queues = buildPhaseQueues(vehicles.filter((vehicle) => vehicle.type !== "EMERGENCY"), now);
        const automaticPhase = chooseAutomaticPhase(queues, state.phase);
        const desiredPhase = emergencyPhase ?? (manualIsActive ? runtime.manualPhase : automaticPhase);
        const currentQueue = state.phase === null ? null : queues[state.phase];
        const desiredQueue = desiredPhase === null ? null : queues[desiredPhase];
        const elapsedGreen = now - (state.stageStartedAt ?? now);
        const starvedOpposite = desiredQueue !== null && desiredQueue.oldestWaitMs >= 90_000;
        const mayPreempt = emergencyPhase !== null || manualIsActive || (desiredPhase !== null && desiredPhase !== state.phase && (
          elapsedGreen >= DEFAULT_JUNCTION_CONFIG.timing.normalGreenMs
          || (elapsedGreen >= DEFAULT_JUNCTION_CONFIG.timing.minimumGreenMs && currentQueue?.count === 0)
          || starvedOpposite
        ));
        if (mayPreempt && desiredPhase !== null && desiredPhase !== state.phase) {
          transition = requestPhase(
            { ...transition.state, mode: emergencyPhase !== null ? "EMERGENCY" : manualIsActive ? "MANUAL" : "AUTOMATIC" },
            desiredPhase,
            randomUUID(),
            now,
            DEFAULT_JUNCTION_CONFIG,
            emergencyPhase !== null || manualIsActive ? "OVERRIDE" : "NORMAL",
          );
          mode = transition.state.mode;
        } else if (desiredPhase === null && emergencyPhase === null && !manualIsActive
          && elapsedGreen >= DEFAULT_JUNCTION_CONFIG.timing.normalGreenMs) {
          transition = requestAllRed(transition.state, randomUUID(), now, DEFAULT_JUNCTION_CONFIG);
          mode = "AUTOMATIC";
        } else {
          transition = {
            ...transition,
            state: {
              ...transition.state,
              stageDeadlineAt: now + 5_000,
              mode: emergencyPhase !== null ? "EMERGENCY" : manualIsActive ? "MANUAL" : "AUTOMATIC",
            },
          };
          mode = transition.state.mode;
        }
      }
      if (!manualIsActive && emergencyPhase === null) manualExpiresAt = null;
      const updateResult = await transaction.junctionRuntime.updateMany({
        where: { junctionId, version: runtime.version },
        data: {
          mode,
          stage: transition.state.stage,
          phase: transition.state.phase,
          targetPhase: transition.state.targetPhase,
          version: transition.state.version,
          desiredSignals: transition.state.desiredSignals,
          actualSignals: transition.state.actualSignals ?? Prisma.DbNull,
          stateTrust: transition.state.stateTrust,
          actualObservedAt: transition.state.actualObservedAt === null ? null : new Date(transition.state.actualObservedAt),
          stageStartedAt: transition.state.stageStartedAt === null ? null : new Date(transition.state.stageStartedAt),
          stageDeadlineAt: transition.state.stageDeadlineAt === null ? null : new Date(transition.state.stageDeadlineAt),
          manualPhase: manualIsActive ? runtime.manualPhase : emergencyPhase !== null ? runtime.manualPhase : null,
          manualExpiresAt,
          faultReason: transition.state.faultReason,
        },
      });
      if (updateResult.count !== 1) return null;

      if (transition.command === null) return null;
      await transaction.controllerCommand.create({
        data: {
          commandId: transition.command.commandId,
          junctionId,
          desiredSignals: transition.command.desiredSignals,
          runtimeVersion: transition.command.runtimeVersion,
          status: "PENDING",
          deadlineAt: new Date(now + DEFAULT_JUNCTION_CONFIG.timing.ackTimeoutMs),
        },
      });
      await transaction.auditEvent.create({
        data: {
          junctionId,
          kind: "CONTROLLER_TIMER_TRANSITION",
          correlationId: transition.command.commandId,
          payload: {
            command_id: transition.command.commandId,
            trigger: "stage_deadline",
            prior_stage: state.stage,
            stage: transition.state.stage,
            target_phase: transition.state.targetPhase,
            desired_signals: transition.command.desiredSignals,
          },
          occurredAt: new Date(now),
        },
      });
      return transition.command;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async handleTimeout(commandId: string, now = Date.now()): Promise<SignalCommand | null> {
    const command = await this.prisma.controllerCommand.findUnique({
      where: { commandId },
      select: { junctionId: true },
    });
    if (command === null) return null;

    return this.serialProcessor.run(command.junctionId, () => this.prisma.$transaction(async (transaction) => {
      const currentCommand = await transaction.controllerCommand.findUnique({ where: { commandId } });
      if (currentCommand === null || currentCommand.status !== "SENT" || currentCommand.deadlineAt === null || currentCommand.deadlineAt.getTime() > now) {
        return null;
      }

      const simulator = await transaction.controllerSimulatorState.findUnique({
        where: { junctionId: currentCommand.junctionId },
        select: { health: true },
      });
      if (currentCommand.attempts < 2 && simulator?.health === "ONLINE") {
        await transaction.controllerCommand.update({
          where: { commandId },
          data: { status: "PENDING", deadlineAt: new Date(now + DEFAULT_JUNCTION_CONFIG.timing.ackTimeoutMs) },
        });
        await transaction.auditEvent.create({
          data: {
            junctionId: currentCommand.junctionId,
            kind: "CONTROLLER_COMMAND_RETRY",
            correlationId: commandId,
            payload: { command_id: commandId, attempt: currentCommand.attempts + 1 },
            occurredAt: new Date(now),
          },
        });
        return {
          commandId,
          desiredSignals: SignalVectorSchema.parse(currentCommand.desiredSignals),
          runtimeVersion: currentCommand.runtimeVersion,
        };
      }

      const runtime = await transaction.junctionRuntime.findUnique({ where: { junctionId: currentCommand.junctionId } });
      if (runtime !== null) {
        const state = toTrafficState(runtime, currentCommand);
        const faultedState = markUnknown(state, "Controller acknowledgement timed out");
        await transaction.junctionRuntime.updateMany({
          where: { junctionId: currentCommand.junctionId, version: runtime.version },
          data: {
            mode: faultedState.mode,
            stage: faultedState.stage,
            phase: faultedState.phase,
            targetPhase: faultedState.targetPhase,
            version: faultedState.version,
            desiredSignals: faultedState.desiredSignals,
            actualSignals: Prisma.DbNull,
            stateTrust: faultedState.stateTrust,
            actualObservedAt: null,
            stageDeadlineAt: null,
            faultReason: faultedState.faultReason,
            controllerHealth: simulator?.health ?? "UNKNOWN",
          },
        });
      }
      await transaction.controllerCommand.update({ where: { commandId }, data: { status: "TIMED_OUT" } });
      await transaction.auditEvent.create({
        data: {
          junctionId: currentCommand.junctionId,
          kind: "CONTROLLER_COMMAND_TIMEOUT",
          correlationId: commandId,
          payload: { command_id: commandId, attempts: currentCommand.attempts },
          occurredAt: new Date(now),
        },
      });
      return null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }
}

function toTrafficState(
  runtime: {
    mode: "AUTOMATIC" | "MANUAL" | "EMERGENCY" | "DEGRADED";
    stage: TrafficState["stage"];
    phase: TrafficState["phase"];
    targetPhase: TrafficState["targetPhase"];
    version: number;
    desiredSignals: unknown;
    actualSignals: unknown;
    stateTrust: TrafficState["stateTrust"];
    actualObservedAt: Date | null;
    stageStartedAt: Date | null;
    stageDeadlineAt: Date | null;
    faultReason: string | null;
  },
  pending: {
    commandId: string;
    desiredSignals: unknown;
    runtimeVersion: number;
  } | null,
): TrafficState {
  return {
    mode: runtime.mode,
    stage: runtime.stage,
    phase: runtime.phase,
    targetPhase: runtime.targetPhase,
    version: runtime.version,
    desiredSignals: SignalVectorSchema.parse(runtime.desiredSignals),
    actualSignals: runtime.actualSignals === null ? null : SignalVectorSchema.parse(runtime.actualSignals),
    stateTrust: runtime.stateTrust,
    actualObservedAt: runtime.actualObservedAt?.getTime() ?? null,
    stageStartedAt: runtime.stageStartedAt?.getTime() ?? null,
    stageDeadlineAt: runtime.stageDeadlineAt?.getTime() ?? null,
    pendingCommand: pending === null ? null : {
      commandId: pending.commandId,
      desiredSignals: SignalVectorSchema.parse(pending.desiredSignals),
      runtimeVersion: pending.runtimeVersion,
    },
    faultReason: runtime.faultReason,
  };
}

function asWaitingVehicles(rows: readonly {
  direction: string;
  type: "EMERGENCY" | "TRUCK" | "FORKLIFT" | "EMPLOYEE_VEHICLE";
  arrivedAtServer: Date;
  vehicleId: string;
  arrivalEventId: string;
}[]): WaitingVehicle[] {
  return rows.flatMap((row) => isDirection(row.direction)
    ? [{ direction: row.direction, type: row.type, arrivedAtServer: row.arrivedAtServer, vehicleId: row.vehicleId, eventId: row.arrivalEventId }]
    : []);
}

function hashControllerEvent(input: ControllerEventInput): string {
  return createHash("sha256").update(JSON.stringify(input) ?? "").digest("hex");
}

function eventError(httpStatus: number, code: string, message: string): ControllerEventResult {
  return {
    httpStatus,
    body: { accepted: false, duplicate: false, error: { code, message } },
    dispatchCommand: null,
  };
}

async function upsertDeviceStatus(
  transaction: Prisma.TransactionClient,
  junctionId: string,
  deviceType: "CONTROLLER" | "SENSOR" | "SIGNAL_CONTROLLER",
  direction: string | null,
  health: "ONLINE" | "OFFLINE",
  now: Date,
): Promise<void> {
  const current = await transaction.deviceStatus.findFirst({
    where: { junctionId, deviceType, direction },
    select: { id: true },
  });
  if (current === null) {
    await transaction.deviceStatus.create({
      data: { junctionId, deviceType, direction, health, lastSeenAt: now, issueCode: health === "OFFLINE" ? `${deviceType}_OFFLINE` : null },
    });
    return;
  }
  await transaction.deviceStatus.update({
    where: { id: current.id },
    data: { health, lastSeenAt: now, issueCode: health === "OFFLINE" ? `${deviceType}_OFFLINE` : null },
  });
}
