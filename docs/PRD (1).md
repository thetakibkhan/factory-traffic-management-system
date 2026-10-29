---
title: "Factory Traffic Management System"
subtitle: "Backend Developer Intern Assessment — Implementation-Ready Product Requirements Document"
author: "Engineering design proposal based on CSI Smart Tech Assessment V2"
date: "29 October 2026"
version: "1.0"
status: "Proposed implementation baseline"
geometry: margin=0.82in
fontsize: 10pt
colorlinks: true
---

# 1. Executive Summary

Build a **small event-driven factory traffic-control system** for internal roads at a garment factory. It receives vehicle arrival/clearance events, tracks per-direction queues, selects safe green phases, accepts administrator requests, prioritizes emergency vehicles, simulates controller acknowledgements and failures, persists relevant state, and exposes a functional live-updating dashboard.

**Primary objective:** demonstrate backend correctness, traffic safety, separation of concerns, recoverability, and explainable engineering decisions. This is **not** merely a CRUD application.

**Assessment constraint:** the original assessment expects roughly **4–5 hours** and explicitly does **not** require every feature. The chosen design is **comprehensive (Q1 = C)**, but delivery will use a strict vertical-slice order so a safe working core always exists. Incomplete features must be documented honestly.

**Decision baseline:** Q2 combines **ACK-gated safety (B)** with a **simulated REST controller using the same safety engine (C)**; Q3 uses **weighted, starvation-aware automatic scheduling (C)**. All other open questions are resolved in `decisions.md`.

## 1.1 Requirements provenance and precedence

- **Assessment requirements** are derived from *Factory Traffic Management System - Backend Developer Intern Assessment V2*, CSI Smart Tech, pp. 1–9 (provided PDF).
- **Design decisions / numeric policies** (e.g., 2-second ALL_RED, ACK timeout, scheduling weights) are *our recommended assumptions*, **not** values mandated by the assessment.
- If reality conflicts with this PRD, **physical safety invariants take priority**. Record deviations and limitations in the README.
- This document describes a **prototype/simulation**, not a certified industrial traffic-light controller. Real deployment would require independent hardware interlocks, controller-state verification, appropriate safety engineering and operational approval.

# 2. Goals, Non-Goals and Scope

## 2.1 Goals

1. Manage **Junction A** with directions NORTH, SOUTH, EAST, WEST and two compatible phases (NORTH+SOUTH and EAST+WEST).
2. Process vehicle events **idempotently**, reject invalid/stale-order changes, and maintain nonnegative, auditable queues.
3. Enforce a **deterministic state machine** for safe transitions and signal timing, including concurrent requests.
4. Schedule normal traffic fairly using **queue size + vehicle priority + waiting time + starvation protection**.
5. Handle emergency priority, manual override, controller ACKs, timeouts, device failure, and restart reconciliation.
6. Persist junction state, commands, event IDs, active vehicles, and audit history.
7. Supply REST APIs, a compact React dashboard, a runnable simulation and automated tests.
8. Keep domain rules independent of HTTP, the database ORM, the frontend, and any future MQTT adapter.

## 2.2 Scope tiers (build order, not permission to violate safety)

| Tier | Scope | Completion rule |
|:--|:--|:--|
| P0 — safety baseline | Junction A; phases/state machine; safe GREEN→YELLOW→ALL_RED→GREEN; simulator ACK-gating; arrival/clearance; dedup; persistence; basic APIs/tests | **Must work before expansion** |
| P1 — core assessment | Weighted scheduling; emergency/manual priority; concurrent intent handling; device failure/ACK timeout; restart reconciliation; audit history; functional dashboard; demo scenarios | Target for comprehensive submission |
| P2 — hardening | richer out-of-order handling, configurable junction policies, controller reconnect diagnostics, more edge-case tests, better UI alerts | Implement if core is stable |
| Bonus | MQTT, Redis, Kafka, Docker, SSE/WebSockets, auth, analytics, multi-junction deployment | **Not required**; avoid unless clearly justified |

The design supports *multiple junction identities* and data-driven phase configuration, but **only Junction A must be demonstrated**. No production authentication, cloud deployment, polished graphics, or real device is required by the assignment.

## 2.3 Actors

- **Sensor/simulator:** reports vehicle arrival and clearance with unique event IDs and monotonically increasing per-direction sequence numbers.
- **Traffic-control engine:** applies policies and emits safe controller commands.
- **Controller/simulator:** receives desired signal vectors; reports acknowledgements, observed states, and device status.
- **Factory administrator/evaluator:** observes conditions, requests manual target phases, returns to automatic, and triggers simulations.

# 3. Traffic Domain Rules

