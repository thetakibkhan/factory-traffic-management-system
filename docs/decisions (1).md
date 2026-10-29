# Architecture & Product Decisions

**Project:** Factory Traffic Management System — CSI Smart Tech Backend Developer Intern Assessment V2  
**Date:** 29 October 2026  
**Status:** Proposed decisions accepted for PRD v1.0  
**Companion:** [PRD.md](PRD.md)

## How to use this log

- **Assessment** means the supplied nine-page V2 assignment asks for the capability or constraint.
- **Decision** means our selected implementation policy where the assignment leaves flexibility or ambiguity.
- **Rationale** explains why, including safety, cost, testability, or scope considerations.
- **Trade-off / revisit** makes limitations explicit so these are not mistaken for mandatory assessment values.
- Only the **first scope decision (Q1 = C)** was expressly selected by the candidate. **Q2 and Q3 are the assistant's recommendations accepted for this planning exercise at the candidate's request**; Q4–Q30 are similarly recommended defaults, not independently confirmed user selections. The requested instruction is to take all recommendations as the answers.

## Quick decision index

| ID | Design question | Decision |
|:--|:--|:--|
| Q01 | How broad is MVP? | Comprehensive design, safety-first implementation milestones |
| Q02 | How are safe transitions verified? | ACK-gated engine (B) + simulator/hardware adapters (C) |
| Q03 | How do we choose normal traffic? | Weighted scoring + aging + starvation override (C) |
| Q04 | Which language and frameworks? | Node.js/TypeScript/Express + React/Vite |
| Q05 | Which database and ORM? | PostgreSQL + Prisma |
| Q06 | How many junctions? | Demonstrate A; reusable config/engine for others |
| Q07 | Which phases/conflicts? | N/S versus E/W only, mutually exclusive |
| Q08 | What are the transition durations? | GREEN 30s nominal, YELLOW 5s, ALL_RED 2s, auto minimum 10s |
| Q09 | What is the controller protocol? | REST simulator now, future MQTT adapter, no domain dependency |
| Q10 | Who owns state and timing? | Backend state machine and non-blocking scheduler |
| Q11 | How to detect duplicate events? | Unique `(junction_id,event_id)` and payload hash |
| Q12 | How do we handle event order/time? | Per-direction sequence authoritative; server receipt time for wait |
| Q13 | What is the queue source of truth? | Active persisted vehicle rows; derive counts |
| Q14 | What is normal-vehicle priority? | Employee 1, forklift 2, truck 4 |
| Q15 | How is starvation prevented? | Age bonus + 90s normal-traffic service preference |
| Q16 | What is emergency precedence? | Fault/safety > emergency > manual > automatic |
| Q17 | What if multiple emergencies conflict? | Oldest active server-received emergency phase first |
| Q18 | When does an emergency expire? | Vehicle clearance only; 60s stale alert, no silent expiry |
| Q19 | How long does manual mode last? | 2-minute lease; return command or expiry |
| Q20 | What if manual requests race? | Serialize; latest accepted intent wins, no bypassing in-flight commands |
| Q21 | What if controller ACK is missing? | 3s timeout, limited same-ID retry, lockout if unknown |
| Q22 | What does 'actual signal' mean? | Fresh controller-reported complete vector, not physical proof |
| Q23 | How is concurrency controlled? | Per-junction serial processor + DB transaction + state version |
| Q24 | How do controller commands survive failure? | Persist command/outbox before sending; idempotent dispatch |
| Q25 | What happens on restart? | Startup reconciliation; no GREEN until fresh trustworthy state |
| Q26 | How are APIs designed? | Required REST endpoints + structured errors + command-oriented writes |
| Q27 | How does the dashboard update? | 1s status polling and 3s activity polling |
| Q28 | How are failure and audit shown? | Durable cause-linked audit + clear desired/actual/unknown UI |
| Q29 | What testing is required? | Fake-clock pure unit tests, API/integration, concurrency and restart |
| Q30 | What is explicitly out of scope? | Real hardware safety claims, auth, multi-node, MQTT, polish |

---

## Decision records

### Q01 — Scope: comprehensive but safety-first

**Decision:** Choose **C**: design for the full major scenario set, but implement P0 safety invariants and testable end-to-end vertical slice before the P1 hardening/dashboards; optional bonuses last.  
**Rationale:** Candidate explicitly selected C. Assignment evaluates judgment and favors a partially complete but safe design over a feature-complete unsafe one (source §§1, 20–22).  
**Trade-off / revisit:** Comprehensive implementation may exceed the assessment's 4–5 hour expected effort. Do not pretend otherwise; note incomplete work honestly.

### Q02 — ACK-gated transition + interchangeable simulator

