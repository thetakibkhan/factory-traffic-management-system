import { PrismaClient } from "@prisma/client";
import { ControllerEventService } from "../../application/controllerEventService.js";
import type { ControllerPort } from "../controllers/controllerPort.js";

export class ControllerScheduler {
  private interval: NodeJS.Timeout | null = null;
  private tickInProgress = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly controllerEvents: ControllerEventService,
    private readonly controller: ControllerPort,
  ) {}

  async start(): Promise<void> {
    if (this.interval !== null) return;
    await this.controllerEvents.prepareForStartup();
    this.interval = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        console.error("Controller scheduler iteration failed:", error);
      });
    }, 250);

    const simulators = await this.prisma.controllerSimulatorState.findMany({
      select: { junctionId: true },
    });
    for (const simulator of simulators) await this.controller.requestSnapshot(simulator.junctionId);
  }

  stop(): void {
    if (this.interval === null) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  private async tick(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      await this.performTick();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async performTick(): Promise<void> {
    const now = Date.now();
    const staleEmergencies = await this.prisma.vehicle.findMany({
      where: { type: "EMERGENCY", status: "WAITING", arrivedAtServer: { lte: new Date(now - 60_000) } },
      select: { id: true, junctionId: true, vehicleId: true, arrivedAtServer: true },
    });
    for (const emergency of staleEmergencies) {
      const existingAlert = await this.prisma.auditEvent.findFirst({
        where: { junctionId: emergency.junctionId, kind: "EMERGENCY_STALE", correlationId: emergency.id },
        select: { id: true },
      });
      if (existingAlert === null) {
        await this.prisma.auditEvent.create({
          data: {
            junctionId: emergency.junctionId,
            kind: "EMERGENCY_STALE",
            correlationId: emergency.id,
            payload: {
              vehicle_id: emergency.vehicleId,
              arrived_at: emergency.arrivedAtServer.toISOString(),
              alert_after_seconds: 60,
              active_intent_retained: true,
            },
            occurredAt: new Date(now),
          },
        });
      }
    }

    const starvedVehicles = await this.prisma.vehicle.findMany({
      where: {
        type: { in: ["TRUCK", "FORKLIFT", "EMPLOYEE_VEHICLE"] },
        status: "WAITING",
        arrivedAtServer: { lte: new Date(now - 90_000) },
      },
      select: { id: true, junctionId: true, vehicleId: true, arrivalEventId: true, direction: true, arrivedAtServer: true },
    });
    for (const vehicle of starvedVehicles) {
      const existingAlert = await this.prisma.auditEvent.findFirst({
        where: { junctionId: vehicle.junctionId, kind: "NORMAL_TRAFFIC_STARVATION", correlationId: vehicle.id },
        select: { id: true },
      });
      if (existingAlert === null) {
        await this.prisma.auditEvent.create({
          data: {
            junctionId: vehicle.junctionId,
            kind: "NORMAL_TRAFFIC_STARVATION",
            correlationId: vehicle.id,
            payload: {
              vehicle_id: vehicle.vehicleId,
              arrival_event_id: vehicle.arrivalEventId,
              direction: vehicle.direction,
              arrived_at: vehicle.arrivedAtServer.toISOString(),
              wait_seconds: Math.floor((now - vehicle.arrivedAtServer.getTime()) / 1_000),
              service_preference_threshold_seconds: 90,
            },
            occurredAt: new Date(now),
          },
        });
      }
    }

    const expiredCommands = await this.prisma.controllerCommand.findMany({
      where: {
        status: "SENT",
        deadlineAt: { lte: new Date(now) },
      },
      select: { commandId: true },
    });
    for (const { commandId } of expiredCommands) {
      const retry = await this.controllerEvents.handleTimeout(commandId, now);
      if (retry !== null) await this.controller.dispatch(retry);
    }

    const expiredStages = await this.prisma.junctionRuntime.findMany({
      where: {
        stateTrust: "CONFIRMED",
        stageDeadlineAt: { lte: new Date(now) },
      },
      select: { junctionId: true },
    });
    for (const { junctionId } of expiredStages) {
      const command = await this.controllerEvents.advanceDue(junctionId, now);
      if (command !== null) await this.controller.dispatch(command);
    }
  }
}