## 3.1 Junction model

Initial configuration:

```json
{
  "id": "A",
  "directions": ["NORTH", "SOUTH", "EAST", "WEST"],
  "phases": {
    "NORTH_SOUTH": ["NORTH", "SOUTH"],
    "EAST_WEST": ["EAST", "WEST"]
  },
  "timing": {
    "normalGreenSeconds": 30,
    "minimumGreenSeconds": 10,
    "yellowSeconds": 5,
    "allRedSeconds": 2,
    "ackTimeoutSeconds": 3
  }
}
```

Traffic signal states: `RED`, `YELLOW`, `GREEN`. Internal stages: `STARTUP_RECONCILIATION`, `ALL_RED`, `NORTH_SOUTH_GREEN`, `NORTH_SOUTH_YELLOW`, `EAST_WEST_GREEN`, `EAST_WEST_YELLOW`, `FAULT_LOCKOUT`. Modes: `AUTOMATIC`, `MANUAL`, `EMERGENCY`, `DEGRADED`. `phase` and `stage` are distinct from `mode`.

**Hard invariants (always enforced by the backend):**

- Never command conflicting phases GREEN simultaneously.
- Never command a conflicting GREEN before every signal of the outgoing phase is **freshly confirmed RED** and the ALL_RED clearance period finishes.
- Never skip YELLOW or ALL_RED because of a manual or emergency request.
- Never treat a sent command, expired timer, old ACK, or persisted last-known state as proof of present physical state.
- Never create a negative queue or apply the same `event_id` twice.
- At most **one active controller transition** per junction; state changes are serialized and versioned.
- In failure/unknown-state conditions, **do not issue a new GREEN**. Alert the operator and require reconciliation.

> Safety scope: `actual_signals` means **controller-reported/acknowledged**, not independently measured lamp state. A software prototype cannot guarantee physical road safety if the device lies or is unreachable; that requires hardware-level safeguards.

## 3.2 Safe state machine

```text
STARTUP_RECONCILIATION
          | fresh controller snapshot + safe reconciliation
          v
        ALL_RED  <-------------------------------------+
          |   (confirmed for >= 2 seconds)            |
          v                                            |
  NORTH_SOUTH_GREEN  -- phase change request -->  NORTH_SOUTH_YELLOW
          ^                                            |
          |                                5 s after confirmed YELLOW
          |                                            |
          +--------------- ALL_RED <--- confirmed outgoing RED

        ALL_RED -> EAST_WEST_GREEN -> EAST_WEST_YELLOW -> ALL_RED

Any unknown/mismatched controller state or unsafe failure -> FAULT_LOCKOUT
FAULT_LOCKOUT -> fresh, verified reconciliation -> ALL_RED
```

**Precisely ordered phase switch (N/S to E/W):**

1. Serial engine accepts a *target phase intent*, not direct arbitrary colors.
2. Persist intended state vector and uniquely identified controller command, then dispatch from command/outbox table.
3. Request N/S `YELLOW`, keep E/W `RED`; wait until controller ACK supplies the correct **whole-junction actual state**.
4. Start **5-second yellow timer from confirmation**, not from request time.
5. Request all four `RED`; require fresh positive controller confirmation that **all four are RED**.
6. Start **2-second all-red clearance interval from that confirmation**.
7. Re-evaluate the highest-priority target at the ALL_RED boundary; request only that compatible phase GREEN and the other RED.
8. Require ACK of resulting actual state; start 30-second normal GREEN duration on confirmation.
9. A command timeout/mismatch interrupts advancement, enters `DEGRADED`/`FAULT_LOCKOUT`, and blocks future GREEN until reconciled.

**Simulation adapter:** automatic ACK is allowed **as a configurable simulation mode**, delivered through the same controller event processor. The engine never bypasses ACK requirements merely because the simulator is used. A test toggle can delay, drop, duplicate, or mismatch acknowledgements. The simulator must persist its **own controller-reported current state** (separate from backend `desired_signals`) so a restart snapshot does not merely echo the backend's desired state.

**Timers:** use non-blocking scheduled deadlines, persisted `stage_started_at`/`stage_deadline_at`, and a single per-junction processor; do not call blocking `sleep()` in HTTP request handlers. Timers carry a state version/token so a stale timer cannot advance a newer state.

# 4. Sensor Events, Queues, and Ordering

## 4.1 Input contract

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

`VEHICLE_CLEARED` has the same identifiers and direction, omits `vehicle_type`, and uses a greater `sequence_no`. Vehicle types: `EMERGENCY`, `TRUCK`, `FORKLIFT`, `EMPLOYEE_VEHICLE`. Priorities: `EMERGENCY > TRUCK > FORKLIFT > EMPLOYEE_VEHICLE`.