**Decision:** Combine **B + C**. A safe transition advances only when the controller's reported state confirms the expected vector; both REST simulator and future MQTT adapter use the exact same engine.  
**Rationale:** Timer-only transition assumes success and could cause simultaneous conflicting GREEN if an old GREEN never turned RED (source §§3, 9, 13).  
**Trade-off:** A simulated ACK is not independent proof of physical lamps. In real deployment an interlocked physical controller is essential.

### Q03 — Weighted, starvation-aware scheduling

**Decision:** **C**. `score = weighted vehicle count + capped age bonus`, with starvation precedence. Emergency traffic bypasses this normal scheduler.  
**Rationale:** Honors queue size, priority, wait time and the no-starvation requirement (§§4–6).  
**Trade-off:** Heuristic, not optimal operations research. Keep policy pure, logged, configurable, and testable.

### Q04 — Application stack

**Decision:** Node.js + TypeScript + Express backend; React + Vite + TypeScript frontend; Zod for validation; Vitest + Supertest for tests.  
**Rationale:** Fast to build and easy to explain, typed domain model, clean test harness.  
**Trade-off:** No need for NestJS or architectural boilerplate unless implementation growth justifies it.

### Q05 — Persistence

**Decision:** PostgreSQL with Prisma migrations. Store both durable traffic state and audit, no memory-only implementation.  
**Rationale:** Transactional consistency, unique event IDs, persistent command outbox, restart testing (§12).  
**Trade-off:** Local PostgreSQL setup costs more than SQLite; use a single simple dockerized instance only if it meaningfully helps setup.

### Q06 — Junction scope and config

**Decision:** Seed and demo **Junction A** only; phase pairs and timing live in junction configuration, not deeply hardcoded in traffic domain code.  
**Rationale:** Assignment allows A-only implementation and asks for future extension (§2).  
**Trade-off:** Multi-junction functional UI and actual distributed deployment excluded.

### Q07 — Conflicting movements

**Decision:** Exactly `NORTH_SOUTH` and `EAST_WEST`; their GREEN outputs are mutually exclusive. `ALL_RED` is a stage, not a third traffic-serving phase.  
**Rationale:** Matches assessment's simplified phase model (§§2–3).  
**Trade-off:** Turning movements, pedestrian flows, and mixed turning conflicts are not modeled.

### Q08 — Durations and no-blocking timing

**Decision:** Normal GREEN **30s**; YELLOW **5s measured after confirmed YELLOW**; ALL_RED **2s after confirmed all-RED**; auto minimum GREEN **10s**; control cycles use non-blocking scheduler.  
**Rationale:** First two timing values follow the assignment approximately; ALL_RED and minimum green are reasonable explicit assumptions (§§3, 6).  
**Trade-off:** `2s` and `10s` are design choices, not externally validated industrial timing; make configurable. Overrides can initiate safe preemption before minimum GREEN.

### Q09 — IoT transport boundary

**Decision:** Controller port + REST simulator. MQTT deferred but adapter-ready; simulator supports auto ACK, delay, drop, duplicate, mismatch, OFFLINE, and snapshot.  
**Rationale:** MQTT is optional; simulating all scenarios locally is more useful than building network plumbing (§13).  
**Trade-off:** Simulator behavior does not validate real-time hardware or MQTT QoS. Persist the simulator's reported actual state independently of backend desired state for meaningful restart tests.

### Q10 — Centralized state machine

**Decision:** Backend accepts intents and owns all signal sequencing, timer guards, active mode, state version, and fault state. Frontend never writes arbitrary signal colors.  
**Rationale:** Prevents clients from bypassing safety (§§3, 6, 8, 14).  
**Trade-off:** More domain logic than a basic CRUD server; intentionally necessary.

### Q11 — Event idempotency

**Decision:** Unique `(junction_id, event_id)` persisted; same ID and payload hash -> `200` duplicate/no-op; same ID, different payload -> `409` conflict.  
**Rationale:** Required to avoid duplicate queue mutation (§4).  
**Trade-off:** Event ID must actually be stable across retries; evaluator simulator should reuse it for duplicates.

### Q12 — Delayed/out-of-order sensor events

**Decision:** Sequence numbers are monotonic per (`junction_id`, `direction`). Duplicate-ID check first. New event with `sequence_no <= last_sequence` -> reject and audit. Use **server receipt** for wait time; sensor time for history.  
**Rationale:** Deterministic ordering and clock-skew-resistant scheduling; assessment explicitly leaves ordering unspecified (§§4, 17).  
**Trade-off:** A late valid event may be dropped. Sequence gaps accepted. The rule assumes a single sequenced sensor stream per direction; future `sensor_id` required for distributed sensors.

### Q13 — Vehicle and queue representation

