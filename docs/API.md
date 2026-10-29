# REST API reference

The API base path is `/api`. JSON request bodies use strict validation. Timestamps are ISO 8601. Errors have the form `{"error":{"code":"...","message":"..."}}`; validation failures may include `details`.

## Read endpoints

| Method and path | Description |
| --- | --- |
| `GET /api/health` | Database health. |
| `GET /api/junctions` | Junction IDs and configuration summaries. |
| `GET /api/junctions/:id` | Junction configuration and creation time. |
| `GET /api/junctions/:id/status` | Runtime, desired and observed signal vectors, controller trust, queues, sequence cursors, weighted phase scores, next phase, manual lease, pending command, and active alerts. |
| `GET /api/junctions/:id/history?limit=30&cursor=...` | Newest audit events first. `limit` is 1–100 (default 50); `next_cursor` can be passed as `cursor` to fetch older records. |
| `GET /api/simulators/:id` | Current simulator state and ACK behavior. |

`POST /api/junctions` creates a junction with the standard four-direction, two-phase configuration, safe all-red desired state, and an online REST simulator. The backend immediately requests a full controller snapshot before traffic can be scheduled. Payload: `{"id":"B"}`. IDs are 1–64 letters, numbers, underscores, or hyphens and must be unique. Creation returns `201`; invalid payloads return `400`; duplicate IDs return `409`.

History responses contain `events` with `id`, `kind`, `correlation_id`, `occurred_at`, and `payload`, plus a nullable `next_cursor`. A cursor must identify an event belonging to the requested junction.

## Sensor events

`POST /api/sensor-events` accepts arrivals and clearances. Event IDs are idempotent; per-direction sequence numbers must increase.

Arrival:

```json
{
  "event_id": "arrival-0001",
  "junction_id": "A",
  "direction": "NORTH",
  "event_type": "VEHICLE_ARRIVED",
  "vehicle_id": "TRK-204",
  "vehicle_type": "TRUCK",
  "sequence_no": 1,
  "timestamp": "2026-10-29T08:15:20Z"
}
```

Clearance uses the same common fields and `event_type: "VEHICLE_CLEARED"`; it includes `vehicle_id` and omits `vehicle_type`.

## Operator commands

`POST /api/junctions/:id/commands` accepts one of:

```json
{"command_type":"MANUAL_GREEN_REQUEST","direction":"WEST"}
```

```json
{"command_type":"RETURN_TO_AUTOMATIC"}
```

Manual requests renew a 120-second lease. They create target intents; the backend still controls all signal transitions. The endpoint is unprotected in this assessment demo.

## Simulator controls

`PATCH /api/simulators/:id` accepts any non-empty subset of:

```json
{
  "health": "OFFLINE",
  "automatic_ack": true,
  "ack_delay_ms": 1500,
  "next_ack_behavior": "DROP"
}
```

`health` is `ONLINE` or `OFFLINE`. `next_ack_behavior` is `NORMAL`, `DROP`, `DUPLICATE`, or `MISMATCH`. Setting health to `ONLINE` requests a fresh snapshot. These controls are unprotected and intended only for local demonstration.

## Controller events

`POST /api/controller-events` is used by the simulator and accepts `COMMAND_ACK`, `STATE_SNAPSHOT`, or `DEVICE_STATUS`. ACK and snapshot events include a complete `actual_signals` object with `NORTH`, `SOUTH`, `EAST`, and `WEST` colors. A command ACK also includes `command_id`. Device status includes `status: "ONLINE" | "OFFLINE"`; `device_type` can be `CONTROLLER`, `SENSOR`, or `SIGNAL_CONTROLLER` (default `CONTROLLER`). A signal controller report must include a direction. Sensor and signal health are persisted, audited, and exposed by the status endpoint. Taking a signal controller offline locks the runtime into degraded/unknown state; reporting it online requests a fresh snapshot before safe operation resumes.