## 4.2 Event handling policy

1. Validate payload schema, registered junction and direction, event type, vehicle type, ISO timestamp, and positive integer `sequence_no`. Unknown fields may be ignored or rejected consistently; preferred implementation uses strict validation of documented fields.
2. Normalize values and insert event record under **unique (`junction_id`, `event_id`) constraint**.
3. If that ID already exists with identical canonical payload, return successful **duplicate/no-op**; if same ID has different payload, return `409 EVENT_ID_CONFLICT`.
4. Treat **`sequence_no` as authoritative ordering per (`junction_id`, `direction`)**; reject/log older or equal unseen sequence numbers as `409 STALE_SEQUENCE`. Duplicate-ID check happens first.
5. Use **server receipt time** for waiting and scheduling; preserve sensor timestamp for audit/diagnostics. Significant timestamp skew produces an alert, not a silent change in queue priority.
6. On ARRIVED, create one active waiting record for (`junction_id`, `vehicle_id`); if already waiting, reject/log a conflicting repeated arrival rather than double counting.
7. On CLEARED, mark the corresponding active vehicle cleared exactly once; if no matching active arrival exists, return/log `422 UNMATCHED_CLEARANCE` and do not decrement.
8. Verify the clearance direction agrees with the active vehicle's direction.
9. Record accepted/rejected/duplicate events in history. Ensure queue count can never be below zero.

**Sensor assumption:** sequence numbers are monotonic **within each junction+direction**. A multi-sensor installation would need a `sensor_id` and a per-sensor cursor or a central sequencer. For the assignment, the simulator generates the required sequence correctly. Gaps are allowed; lower late sequences are rejected to avoid replay-driven state changes. This is a documented trade-off (late valid arrivals might be ignored).

Queues are **derived** from active vehicle rows. Expose counts plus priority/oldest wait. Do not trust counts submitted by the frontend. Avoid separately mutable count columns unless updated transactionally and reconciled.

# 5. Automatic Scheduling Policy

## 5.1 Deterministic scoring

The engine only chooses between the two **compatible phases**. **Emergency requests bypass normal scores**; manual mode overrides normal scores but does not bypass transitions.

For a phase `p` at scheduling time:

```text
base(p) = sum(weight(vehicle_type) for all waiting vehicles in p)
weights: EMPLOYEE_VEHICLE=1, FORKLIFT=2, TRUCK=4
age_bonus(p) = min(floor(oldest_wait_seconds(p) / 15), 8)
score(p) = base(p) + age_bonus(p)
starved(p) = oldest_wait_seconds(p) >= 90
```

- **NORMAL GREEN ~30 seconds** after controller-confirmed activation; normally re-evaluate after 30 seconds.
- **Minimum GREEN = 10 seconds** for automatic non-emergency requests, preventing oscillation; emergency/manual may begin safe preemption immediately.
- At a normal decision point, select any nonempty phase with `starved=true` **before** comparing scores. If both starved, select the one with the older waiting vehicle (tie: configured phase order).
- Otherwise select higher `score`; on tie **retain current phase** to avoid switching; if neither has a queue, transition to ALL_RED after normal green completion.
- If the current phase has no waiting vehicles and the opposite has vehicles, transition after minimum green rather than waiting the whole 30 seconds.
- If the current phase continues to win, retain GREEN and re-evaluate every 5 seconds (do **not** flicker to yellow merely to restart a timer); the 90-second threshold serves as a normal-traffic fairness target.
- Waiting-time targets are **not guaranteed** during emergencies, failures or controller delays. Audit when the target is exceeded.

**Example:** 8 NORTH employee vehicles + 2 SOUTH forklifts = base 12; 2 EAST trucks + 1 WEST employee = base 9. With similar wait times, N/S wins. If E/W waits long enough, aging and the 90-second starvation rule can make it win.

## 5.2 No direct phase manipulation

API clients only submit `MANUAL_GREEN_REQUEST`, `RETURN_TO_AUTOMATIC`, arrival/clearance events, or controller reports. A policy decision yields a **target phase intent**; the state machine alone converts it into safe physical commands.

# 6. Emergency and Manual Priority

## 6.1 Priority ordering

`SAFETY/FAULT_LOCKOUT > EMERGENCY > MANUAL > AUTOMATIC`.

“Higher priority” means it chooses the **next safely achievable target**, never that the signal jumps immediately to GREEN.

## 6.2 Emergency policy

