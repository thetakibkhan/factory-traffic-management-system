ALTER TABLE "junction_runtime" ADD COLUMN "manual_phase" "TrafficPhase";
ALTER TABLE "junction_runtime" ADD COLUMN "intent_revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "vehicles" ADD COLUMN "arrival_event_id" TEXT;
UPDATE "vehicles" SET "arrival_event_id" = "vehicle_id" WHERE "arrival_event_id" IS NULL;
ALTER TABLE "vehicles" ALTER COLUMN "arrival_event_id" SET NOT NULL;
CREATE INDEX "vehicles_type_status_arrived_at_server_idx" ON "vehicles"("type", "status", "arrived_at_server");
