import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PerJunctionSerialProcessor } from "./perJunctionSerialProcessor.js";

const DirectionSchema = z.union([
  z.literal("NORTH"),
  z.literal("SOUTH"),
  z.literal("EAST"),
  z.literal("WEST"),
]);

const VehicleTypeSchema = z.union([
  z.literal("EMERGENCY"),
  z.literal("TRUCK"),
  z.literal("FORKLIFT"),
  z.literal("EMPLOYEE_VEHICLE"),
]);

const SensorEventBaseSchema = z.object({
  event_id: z.string().trim().min(1).max(128),
  junction_id: z.string().trim().min(1).max(64),
  direction: DirectionSchema,
  sequence_no: z.number().int().positive().max(2_147_483_647),
  timestamp: z.string().datetime({ offset: true }),
});

const SensorEventSchema = z.discriminatedUnion("event_type", [
  SensorEventBaseSchema.extend({
    event_type: z.literal("VEHICLE_ARRIVED"),
    vehicle_id: z.string().trim().min(1).max(100),
    vehicle_type: VehicleTypeSchema,
  }).strict(),
  SensorEventBaseSchema.extend({
    event_type: z.literal("VEHICLE_CLEARED"),
    vehicle_id: z.string().trim().min(1).max(100),
  }).strict(),
]);

export type SensorEventInput = z.infer<typeof SensorEventSchema>;

export type SensorEventResult =
  | { httpStatus: 404; body: { accepted: false; duplicate: false; error: { code: string; message: string } } }
  | { httpStatus: 201; body: { accepted: true; duplicate: false; event_id: string; queue_count: number } }
  | { httpStatus: 200; body: { accepted: false; duplicate: true; event_id: string } }
  | {
    httpStatus: 409 | 422;
    body: { accepted: false; duplicate: false; error: { code: string; message: string } };
  };