- An accepted `EMERGENCY` vehicle arrival creates an active emergency intent based on the vehicle's phase.
- When a conflicting phase is GREEN, immediately **start its safe YELLOW → ALL_RED sequence** (subject to valid controller confirmations).
- Several emergencies in the **same phase** share the next GREEN and clear individually.
- For simultaneous **conflicting** emergencies, choose the phase of the **earliest server-received active emergency**; ties are resolved deterministically by event ID, then phase order. Once the phase has been served, the conflicting emergency becomes next, after safe clearance.
- An emergency arriving during YELLOW/ALL_RED may change the **next target** at the next safe boundary. If GREEN was already dispatched to another phase, do not assume that command can be cancelled; confirm/reconcile then safely preempt.
- `VEHICLE_CLEARED` for an emergency releases its intent. No automatic clearance solely because 60 seconds elapsed: after **60 seconds without progress**, raise `EMERGENCY_STALE` alert for operator investigation, but do not silently discard a possibly real vehicle.
- When all emergencies clear, return to still-valid manual override or automatic mode via normal safe sequencing.
- Repeated emergency event IDs are no-ops. Emergency conflicts and preemptions are auditable.

## 6.3 Manual control policy

- `MANUAL_GREEN_REQUEST` names a direction; the backend maps to its compatible phase and queues a **target intent**.
- Manual mode supersedes automatic scoring, **not** emergency or safety interlocks.
- Manual override has a **2-minute lease**, measured from acceptance. Each accepted new manual request replaces/renews the lease. Expiry returns to automatic **through safe state-machine scheduling**; it does not force an instantaneous phase change.
- Concurrent manual requests are serialized by the per-junction engine; **latest accepted intent wins**, but no already-sent physical command is presumed cancelled. Intent revisions are versioned and recorded.
- During emergency, manual intent may remain stored but is suspended; it resumes only if its lease has not expired.
- Admin disconnect is irrelevant to an already accepted time-limited lease. `RETURN_TO_AUTOMATIC` revokes it explicitly.
- Authentication is not required for the assessment; label the demo controls as **unprotected** and do not present them as production-ready.

# 7. Controller Communication and Failure Policy

## 7.1 Separation of desired and actual state

- `desired_signals`: latest requested complete signal vector; never claimed as physically true.
- `actual_signals`: **fresh controller-reported** complete vector, with confirmation timestamp and matching `command_id` / state version.
- `physical_state_trust`: `CONFIRMED`, `STALE`, `UNKNOWN`, or `MISMATCH`.
- Persist **controller command** (unique ID, junction, vector, status, attempt, created/deadline/version) before dispatch. Match ACK to command; duplicate ACK is idempotent.

**Recommended adapter port:**

```ts
interface ControllerPort {
  dispatch(command: SignalVectorCommand): Promise<void>;
  requestSnapshot(junctionId: string): Promise<void>;
}
```

`RESTSimulatorAdapter` implements the port today; a future `MQTTAdapter` can implement it without importing transport types into the traffic engine.

## 7.2 Failure matrix

| Condition | Required behavior |
|:--|:--|
| Positive ACK for current command and expected vector | Mark confirmed; advance the state machine if timing guards pass |
| Duplicate ACK | Idempotent no-op, log as duplicate |
| Late ACK for superseded command | Archive it; do not overwrite current confirmed state without a fresh full snapshot |
| Missing ACK after **3 seconds** | Mark timeout; retry **same command ID** once only if adapter supports idempotent execution; otherwise no blind retry; enter `DEGRADED` if unconfirmed |
| Controller OFFLINE / unknown physical state | Stop issuing GREEN; mark reported state unknown; raise critical alert |
| Desired/actual mismatch | Enter `DEGRADED` and require reconciliation before further GREEN |
| Sensor OFFLINE | Alert; do not fabricate queue changes; retain existing safe phase until a safe conservative operation/recovery decision is possible |
| Controller reconnect | Request fresh complete actual-state snapshot; reconcile; do not trust prior persisted ACK blindly |
| Backend crash during transition | Enter startup reconciliation; invalidate old timers; confirm fresh device state before proceeding |

A **simulator** may auto-ACK, deliberately withhold ACK, report mismatches, or go offline. **In real hardware, software cannot prove a dark/unreachable signal is RED**. This system must not claim safe field operation without hardwired fail-safe behavior and independent validation.

## 7.3 Restart/recovery algorithm