**Decision:** Persist active vehicle identity with direction/type and server arrival time. Derive queue counts from WAITING vehicles; never accept frontend-provided counts. Unknown clearance -> `422` + audit; active vehicle cannot be duplicated in a queue.  
**Rationale:** Prevents negative counters and reconciles priority/wait calculation (§§4–5).  
**Trade-off:** Vehicle history consumes additional rows, worthwhile for correctness and audit.

### Q14 — Weights for normal vehicles

**Decision:** EMPLOYEE 1, FORKLIFT 2, TRUCK 4; EMERGENCY not assigned a normal score, but triggers preemption.  
**Rationale:** Reflects stipulated rank `EMERGENCY > TRUCK > FORKLIFT > EMPLOYEE` (§4) and keeps comparison straightforward.  
**Trade-off:** Weight selection is illustrative, not validated factory policy. Store it in config.

### Q15 — Waiting time and starvation

**Decision:** `age_bonus=min(floor(oldest_wait_seconds/15),8)`; if oldest wait >= **90s**, that phase has precedence at next normal safe decision point. Two starved phases: older oldest vehicle wins; final tie is deterministic configuration order.  
**Rationale:** Balances heavy queues with fairness (§§5–6). Avoid switching simply because time changes by a second.  
**Trade-off:** 90s cannot be guaranteed during emergencies, controller failures, or safety clearance; log overages.

### Q16 — Cross-mode priority

**Decision:** `FAULT_LOCKOUT/SAFETY > EMERGENCY > MANUAL > AUTOMATIC`. Emergency and manual change only target intent; all use same safe state machine.  
**Rationale:** Conservatively resolves undefined override precedence (§§7–8).  
**Trade-off:** A failed physical controller can prevent even emergency GREEN; misleading to claim software can override device failure.

### Q17 — Competing emergencies

**Decision:** Serve oldest active emergency's phase by **server receipt time**; if both phases contain emergencies, serve first safely, then transition to other. Within a phase, multiple emergencies share green.  
**Rationale:** Deterministic, auditable conflict resolution (§7).  
**Trade-off:** No advanced emergency route optimization or hospital dispatch priority.

### Q18 — Stale emergency intent

**Decision:** Emergency is cleared by an accepted matching `VEHICLE_CLEARED`; at **60s** without progress, alert `EMERGENCY_STALE`, but **do not automatically erase** the intent. Include explicit operator recovery procedure, only after reconciling conditions.  
**Rationale:** Silently expiring a real emergency is unsafe; assignment asks candidate to choose stale policy (§7).  
**Trade-off:** A lost clearance message can prolong emergency mode and require operator intervention.

### Q19 — Manual lease

**Decision:** Accept manual phase request for **120 seconds** unless revoked/renewed; expire into automatic policy, but do not interrupt safe transition mid-step. Emergency supersedes valid manual lease, after which it may resume if unexpired.  
**Rationale:** Avoid indefinitely abandoned manual override (§8).  
**Trade-off:** Assessment doesn't prescribe duration; clearly label it configurable.

### Q20 — Concurrent administrator requests

**Decision:** Serialize manual requests; latest accepted intent replaces the pending target, versioned and audited. Commands already dispatched are not cancelled by assumption. At safe ALL_RED boundary re-evaluate active highest-priority target.  
**Rationale:** Deterministic races with concurrent sensor and ACK events (§§6, 8, 15).  
**Trade-off:** Manual command returns `202 accepted`, not a promise that the lamp is already green.

### Q21 — Controller timeout, retries, and failures

**Decision:** ACK deadline **3s**. Same-command-ID single retry only if simulator/adapter guarantees idempotent execution; otherwise mark command timed out and enter DEGRADED. No GREEN after unknown/mismatched physical report. Reconnect requires snapshot.  
**Rationale:** Make failure-safe choices where ACK/timeout/retry behavior is undefined (§§9, 13, 17).  
**Trade-off:** Availability is deliberately sacrificed for safety; a real controller might need a different timeout.

### Q22 — Desired versus actual meaning

**Decision:** Persist both vectors separately. Only a fresh full-vector controller response associated with current command or explicit snapshot can mark actual state confirmed. Old ACKs cannot overwrite newer state.  
**Rationale:** Required by controller-failure portion (§9).  
**Trade-off:** Controller-reported state is still not independently verified physical lamp state; production requires independent interlocks/feedback.

### Q23 — Per-junction concurrency guarantee

**Decision:** Demo single Node process with one serial event processor per junction; DB transactions and version checks for stale callbacks.  
**Rationale:** Straightforward, testable consistency without Kafka/Redis (§§6, 15).  
**Trade-off:** Do **not** claim cross-process guarantees. Horizontal scale requires DB/advisory locking or leader ownership.

### Q24 — Command persistence/outbox