export class SensorEventService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly serialProcessor: PerJunctionSerialProcessor,
  ) {}

  async process(input: SensorEventInput): Promise<SensorEventResult> {
    return this.serialProcessor.run(input.junction_id, () => this.prisma.$transaction(async (transaction) => {
      const junction = await transaction.junction.findUnique({ where: { id: input.junction_id }, select: { id: true } });
      if (junction === null) {
        return {
          httpStatus: 404,
          body: { accepted: false, duplicate: false, error: { code: "JUNCTION_NOT_FOUND", message: "Junction was not found" } },
        } satisfies SensorEventResult;
      }

      const canonicalPayload = canonicalize(input);
      const payloadHash = createHash("sha256").update(JSON.stringify(canonicalPayload) ?? "").digest("hex");
      const existingEvent = await transaction.sensorEvent.findUnique({
        where: { junctionId_eventId: { junctionId: input.junction_id, eventId: input.event_id } },
      });
      if (existingEvent !== null) {
        if (existingEvent.payloadHash === payloadHash) {
          await transaction.auditEvent.create({
            data: {
              junctionId: input.junction_id,
              kind: "SENSOR_EVENT_DUPLICATE",
              correlationId: input.event_id,
              payload: auditPayload(input, "DUPLICATE"),
            },
          });
          return { httpStatus: 200, body: { accepted: false, duplicate: true, event_id: input.event_id } } satisfies SensorEventResult;
        }
        await transaction.auditEvent.create({
          data: {
            junctionId: input.junction_id,
            kind: "SENSOR_EVENT_ID_CONFLICT",
            correlationId: input.event_id,
            payload: auditPayload(input, "EVENT_ID_CONFLICT"),
          },
        });
        return errorResult(409, "EVENT_ID_CONFLICT", "Event ID was already used for a different payload");
      }

      const cursor = await transaction.directionCursor.findUnique({
        where: { junctionId_direction: { junctionId: input.junction_id, direction: input.direction } },
      });
      if (cursor !== null && input.sequence_no <= cursor.lastSequence) {
        await recordSensorEvent(transaction, input, payloadHash, "REJECTED", "STALE_SEQUENCE");
        await recordAudit(transaction, input, "SENSOR_EVENT_REJECTED", "STALE_SEQUENCE");
        return errorResult(409, "STALE_SEQUENCE", "Sequence is not newer than the last event for this direction");
      }

      await transaction.directionCursor.upsert({
        where: { junctionId_direction: { junctionId: input.junction_id, direction: input.direction } },
        create: { junctionId: input.junction_id, direction: input.direction, lastSequence: input.sequence_no },
        update: { lastSequence: input.sequence_no },
      });

      const now = new Date();
      if (input.event_type === "VEHICLE_ARRIVED") {
        const waitingVehicle = await transaction.vehicle.findFirst({
          where: { junctionId: input.junction_id, vehicleId: input.vehicle_id, status: "WAITING" },
          select: { id: true },
        });
        if (waitingVehicle !== null) {
          await recordSensorEvent(transaction, input, payloadHash, "REJECTED", "VEHICLE_ALREADY_WAITING");
          await recordAudit(transaction, input, "SENSOR_EVENT_REJECTED", "VEHICLE_ALREADY_WAITING");
          return errorResult(409, "VEHICLE_ALREADY_WAITING", "Vehicle already has an active arrival");
        }

        await transaction.vehicle.create({
          data: {
            junctionId: input.junction_id,
            vehicleId: input.vehicle_id,
            arrivalEventId: input.event_id,
            direction: input.direction,
            type: input.vehicle_type,
            status: "WAITING",
            arrivedAtServer: now,
          },
        });
      } else {
        const waitingVehicle = await transaction.vehicle.findFirst({
          where: { junctionId: input.junction_id, vehicleId: input.vehicle_id, status: "WAITING" },
        });
        if (waitingVehicle === null) {
          await recordSensorEvent(transaction, input, payloadHash, "REJECTED", "UNMATCHED_CLEARANCE");
          await recordAudit(transaction, input, "SENSOR_EVENT_REJECTED", "UNMATCHED_CLEARANCE");
          return errorResult(422, "UNMATCHED_CLEARANCE", "No active arrival exists for this vehicle");
        }
        if (waitingVehicle.direction !== input.direction) {
          await recordSensorEvent(transaction, input, payloadHash, "REJECTED", "DIRECTION_MISMATCH");
          await recordAudit(transaction, input, "SENSOR_EVENT_REJECTED", "DIRECTION_MISMATCH");
          return errorResult(422, "DIRECTION_MISMATCH", "Clearance direction does not match the active vehicle");
        }
        await transaction.vehicle.update({
          where: { id: waitingVehicle.id },
          data: { status: "CLEARED", clearedAtServer: now },
        });
      }

      await recordSensorEvent(transaction, input, payloadHash, "ACCEPTED", null);
      await recordAudit(transaction, input, "SENSOR_EVENT_ACCEPTED", null);
      const queueCount = await transaction.vehicle.count({
        where: { junctionId: input.junction_id, direction: input.direction, status: "WAITING" },
      });
      return {
        httpStatus: 201,
        body: { accepted: true, duplicate: false, event_id: input.event_id, queue_count: queueCount },
      } satisfies SensorEventResult;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  static parse(input: unknown): SensorEventInput {
    return SensorEventSchema.parse(input);
  }
}

function canonicalize(input: SensorEventInput): Record<string, string | number> {
  const common = {
    event_id: input.event_id,
    junction_id: input.junction_id,
    direction: input.direction,
    sequence_no: input.sequence_no,
    timestamp: new Date(input.timestamp).toISOString(),
    event_type: input.event_type,
    vehicle_id: input.vehicle_id,
  };
  return input.event_type === "VEHICLE_ARRIVED"
    ? { ...common, vehicle_type: input.vehicle_type }
    : common;
}

function auditPayload(input: SensorEventInput, result: string): Record<string, string | number> {
  return { ...canonicalize(input), result };
}

async function recordSensorEvent(
  transaction: Prisma.TransactionClient,
  input: SensorEventInput,
  payloadHash: string,
  result: "ACCEPTED" | "REJECTED",
  rejectionCode: string | null,
): Promise<void> {
  await transaction.sensorEvent.create({
    data: {
      junctionId: input.junction_id,
      eventId: input.event_id,
      payloadHash,
      direction: input.direction,
      vehicleId: input.vehicle_id,
      vehicleType: input.event_type === "VEHICLE_ARRIVED" ? input.vehicle_type : null,
      sequenceNo: input.sequence_no,
      eventType: input.event_type,
      sensorTimestamp: new Date(input.timestamp),
      result,
      rejectionCode,
    },
  });
}

async function recordAudit(
  transaction: Prisma.TransactionClient,
  input: SensorEventInput,
  kind: string,
  reason: string | null,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      junctionId: input.junction_id,
      kind,
      correlationId: input.event_id,
      payload: { ...auditPayload(input, kind), reason },
    },
  });
}

function errorResult(httpStatus: 409 | 422, code: string, message: string): SensorEventResult {
  return { httpStatus, body: { accepted: false, duplicate: false, error: { code, message } } };
}