1. Load persisted junction config, mode, active vehicles/events, runtime state/version, outstanding controller commands, and audit history.
2. Force logical stage `STARTUP_RECONCILIATION` / mode `DEGRADED` until a **fresh controller status snapshot** arrives; mark previously persisted `actual_signals` as stale.
3. Block scheduling or issuing new GREEN while actual state is unknown.
4. With confirmed all-red: wait full configured clearance (2 seconds), restore priority intents and resume safely.
5. With confirmed GREEN or YELLOW: request safe phase shutdown via controlled YELLOW (if GREEN), then RED; wait for confirmations and the full required durations; do **not** jump directly to conflicting GREEN.
6. If the controller cannot be reconciled, stay in `FAULT_LOCKOUT` and surface explicit operator recovery instructions.
7. Recover pending outbox items idempotently only after inspecting command IDs/status and the fresh controller snapshot; **never blindly replay a pending GREEN**.

# 8. Concurrency, Consistency and Persistence

## 8.1 Execution model

- One application instance for the demo, with a **serialized event/command processor per junction**. Process sensor events, timers, admin intents and controller ACKs through this processor.
- Use database transactions for sensor-event deduplication, vehicle updates, sequence cursors, audit entries, and desired-state + outbox-command creation.
- Use a monotonic `junction_runtime_state.version` optimistic guard so stale timer callbacks and writes cannot advance a newer state.
- External command dispatch happens **after transaction commit**, not within a database transaction; a durable `controller_commands`/outbox table enables retry/recovery.
- Explicit **non-goal:** claiming multi-instance/distributed mutual exclusion. If horizontally scaled, use database/advisory locks or a distributed per-junction ownership mechanism before deployment.

## 8.2 Proposed PostgreSQL + Prisma model

| Table | Essential fields / constraints |
|:--|:--|
| `junctions` | `id PK`, JSON phase/timing config, `created_at` |
| `junction_runtime` | `junction_id PK/FK`, `mode`, `stage`, `phase`, `target_phase`, `version`, `desired_signals JSON`, `actual_signals JSON`, `actual_observed_at`, `stage_started_at`, `stage_deadline_at`, `manual_expires_at`, `controller_health` |
| `vehicles` | `id PK`, `junction_id`, `vehicle_id`, `direction`, `type`, `status`, `arrived_at_server`, `cleared_at_server`; one active waiting vehicle per `(junction_id, vehicle_id)` |
| `sensor_events` | `junction_id`, `event_id`, canonical payload hash, direction, sequence, sensor timestamp, receive timestamp, result; `UNIQUE(junction_id,event_id)` |
| `direction_cursors` | `junction_id`, `direction`, `last_sequence`; unique composite key |
| `controller_commands` | `command_id PK`, `junction_id`, full desired vector, runtime version, `status`, attempts, timeout/deadline, sent/acked timestamps |
| `controller_events` | `id PK`, `command_id nullable`, junction, reported vector/status, received timestamp, dedup key |
| `audit_events` | `id PK`, junction, kind, payload JSON, correlation IDs, timestamp; chronological index |
| `device_status` | junction, device type/optional direction, status, last_seen, issue code |

Migrations must seed Junction A and default policy. Use a real database (not an unpersisted in-memory queue). Queue counts are derived from `vehicles WHERE status='WAITING'`.

**Recovery limits to disclose:** process-local timers and command processors do not survive crashes; their state is reconstructed from persisted deadlines and fresh controller snapshots. The simulator's reported state must remain separately persisted across application restarts. PostgreSQL persistence alone does not establish physical signal safety.

# 9. REST API Contract

Base URL `/api`. All timestamps are ISO 8601 UTC. Errors use a consistent shape:

```json
{
  "error": {
    "code": "STALE_SEQUENCE",
    "message": "Sequence is older than the last accepted event",
    "details": { "last_sequence": 1502 }
  }
}
```

| Method + path | Behavior | Success / key errors |
|:--|:--|:--|
| `GET /junctions` | List junction configuration and summary | `200` |
| `GET /junctions/:id` | Junction config/details | `200`, `404` |
| `POST /junctions` | Create configured junction | `201`, `400`, `409` |
| `POST /sensor-events` | Validate/record ARRIVED or CLEARED | `201` accepted, `200` duplicate, `400/404/409/422` |
| `GET /junctions/:id/status` | Mode, phase, stage, desired/actual vectors, freshness, queues, controller, alerts | `200`, `404` |
| `POST /junctions/:id/commands` | Request `MANUAL_GREEN_REQUEST` or `RETURN_TO_AUTOMATIC` | `202`, `400/404/409` |
| `POST /controller-events` | Controller `COMMAND_ACK`, `DEVICE_STATUS`, or `STATE_SNAPSHOT` simulation | `202`, `400/404/409` |
| `GET /junctions/:id/history?limit=50&cursor=...` | Recent audit records; newest first | `200`, `404` |

