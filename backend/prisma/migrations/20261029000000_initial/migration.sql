CREATE TYPE "RuntimeMode" AS ENUM ('AUTOMATIC', 'MANUAL', 'EMERGENCY', 'DEGRADED');
CREATE TYPE "RuntimeStage" AS ENUM ('STARTUP_RECONCILIATION', 'ALL_RED', 'NORTH_SOUTH_GREEN', 'NORTH_SOUTH_YELLOW', 'EAST_WEST_GREEN', 'EAST_WEST_YELLOW', 'FAULT_LOCKOUT');
CREATE TYPE "TrafficPhase" AS ENUM ('NORTH_SOUTH', 'EAST_WEST');
CREATE TYPE "StateTrust" AS ENUM ('CONFIRMED', 'STALE', 'UNKNOWN', 'MISMATCH');
CREATE TYPE "SignalColor" AS ENUM ('RED', 'YELLOW', 'GREEN');
CREATE TYPE "VehicleType" AS ENUM ('EMERGENCY', 'TRUCK', 'FORKLIFT', 'EMPLOYEE_VEHICLE');
CREATE TYPE "VehicleStatus" AS ENUM ('WAITING', 'CLEARED');
CREATE TYPE "SensorEventType" AS ENUM ('VEHICLE_ARRIVED', 'VEHICLE_CLEARED');
CREATE TYPE "EventResult" AS ENUM ('ACCEPTED', 'DUPLICATE', 'REJECTED');
CREATE TYPE "ControllerCommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'TIMED_OUT', 'FAILED');
CREATE TYPE "DeviceType" AS ENUM ('CONTROLLER', 'SENSOR');
CREATE TYPE "DeviceHealth" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');

CREATE TABLE "junctions" (
  "id" TEXT NOT NULL,
  "config" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "junctions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "junction_runtime" (
  "junction_id" TEXT NOT NULL,
  "mode" "RuntimeMode" NOT NULL DEFAULT 'DEGRADED',
  "stage" "RuntimeStage" NOT NULL DEFAULT 'STARTUP_RECONCILIATION',
  "phase" "TrafficPhase",
  "target_phase" "TrafficPhase",
  "version" INTEGER NOT NULL DEFAULT 0,
  "desired_signals" JSONB NOT NULL,
  "actual_signals" JSONB,
  "state_trust" "StateTrust" NOT NULL DEFAULT 'UNKNOWN',
  "actual_observed_at" TIMESTAMP(3),
  "stage_started_at" TIMESTAMP(3),
  "stage_deadline_at" TIMESTAMP(3),
  "manual_expires_at" TIMESTAMP(3),
  "controller_health" "DeviceHealth" NOT NULL DEFAULT 'UNKNOWN',
  CONSTRAINT "junction_runtime_pkey" PRIMARY KEY ("junction_id"),
  CONSTRAINT "junction_runtime_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "vehicles" (
  "id" TEXT NOT NULL,
  "junction_id" TEXT NOT NULL,
  "vehicle_id" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "type" "VehicleType" NOT NULL,
  "status" "VehicleStatus" NOT NULL DEFAULT 'WAITING',
  "arrived_at_server" TIMESTAMP(3) NOT NULL,
  "cleared_at_server" TIMESTAMP(3),
  CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vehicles_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "vehicles_junction_id_status_direction_idx" ON "vehicles"("junction_id", "status", "direction");
CREATE INDEX "vehicles_junction_id_vehicle_id_status_idx" ON "vehicles"("junction_id", "vehicle_id", "status");
CREATE UNIQUE INDEX "vehicles_one_waiting_per_vehicle" ON "vehicles"("junction_id", "vehicle_id") WHERE "status" = 'WAITING';

CREATE TABLE "sensor_events" (
  "id" TEXT NOT NULL,
  "junction_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "sequence_no" INTEGER NOT NULL,
  "event_type" "SensorEventType" NOT NULL,
  "sensor_timestamp" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "result" "EventResult" NOT NULL,
  "rejection_code" TEXT,
  CONSTRAINT "sensor_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sensor_events_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sensor_events_junction_id_event_id_key" ON "sensor_events"("junction_id", "event_id");
CREATE INDEX "sensor_events_junction_id_direction_sequence_no_idx" ON "sensor_events"("junction_id", "direction", "sequence_no");

CREATE TABLE "direction_cursors" (
  "junction_id" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "last_sequence" INTEGER NOT NULL,
  CONSTRAINT "direction_cursors_pkey" PRIMARY KEY ("junction_id", "direction"),
  CONSTRAINT "direction_cursors_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "controller_commands" (
  "command_id" TEXT NOT NULL,
  "junction_id" TEXT NOT NULL,
  "desired_signals" JSONB NOT NULL,
  "runtime_version" INTEGER NOT NULL,
  "status" "ControllerCommandStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "deadline_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMP(3),
  "acknowledged_at" TIMESTAMP(3),
  CONSTRAINT "controller_commands_pkey" PRIMARY KEY ("command_id"),
  CONSTRAINT "controller_commands_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "controller_commands_junction_id_status_idx" ON "controller_commands"("junction_id", "status");

CREATE TABLE "controller_events" (
  "id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "junction_id" TEXT NOT NULL,
  "command_id" TEXT,
  "reported_signals" JSONB,
  "status" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "controller_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "controller_events_event_id_key" UNIQUE ("event_id"),
  CONSTRAINT "controller_events_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "controller_events_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "controller_commands"("command_id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "controller_events_junction_id_received_at_idx" ON "controller_events"("junction_id", "received_at");

CREATE TABLE "audit_events" (
  "id" TEXT NOT NULL,
  "junction_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "correlation_id" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_events_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "audit_events_junction_id_occurred_at_idx" ON "audit_events"("junction_id", "occurred_at");

CREATE TABLE "device_statuses" (
  "id" TEXT NOT NULL,
  "junction_id" TEXT NOT NULL,
  "device_type" "DeviceType" NOT NULL,
  "direction" TEXT,
  "health" "DeviceHealth" NOT NULL,
  "issue_code" TEXT,
  "last_seen_at" TIMESTAMP(3),
  CONSTRAINT "device_statuses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_statuses_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "device_statuses_junction_id_device_type_direction_idx" ON "device_statuses"("junction_id", "device_type", "direction");
