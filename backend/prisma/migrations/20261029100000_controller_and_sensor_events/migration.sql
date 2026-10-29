CREATE TYPE "SimulatorAckBehavior" AS ENUM ('NORMAL', 'DROP', 'DUPLICATE', 'MISMATCH');

ALTER TABLE "sensor_events"
  ADD COLUMN "vehicle_id" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "vehicle_type" "VehicleType";
ALTER TABLE "sensor_events" ALTER COLUMN "vehicle_id" DROP DEFAULT;

ALTER TABLE "controller_events"
  ADD COLUMN "payload_hash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "controller_events" ALTER COLUMN "payload_hash" DROP DEFAULT;
ALTER TABLE "controller_events" ADD COLUMN "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "controller_events" ALTER COLUMN "reported_at" DROP DEFAULT;

ALTER TABLE "junction_runtime" ADD COLUMN "fault_reason" TEXT;

CREATE TABLE "controller_simulator_states" (
  "junction_id" TEXT NOT NULL,
  "actual_signals" JSONB NOT NULL,
  "health" "DeviceHealth" NOT NULL DEFAULT 'ONLINE',
  "automatic_ack" BOOLEAN NOT NULL DEFAULT true,
  "ack_delay_ms" INTEGER NOT NULL DEFAULT 0,
  "next_ack_behavior" "SimulatorAckBehavior" NOT NULL DEFAULT 'NORMAL',
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "controller_simulator_states_pkey" PRIMARY KEY ("junction_id"),
  CONSTRAINT "controller_simulator_states_junction_id_fkey" FOREIGN KEY ("junction_id") REFERENCES "junctions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