**Compatibility note:** the assessment's example controller ACK uses `actual_state` for one direction. This implementation prefers a **full-junction `actual_signals` snapshot** for safe clearance verification. If per-direction ACKs are accepted, the engine must gather a complete fresh consistent snapshot before any conflicting GREEN. Document this API refinement in README.

## 9.1 Important request/response examples

Manual command:

```http
POST /api/junctions/A/commands
Content-Type: application/json

{"command":"MANUAL_GREEN_REQUEST","direction":"WEST"}
```

```json
{
  "accepted": true,
  "intent_id": "intent-uuid",
  "mode": "MANUAL",
  "requested_phase": "EAST_WEST",
  "status": "PENDING_SAFE_TRANSITION"
}
```

Controller command (internal outgoing adapter message):

```json
{
  "command_id": "cmd-uuid",
  "junction_id": "A",
  "desired_signals": {"NORTH":"RED","SOUTH":"RED","EAST":"GREEN","WEST":"GREEN"},
  "runtime_version": 28
}
```

Controller event used by simulator:

```json
{
  "event_id": "ack-uuid",
  "event_type": "COMMAND_ACK",
  "command_id": "cmd-uuid",
  "junction_id": "A",
  "status": "ACK",
  "actual_signals": {"NORTH":"RED","SOUTH":"RED","EAST":"GREEN","WEST":"GREEN"},
  "timestamp": "2026-10-29T08:15:45Z"
}
```

Junction status response (illustrative):

```json
{
  "junction_id": "A",
  "mode": "AUTOMATIC",
  "stage": "NORTH_SOUTH_GREEN",
  "phase": "NORTH_SOUTH",
  "desired_signals": {"NORTH":"GREEN","SOUTH":"GREEN","EAST":"RED","WEST":"RED"},
  "actual_signals": {"NORTH":"GREEN","SOUTH":"GREEN","EAST":"RED","WEST":"RED"},
  "physical_state_trust": "CONFIRMED",
  "controller_status": "ONLINE",
  "queues": {"NORTH":3,"SOUTH":1,"EAST":7,"WEST":2},
  "pending_command": null,
  "alerts": []
}
```

`GET /history` must include **why** a decision was made: trigger/correlation ID, prior/next state, policy score or manual/emergency cause, controller command and ACK/timeout.

# 10. Frontend Product Requirements

**Tech:** React + Vite + TypeScript. Prioritize functionality over visual polish. Dashboard state is always read from backend; frontend is not a competing traffic engine.

## 10.1 Required views

1. **Overview:** Junction A card with current phase, mode, controller health, emergency/failure badges, queue sizes and four color indicators.
2. **Junction detail:** 4-way intersection view; current phase/stage; desired versus actual signals; last confirmed timestamp; pending command and lease/deadline; active alerts.
3. **Simulation panel:** create arrival/clearance, choose direction/type/vehicle ID, simulate emergency, simulate controller online/offline and ACK/delay/drop/mismatch.
4. **Admin control:** request manual green by direction; clear manual/return to automatic; clearly show override/expiry and emergency preemption.
5. **Recent activity:** newest audit events with simple type/time/reason; optional filtering.

## 10.2 Updating and UI behavior

- Poll `GET /junctions/A/status` **every 1 second** and history every **3 seconds**; no websocket is needed for demo.
- Disable or label commands appropriately when mode is `DEGRADED`; explain why requested control was refused or queued.
- Show loading, connection loss, invalid input, API errors, delayed ACK, state mismatch and unknown reported state without crashing.
- Display requested versus observed states distinctly; never color a lamp GREEN solely on an unacknowledged desired state. Mark observation stale/unknown in a visibly different way.
- No frontend-generated phase transition timers; display backend-provided stage/deadline only.

# 11. Architecture and Repository Layout

```text
factory-traffic-management/
  backend/
    prisma/schema.prisma
    prisma/migrations/
    src/
      api/routes/                     # HTTP validation + responses
      application/commands/           # use cases, event processing, transactions
      domain/traffic/                 # pure state machine, safety guards, scoring
      domain/types/                   # junction/signal/vehicle types
      infrastructure/db/              # Prisma repositories and outbox
      infrastructure/controllers/     # ControllerPort + REST simulator
      infrastructure/scheduler/       # non-blocking deadlines and dispatch loop
      index.ts
    tests/{unit,integration,scenarios}/
  frontend/
    src/{components,pages,api,hooks}/
  docs/
    PRD.md
    decisions.md
  README.md
  .env.example
```

**Core dependency rule:** `domain` imports **no** Express, Prisma, React, MQTT or `setTimeout()` APIs. Application services orchestrate domain decisions and repository/controller ports. HTTP only translates input/output.

