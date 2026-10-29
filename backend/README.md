# Factory Traffic Management Backend

This backend implements the traffic API for the Junction A simulation: PostgreSQL persistence, an ACK-gated safety engine, queue scheduling, emergency/manual intents, a persisted controller simulator/outbox, and idempotent sensor event handling.

## Requirements

- Node.js 20.19 or newer, or 22.12 or newer (matches the dashboard's Vite requirement)
- PostgreSQL 15 or newer

## Setup

From this directory:

```sh
npm install
cp .env.example .env
# Create the database named factory_traffic, or update DATABASE_URL.
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Run the domain and application validation tests with `npm test` and type-check/build with `npm run build`.

The API listens on `PORT` (3000 by default). Available reads:

- `GET /api/health` — checks the database connection.
- `GET /api/junctions` — lists configured junctions.
- `GET /api/junctions/:id/status` — returns runtime state and vehicle queue counts.
- `GET /api/junctions/:id/history?limit=30&cursor=...` — returns newest cause-linked audit records with cursor pagination.
- `POST /api/sensor-events` — records vehicle arrival and clearance events.
- `POST /api/junctions/:id/commands` — requests a manual phase or returns to automatic operation.
- `POST /api/controller-events` — processes controller ACK, snapshot, and device status events.
- `GET /api/simulators/:id` — reads simulator health, behavior, and its independently stored signal vector.
- `PATCH /api/simulators/:id` — changes simulator health/ACK behavior for failure scenarios.

Example sensor arrival:

```json
{
  "event_id": "evt-10001",
  "junction_id": "A",
  "direction": "NORTH",
  "event_type": "VEHICLE_ARRIVED",
  "vehicle_id": "VH-501",
  "vehicle_type": "TRUCK",
  "sequence_no": 1501,
  "timestamp": "2026-10-29T08:15:20Z"
}
```

Use `PATCH /api/simulators/A` with `{"next_ack_behavior":"DROP"}`, `DUPLICATE`, or `MISMATCH` to exercise controller failures. `{"health":"OFFLINE"}` takes the simulated controller offline; setting it back to `ONLINE` triggers a fresh snapshot.

## Epics 2–4

`src/domain/traffic` contains framework-independent types and transition functions. Controller commands are persisted before simulator dispatch. ACKs and snapshots pass through one controller event processor; commands retry once with the same ID, then timeout into `FAULT_LOCKOUT`. The simulator persists its own reported state and can delay, drop, duplicate, or mismatch the next ACK, or report OFFLINE. A fresh full-vector snapshot reconciles the runtime.

Sensor events use strict payload validation, unique junction/event IDs with canonical payload hashes, and per-direction sequence cursors. Queues derive from active vehicle rows. Duplicate arrivals, stale sequence numbers, unmatched clearances, and direction mismatches are audited and do not decrement or double-count queues.

The process serializes work per junction. This is a single-instance demo guarantee; it does not provide multi-server locking. Controller reports are not independent proof of physical lamp state, so this simulator makes no real-hardware safety claim.

## Epics 5–6

Automatic phase selection weights employee vehicles at 1, forklifts at 2, and trucks at 4, then adds an age bonus of one point per 15 seconds capped at 8. A phase waiting at least 90 seconds gets starvation priority. Green is reevaluated every 5 seconds, normally runs up to 30 seconds, and observes a 10-second minimum except when the opposite queue is empty or a higher-priority intent requests safe preemption. Every physical change still uses the confirmed yellow, all-red, and controller ACK sequence.

`POST /api/junctions/:id/commands` accepts `{"command_type":"MANUAL_GREEN_REQUEST","direction":"NORTH"}` or `{"command_type":"RETURN_TO_AUTOMATIC"}`. Each accepted manual request starts a 120-second lease. Manual phase is stored separately so it can resume after active emergencies clear while the lease remains valid. Emergency vehicles are ordered by server arrival time, then arrival event ID; conflicting emergency phases are served in that order. A waiting emergency creates one `EMERGENCY_STALE` audit alert after 60 seconds and stays active until its matching clearance event.

Manual commands, sensor events, and simulator controls remain unprotected assessment endpoints. Do not expose them to an untrusted network.

See the root [README](../README.md) for the end-to-end dashboard and demo instructions, and [docs/API.md](../docs/API.md) for the REST request/response contract.
