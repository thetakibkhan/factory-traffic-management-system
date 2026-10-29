import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { allRedSignals, greenSignals, DEFAULT_JUNCTION_CONFIG, type SignalCommand, type SignalVector } from "../../domain/traffic/types.js";
import { ControllerEventService } from "../../application/controllerEventService.js";
import type { ControllerPort } from "./controllerPort.js";

const SimulatorConfigSchema = z.object({
  health: z.enum(["ONLINE", "OFFLINE"]).optional(),
  automatic_ack: z.boolean().optional(),
  ack_delay_ms: z.number().int().min(0).max(60_000).optional(),
  next_ack_behavior: z.enum(["NORMAL", "DROP", "DUPLICATE", "MISMATCH"]).optional(),
}).strict().refine((config) => Object.keys(config).length > 0, "At least one simulator setting is required");

export type SimulatorConfigInput = z.infer<typeof SimulatorConfigSchema>;

export class SimulatorAdapter implements ControllerPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly controllerEvents: ControllerEventService,
  ) {}

  async dispatch(command: SignalCommand, junctionId: string): Promise<void> {
    const sendResult = await this.prisma.controllerCommand.updateMany({
      where: { commandId: command.commandId, status: "PENDING" },
      data: {
        status: "SENT",
        attempts: { increment: 1 },
        sentAt: new Date(),
        deadlineAt: new Date(Date.now() + DEFAULT_JUNCTION_CONFIG.timing.ackTimeoutMs),
      },
    });
    if (sendResult.count !== 1) return;

    const simulator = await this.prisma.controllerSimulatorState.findUnique({
      where: { junctionId },
    });
    if (simulator === null || simulator.health !== "ONLINE") return;

    const behavior = simulator.nextAckBehavior;
    const actualSignals = behavior === "MISMATCH" ? mismatchedSignals(command.desiredSignals) : command.desiredSignals;
    await this.prisma.controllerSimulatorState.update({
      where: { junctionId: simulator.junctionId },
      data: { actualSignals, nextAckBehavior: "NORMAL" },
    });
    if (!simulator.automaticAck || behavior === "DROP") return;

    const ack = ControllerEventService.parse({
      event_id: `sim-ack-${command.commandId}`,
      event_type: "COMMAND_ACK",
      junction_id: simulator.junctionId,
      command_id: command.commandId,
      actual_signals: actualSignals,
      timestamp: new Date().toISOString(),
    });
    const deliver = async (): Promise<void> => {
      await this.submitControllerEvent(ack);
      if (behavior === "DUPLICATE") await this.submitControllerEvent(ack);
    };

    if (simulator.ackDelayMs === 0) {
      await deliver();
      return;
    }
    setTimeout(() => void deliver().catch(() => undefined), simulator.ackDelayMs);
  }

  async requestSnapshot(junctionId: string): Promise<void> {
    const simulator = await this.prisma.controllerSimulatorState.findUnique({ where: { junctionId } });
    if (simulator === null) return;
    if (simulator.health === "OFFLINE") {
      await this.submitControllerEvent({
        event_id: `sim-offline-${randomUUID()}`,
        event_type: "DEVICE_STATUS",
        junction_id: junctionId,
        status: "OFFLINE",
        timestamp: new Date().toISOString(),
      });
      return;
    }
    await this.submitControllerEvent({
      event_id: `sim-snapshot-${randomUUID()}`,
      event_type: "STATE_SNAPSHOT",
      junction_id: junctionId,
      actual_signals: simulator.actualSignals,
      timestamp: new Date().toISOString(),
    });
  }

  async configure(junctionId: string, value: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = SimulatorConfigSchema.safeParse(value);
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: { code: "INVALID_SIMULATOR_CONFIG", message: "Simulator configuration is invalid", details: parsed.error.issues } },
      };
    }
    const current = await this.prisma.controllerSimulatorState.findUnique({ where: { junctionId } });
    if (current === null) return { status: 404, body: { error: { code: "SIMULATOR_NOT_FOUND", message: "Controller simulator was not found" } } };

    const update = parsed.data;
    const next = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.controllerSimulatorState.update({
        where: { junctionId },
        data: {
          ...(update.health === undefined ? {} : { health: update.health }),
          ...(update.automatic_ack === undefined ? {} : { automaticAck: update.automatic_ack }),
          ...(update.ack_delay_ms === undefined ? {} : { ackDelayMs: update.ack_delay_ms }),
          ...(update.next_ack_behavior === undefined ? {} : { nextAckBehavior: update.next_ack_behavior }),
        },
      });
      await transaction.auditEvent.create({
        data: {
          junctionId,
          kind: "SIMULATOR_CONFIGURATION_CHANGED",
          payload: {
            health: updated.health,
            automatic_ack: updated.automaticAck,
            ack_delay_ms: updated.ackDelayMs,
            next_ack_behavior: updated.nextAckBehavior,
          },
        },
      });
      return updated;
    });
    if (update.health === "OFFLINE") {
      await this.submitControllerEvent({
        event_id: `sim-status-${randomUUID()}`,
        event_type: "DEVICE_STATUS",
        junction_id: junctionId,
        status: "OFFLINE",
        timestamp: new Date().toISOString(),
      });
    } else if (update.health === "ONLINE") {
      await this.requestSnapshot(junctionId);
    }
    return {
      status: 200,
      body: {
        junction_id: junctionId,
        health: next.health,
        automatic_ack: next.automaticAck,
        ack_delay_ms: next.ackDelayMs,
        next_ack_behavior: next.nextAckBehavior,
        actual_signals: next.actualSignals,
      },
    };
  }

  private async submitControllerEvent(input: unknown): Promise<void> {
    const event = ControllerEventService.parse(input);
    const result = await this.controllerEvents.process(event);
    if (result.dispatchCommand !== null) await this.dispatch(result.dispatchCommand, event.junction_id);
  }
}

function mismatchedSignals(desired: SignalVector): SignalVector {
  const requestedNorthSouthGreen = desired.NORTH === "GREEN" && desired.SOUTH === "GREEN";
  return requestedNorthSouthGreen ? allRedSignals() : greenSignals("NORTH_SOUTH", DEFAULT_JUNCTION_CONFIG);
}