**Delivery stack:** Node.js + TypeScript + Express; PostgreSQL + Prisma; React + Vite; Vitest + Supertest; Zod for validation. Docker Compose is an optional convenience, not a gate to running the demo. No Redis/Kafka/microservices.

# 12. Acceptance Criteria and Test Matrix

| ID | Scenario and setup | Expected observable result |
|:--|:--|:--|
| AC-01 | N/S is GREEN; E/W selected next | N/S confirmed YELLOW >=5s → ALL_RED confirmed >=2s → E/W GREEN; never overlapping conflicting GREEN |
| AC-02 | Mixed direction arrivals | Queue counts match unique active vehicles; selection follows documented score and timing |
| AC-03 | Truck vs employee traffic | Vehicle-type weight changes phase score predictably |
| AC-04 | Normal queue waits beyond 90s | Starved phase chosen at next safe scheduling opportunity, except documented higher-priority/failure conditions |
| AC-05 | EAST emergency during N/S GREEN | Begin safe preemption immediately; no direct conflicting GREEN |
| AC-06 | Simultaneous opposing emergencies | Deterministic first-served policy, then safe service of remaining emergency |
| AC-07 | Manual WEST command while N/S GREEN | Accepted intent; transitions safely; eventual E/W GREEN; manual expiry/return works |
| AC-08 | Emergency during manual control | Emergency wins; manual can resume only if lease remains valid |
| AC-09 | Submit same event ID/payload twice | Queue changes exactly once; duplicate response is a no-op |
| AC-10 | Same ID, changed payload; old sequence; missing clearance | Appropriate 409/422; queue unchanged; rejection appears in audit |
| AC-11 | Vehicle arrives then clears | Active queue increments once and decrements once, never negative |
| AC-12 | Controller ACK dropped/offline/mismatch | No conflicting GREEN; `DEGRADED`/lockout plus alert, desired and actual remain distinct |
| AC-13 | Delayed/duplicate ACK | No stale overwrite or duplicate state transition |
| AC-14 | Kill/restart service while transition pending | Persisted data/history survives; state reconciliation required before new GREEN |
| AC-15 | Truck, emergency, manual command, duplicate event and ACK arrive within milliseconds | Per-junction decisions serialize; event record consistent; never conflicting GREEN |
| AC-16 | Request for unknown junction/invalid enum | 404/400 with structured error; no state mutation |
| AC-17 | Controller is unavailable to dashboard | Clear degraded warning; frontend does not falsely show desired as confirmed |
| AC-18 | Domain unit tests without HTTP/DB | Pure scoring, transitions, safety guards and tie-breaking tested independently |
| AC-19 | No queued vehicles after active phase | Junction eventually enters confirmed ALL_RED safely; no continuous useless switching |
| AC-20 | Replay pending GREEN after server restart | Forbidden without fresh reconciliation/safe guard; no unsafe automatic replay |

**Testing guidance:** use an injectable/fake clock and scripted controller adapter to test 5s/2s transitions quickly and deterministically. Cover transition guards/property-style invalid-command tests, API integration tests, persistence restart tests, and concurrency bursts. **Do not** rely only on screenshots of the dashboard.

# 13. Evaluator Demo Script

1. Start PostgreSQL, run migrations and seed Junction A; start backend and frontend (`README` contains actual commands once implemented).
2. Verify status starts in reconciliation and becomes **confirmed ALL_RED** after a simulator snapshot, then is ready for traffic.
3. Submit 8 employee vehicles N, 2 forklifts S, 2 trucks E, 1 employee W; show queue counts, weighted scores and next phase.
4. Show GREEN→YELLOW (5 seconds)→ALL_RED (2 seconds)→GREEN with controller ACKs recorded.
5. Submit EAST emergency during N/S GREEN; demonstrate safe preemption, not an instant conflicting green.
6. Request manual WEST; show queued intent, override mode and return to automatic. Optionally show emergency temporarily superseding manual.
7. Resubmit an identical arrival; prove idempotency. Send clearance; prove correct decrement.
8. Drop an ACK or mark controller OFFLINE; demonstrate desired/actual mismatch, critical alert and blocked GREEN.
9. Reconnect/snapshot; demonstrate explicit reconciliation. Restart backend during a transition and show retained history and safe recovery.
10. Trigger simultaneous conflicting requests and show serialized, safe audit history.

**If some P1/P2 item is incomplete, declare it in README rather than fabricating a demo.**

# 14. Delivery Artifacts and README Checklist

Submit:

