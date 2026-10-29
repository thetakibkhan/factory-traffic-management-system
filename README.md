# Factory Traffic Management System

A safety-first factory junction traffic simulation built for the CSI Smart Tech assessment. The system uses a TypeScript/Express API, PostgreSQL with Prisma, and a React/Vite dashboard. It is a demonstration system, not certified industrial safety software.

## Current implementation

- **Epics 1–4:** persistence, Junction A seed, ACK-gated state machine, controller simulator/outbox, and idempotent sensor events.
- **Epics 5–6:** weighted and starvation-aware scheduling, emergency preemption, manual leases, and audit events.
- **Epic 7:** live Junction A dashboard with queue scores, desired/confirmed signals, current and next phase, pending command, emergency direction and transition, controller/sensor/signal failure controls, manual control, simulation, and recent activity.
- **Epic 8:** run instructions, REST API reference, demo checklist, assumptions, and verification notes.

See [backend/README.md](backend/README.md), the [API reference](docs/API.md), the [PRD](docs/PRD%20(1).md), and the [decisions log](docs/decisions%20(1).md).

## Requirements

- Node.js 20.19 or newer, or 22.12 or newer (Vite 7 requirement)
- PostgreSQL 15 or newer
- npm

## Run locally

Create a PostgreSQL database named `factory_traffic`. Then configure and start the backend:

```sh
cd backend
npm install
cp .env.example .env
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

In a second terminal, start the dashboard:

```sh
cd frontend
npm install
npm run dev
```

Open the Vite URL printed in the terminal. The frontend proxies `/api` to `http://localhost:3000`. Set `VITE_API_BASE_URL` in `frontend/.env.local` to a full API base such as `http://localhost:3000/api` if the backend uses another address. Backend configuration is in `backend/.env.example`; set `DATABASE_URL` to match your PostgreSQL credentials.

## Tests and build

From `backend/`, run `npm test` and `npm run build`. From `frontend/`, run `npm run build` to type-check and create the production bundle.

The backend suite includes domain, application, and PostgreSQL-backed API integration coverage. Run `npm test` from `backend/` after applying migrations; it creates and removes one randomly named test junction. Run `npm run build` from both `backend/` and `frontend/` for type checking and production builds.

## Demo checklist

1. Start PostgreSQL, apply migrations, seed Junction A, and start the API and dashboard.
2. Wait for the fresh simulator snapshot; confirm the dashboard shows the controller-reported state.
3. Add vehicles on both phases and compare queue counts, weighted scores, wait age, and the next phase.
4. Observe green, yellow, all-red, and the next green through confirmed controller reports.
5. Add an emergency vehicle opposite the active phase and confirm safe preemption.
6. Request manual green, inspect the lease deadline, and return to automatic. Try an emergency during the lease.
7. Replay an event ID and clear a vehicle to inspect idempotency and queue updates.
8. Use the simulator controls to take the controller offline, delay or drop an ACK, or return a mismatch.
9. Reconnect and verify a new snapshot is required before normal operation resumes.
10. Inspect recent activity and the paginated history API for intent, command, ACK, timeout, and alert records.

## Architecture and safety model

The frontend reads status from the backend and submits intents; it does not choose phases or run traffic timers. The backend persists complete desired vectors and only presents controller-reported vectors as observed state. A phase change uses confirmed yellow, all-red, and ACK-gated green. Unknown or mismatched controller state enters a degraded/lockout path. The simulator's reports are not independent verification of physical lamps.

Automatic scheduling weights employee vehicles at 1, forklifts at 2, and trucks at 4, with a capped age bonus. A queue waiting 90 seconds gets normal-traffic service preference. Emergency requests outrank manual leases, which outrank automatic selection, subject to safety interlocks. Manual leases last 120 seconds; active emergency requests remain until matching vehicle clearance.

Per-junction serialization is a single-process demo guarantee. The API and simulator controls are intentionally unprotected for the assessment. Do not expose this application to an untrusted network.

## Assumptions / Questions / Requirement Issues

- The PRD's example command payload uses a `command` field; this implementation uses the explicit `command_type` field described in its request contract and rejects unknown fields.
- Junctions created through the API use the same four-direction, two-phase topology and timing as Junction A. A custom conflict graph or per-junction timing editor is not part of the current API.
- Sensor failures raise a persistent warning and preserve already-recorded queue entries; signal-controller failures lock control until a fresh safe snapshot.
- Controller ACKs and snapshots are complete signal vectors. They are controller reports, not independent physical-light measurements.
- Normal green, minimum green, yellow, all-red, ACK timeout, starvation, stale-emergency, and manual lease values are prototype assumptions recorded in the decisions log.
- Junction A is seeded and shown in the dashboard. Additional junctions can be created through the API using the standard phase layout and timing. The system does not provide distributed multi-instance locking.
- The frontend uses polling instead of WebSockets, as selected in the decisions log.

## AI / Tool Usage

Codex assisted with implementation, code navigation, and documentation based on the repository PRD and decisions log. The project owner remains responsible for reviewing, understanding, and validating the implementation before relying on it.

## Outstanding work

- The React dashboard is manually exercised in a browser; a repeatable Playwright suite is not included yet.
- The REST simulator and controller reports do not verify real signal lamps or industrial hardware safety.
- Authentication and distributed multi-instance coordination remain outside this assessment scope.