**Decision:** Persist desired state and `controller_commands` in same transaction, dispatch after commit, tie ACK to unique `command_id`; retry/reconcile pending outbox on restart only after fresh status verification.  
**Rationale:** Prevents DB/device state divergence and supports recoverability (§§9, 12, 13).  
**Trade-off:** At-least-once dispatch requires controller idempotency; do not blindly replay an old GREEN.

### Q25 — Restart recovery

**Decision:** Mark last persisted `actual_signals` STALE, enter STARTUP_RECONCILIATION/DEGRADED, obtain a new snapshot, and safely reach confirmed ALL_RED before scheduling. Block GREEN if state unknown.  
**Rationale:** Directly addresses the assessment's restart-mid-transition edge cases (§12).  
**Trade-off:** Recovery may remain blocked if controller is unavailable; expose clear operator action.

### Q26 — REST interface

**Decision:** Implement all minimum assessment endpoints, use `POST /api/junctions/:id/commands` for intents, `POST /api/controller-events` for ACK/status/snapshot, and predictable 200/201/202/400/404/409/422 responses.  
**Rationale:** Closely matches §§8, 10, 14, with simple simulator extensibility.  
**Trade-off:** Prefer complete signal-vector confirmation rather than the example's single-direction `actual_state`; explain this refinement in README.

### Q27 — Dashboard refresh

**Decision:** React status polling **every 1s** and history **every 3s**; error/resync UI.  
**Rationale:** Meets automatic refresh without unnecessary WebSocket/SSE complexity (§14.9).  
**Trade-off:** 1-second visual lag acceptable in simulator; backend alone controls lights.

### Q28 — Auditability and failure UI

**Decision:** Immutable audit events record reason, correlation IDs, old/new mode/stage, timing, sensor accept/reject, controller command+ACK, emergency/manual/fault and recovery. UI distinguishes desired/actual/unknown.  
**Rationale:** Shows *why* the system reached a state and supports reviewer debugging (§§11, 14).  
**Trade-off:** Event-history size unbounded for prototype; archive/retention is production work.

### Q29 — Test strategy

**Decision:** Fake-clock domain tests; API validation; idempotency; fairness; emergency/manual races; ACK drop/delay/duplication; controller mismatch; persistent restart; concurrency burst; unsafe-transition property checks.  
**Rationale:** Assessment evaluates testable pure domain and 9 required demo scenarios (§§15–16).  
**Trade-off:** Not exhaustive formal verification; prioritize invariants under adverse timing.

### Q30 — Non-goals and safety caveat

**Decision:** No real-hardware deployment or physical safety certification, production auth, multihost distributed locking, MQTT integration, WebSocket, polished frontend, analytics, or multi-junction demonstration as requirements.  
**Rationale:** Assignment calls MQTT and extra production features optional (§§13, 16, 21), while backend correctness is primary.  
**Trade-off:** Future factory use requires formal hazard analysis, hardware interlocks, audit policy, authorization, observability and operations procedures.

---

## Invariant-to-decision traceability

| Safety / review invariant | Supported by decisions |
|:--|:--|
| Never simultaneous conflicting GREEN | Q02, Q07, Q08, Q10, Q21, Q22, Q23 |
| No immediate conflicting GREEN on manual/emergency | Q02, Q10, Q16, Q17, Q20 |
| A request is not confirmation of physical state | Q02, Q09, Q21, Q22, Q24, Q25 |
| Duplicate events cannot change queue twice | Q11, Q12, Q13, Q23 |
| Waiting vehicles cannot starve under normal safe service | Q03, Q14, Q15 |
| Concurrent requests never corrupt junction state | Q20, Q23, Q24 |
| Restart does not blindly trust previous controller state | Q22, Q24, Q25 |
| Dashboard cannot override control logic | Q10, Q26, Q27, Q28 |
| Candidate can explain design under review | Q01, Q03, Q29, Q30 |

## Required honest disclosures in README

1. `Assumptions / Questions / Requirement Issues` — use that **exact heading**.
2. `AI / Tool Usage` — use that **exact heading** and disclose tools actually used.
3. Explain this assessment expects 4–5 hours; the design is broader, so list whatever remains incomplete.
4. State that ACKs are controller reports, **not** independent proof that real physical lights changed.
5. State that 2-second all-red, 10-second minimum green, 90-second fairness, 3-second ACK timeout, 60-second emergency stale warning and 120-second manual lease are **assumptions**, not mandated values.
6. State that per-junction serialization applies to the **single-instance demo**, not automatically to multi-server deployments.

**Source:** user-provided *Factory Traffic Management System - Backend Developer Intern Assessment V2* (CSI Smart Tech, pp. 1–9). Section numbers in decision records refer to that PDF.