1. Backend source code.
2. Frontend source code.
3. `README.md` with prerequisites, `.env` example, commands to install/migrate/seed/start/test, architecture, demo and known limits.
4. Prisma schema + migrations.
5. API specification or Postman collection.
6. Short scheduling algorithm explanation (weights, aging, starvation, ties).
7. Safe transition/state machine explanation (ACK gating, timers, fault behavior).
8. Demonstration instructions for the major scenarios.
9. Tests and an honest list of what was tested.
10. **Exactly titled README section:** `Assumptions / Questions / Requirement Issues` — identify contradictions/unknowns and adopted policies.
11. Major architectural decisions / trade-offs (link to `docs/decisions.md`).
12. **Exactly titled README section:** `AI / Tool Usage` — tools used, scope of their help, and responsibility for understanding.
13. Outstanding work, priorities and what would be built with more time.

**Suggested README disclosure:** this is a **simulation**, not field-ready industrial safety software; controller ACKs represent device reports, not independent physical-light validation.

# 15. Recommended Implementation Sequence

These phases are a **sequence**, not a promise that all comprehensive scope fits the assessment's 4–5 hours.

1. **Skeleton & persistence:** TypeScript backend, Prisma migrations, seed Junction A, domain types, health/status API.
2. **Pure safety engine:** phases, transition guards, fake clock tests, all-red/YELLOW timing; reject unsafe direct states.
3. **Controller loop:** outbox commands, REST simulator, ACK handling, mismatch/timeout lockout.
4. **Sensor queues:** ARRIVED/CLEARED, unique event IDs, sequence guards, vehicle rows, audit.
5. **Scheduler & priorities:** weighted + aging, 90-second fairness, emergency/manual lease, state-version concurrency.
6. **Restart recovery & hardening:** fresh snapshot, controller reconnect, pending commands, adverse tests.
7. **Dashboard & demo:** status polling, intersection view, simulation/manual panel, alerts, recent history.
8. **Submission check:** API docs, README required headings, demo checklist, test output and incomplete-feature disclosure.

**Cut order if time becomes scarce:** drop analytics and optional tooling first; simplify UI polish and optional device-failure variants; never remove safe state transitions, command/state separation, idempotency, or honest failure behavior.

# 16. Open Risks, Assumptions and Assessment Gaps

| Issue in assessment / deployment reality | Chosen resolution / residual risk |
|:--|:--|
| ALL_RED interval not specified | Assume **2 seconds**, configurable; not an industrial-standard claim |
| Whether controller ACK verifies physical lamps | Treat it as controller-reported state only; actual lamp proof is out of scope |
| Sequence numbering scope not specified | Per-junction+direction monotonic; future `sensor_id` for multiple sensors |
| Sensor clocks may differ | Server-received time for scheduling; sensor timestamp for audit |
| Exact scoring weights not given | 1/2/4 + aging; hard 90s normal-traffic fairness preference |
| Manual control duration and conflicts unspecified | 2-minute lease, last accepted manual intent wins safely, emergency suspends |
| Conflicting emergencies unspecified | Earliest server-received emergency phase first; remaining emergency next |
| Emergency timeout ambiguous | 60s stale alert, no blind automatic removal |
| Controller ACK timeout/retry unspecified | 3s timeout; one same-ID idempotent retry where supported; else lockout |
| Controller crash/restart uncertainty | Fresh controller snapshot, reconcile and confirm safe path before GREEN |
| Sensor/controller OFFLINE semantics | No fake clearances; conservative lockout when actual signal state is not trustworthy |
| Controller event payload varies from example | Prefer whole-junction vectors; document any per-direction compatibility handling |
| Formal hardware safety guarantees unavailable | Prototype only, independent controller/hardware safety required in production |
| Multi-node deployment/concurrency | One demo process + per-junction serialization, optimistic version; scaling needs distributed ownership |
| Time-box versus comprehensive scope | Safety-first milestones with explicit incomplete-feature disclosure |

# 17. Definition of Done

A submission is **ready for technical review** when: a reviewer can run it from README, call required APIs, inspect dashboard state, demonstrate the nine assessment scenarios as implemented, inspect a durable audit trail, restart without trusting old physical state, and run tests proving no conflicting GREEN for normal/emergency/manual/failure/concurrent cases. Any unimplemented scenario must be explicitly identified, with expected safe behavior and a next-step plan.

**Companion design record:** [`decisions.md`](decisions.md). Every numeric rule or ambiguous policy above is an engineering assumption and may be changed if tests or reviewer feedback identify a safer alternative.

---

*Source: CSI Smart Tech, “Factory Traffic Management System - Backend Developer Intern Assessment V2,” 9 pages, provided by the user. This PRD is an engineering proposal derived from that source, not a claim that the assessment mandates all chosen implementation details.*
