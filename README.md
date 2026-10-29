# Factory Traffic Management System _(factory-traffic-management-system)_

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

A safety-first factory traffic simulator with a TypeScript API, PostgreSQL, and a React dashboard.

This repository is an assessment project for factory-road traffic control. It is organized as a monorepo: the backend and frontend are separate npm packages. The local checkout directory can have any name.

The application demonstrates junction scheduling, safe signal transitions, emergency and manual control, device-failure handling, event history, and restart recovery. The REST simulator is for assessment and development; it does not verify physical traffic lights or provide certified industrial safety.

## Table of Contents

- [Security](#security)
- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Tests and Build](#tests-and-build)
- [Demo Checklist](#demo-checklist)
- [Architecture and Safety Model](#architecture-and-safety-model)
- [Assumptions / Questions / Requirement Issues](#assumptions--questions--requirement-issues)
- [AI / Tool Usage](#ai--tool-usage)
- [Known Limitations](#known-limitations)
- [API](#api)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Security

Manual commands, sensor events, and simulator controls do not require authentication. Keep the API on a trusted local network. Do not connect it to real traffic equipment or rely on simulator reports as proof of physical signal state.

## Background

The system is built for the CSI Smart Tech Factory Traffic Management assessment. It focuses on Junction A while allowing additional junction records with the same four-direction, two-phase layout.

The backend uses TypeScript, Express, Prisma, and PostgreSQL. The dashboard uses React, Vite, and TanStack Query. The assessment requirements and design decisions are in [`docs/rules.pdf`](docs/rules.pdf), [`docs/PRD (1).md`](docs/PRD%20%281%29.md), and [`docs/decisions (1).md`](docs/decisions%20%281%29.md).

Implemented capabilities include:

- ACK-gated signal transitions through yellow and all-red
- Persistent, idempotent vehicle events and queue state
- Weighted scheduling, starvation protection, emergency priority, and manual leases
- Controller, sensor, and signal status reporting with audit history
- A REST controller simulator with delayed, dropped, duplicate, and mismatched ACK behavior
- A live dashboard with desired and observed signals, queues, alerts, controls, and recent activity

## Install

### Dependencies

- Node.js 20.19 or newer, or 22.12 or newer
- PostgreSQL 15 or newer
- npm

Create a PostgreSQL database named `factory_traffic`. From the repository root, install and initialize the backend:

```sh
cd backend
npm install
cp .env.example .env
# Set DATABASE_URL in .env to your local PostgreSQL credentials.
npm run db:generate
npm run db:migrate
npm run db:seed
```

The seed creates Junction A. The API listens on port 3000 by default. Set `PORT` in `backend/.env` to use another port.

## Usage

Start the backend in one terminal:

```sh
cd backend
npm run dev
```

Start the dashboard in another terminal:

```sh
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the frontend terminal. By default, Vite proxies `/api` to `http://localhost:3000`. If the API uses another address, set `VITE_API_BASE_URL` in `frontend/.env.local`, for example `http://localhost:3000/api`.

To create another standard-layout junction, send:

```sh
curl -X POST http://localhost:3000/api/junctions \
  -H 'Content-Type: application/json' \
  -d '{"id":"B"}'
```

The dashboard currently opens Junction A. See [`backend/README.md`](backend/README.md) for setup details and [`docs/API.md`](docs/API.md) for request and response contracts.

## Tests and Build

The backend integration tests use the configured PostgreSQL database. Apply migrations first; the tests create and delete one randomly named `test-...` junction.

```sh
cd backend
npm test
npm run build
```

Build and type-check the dashboard:

```sh
cd frontend
npm run build
```

## Demo Checklist

1. Start PostgreSQL, apply migrations, seed Junction A, and start the API and dashboard.
2. Wait for a controller snapshot and confirm the dashboard shows the reported signal state.
3. Add vehicles on both phases; compare queue counts, weighted scores, wait times, and the next phase.
4. Observe green, yellow, all-red, and the next green through controller reports.
5. Add an emergency vehicle opposite the active phase and confirm safe preemption.
6. Request manual green, inspect the lease deadline, return to automatic, then try an emergency during the lease.
7. Replay an event ID and clear a vehicle to verify idempotency and queue updates.
8. Simulate controller offline, delayed or dropped ACKs, mismatched state, sensor failure, and signal failure.
9. Restore device health and confirm a fresh snapshot is required before normal operation resumes.
10. Review recent activity and paginated history for intents, commands, ACKs, timeouts, and alerts.

## Architecture and Safety Model

The frontend reads status and submits intents; it does not select traffic phases or run signal timers. The backend persists desired signal vectors separately from controller-reported vectors. A phase change uses confirmed yellow, all-red clearance, and ACK-gated green. Unknown or mismatched controller state enters lockout.

Automatic scheduling weights employee vehicles at 1, forklifts at 2, and trucks at 4, then adds a capped age bonus. A queue waiting 90 seconds gets service preference. Emergency requests outrank manual leases, which outrank automatic selection, subject to safety interlocks. Manual leases last 120 seconds; an emergency remains active until its matching clearance event.

The backend serializes work per junction in one process and uses database transactions with state versions. It does not provide distributed multi-instance locking.

## Assumptions / Questions / Requirement Issues

- The assessment's example command payload uses a `command` field; this API uses `command_type` and rejects unknown fields.
- Junctions created through the API use the same four-direction, two-phase layout and timing as Junction A. Custom conflict graphs and per-junction timing configuration are not exposed.
- Sensor failures raise an alert while preserving recorded queue entries. Signal-controller failures lock control until a fresh safe snapshot.
- ACKs and snapshots are complete signal vectors reported by the controller simulator; they are not independent physical-light measurements.
- Green, yellow, all-red, ACK timeout, starvation, stale-emergency, and manual-lease durations are prototype assumptions recorded in the [decisions log](docs/decisions%20%281%29.md).
- Junction A is seeded and shown in the dashboard. Additional junctions can be created through the API.
- The dashboard polls status every second and activity every three seconds instead of using WebSockets.

## AI / Tool Usage

Codex assisted with implementation, code navigation, and documentation based on the repository PRD and decisions log. The project owner is responsible for reviewing, understanding, and validating the implementation before relying on it.

## Known Limitations

- The dashboard is manually exercised in a browser; the repository does not include a repeatable Playwright suite.
- The REST simulator cannot verify physical lamps or industrial hardware safety.
- Authentication and distributed multi-instance coordination are outside this assessment's scope.

## API

The REST API reference is in [`docs/API.md`](docs/API.md). It covers junction creation and status, vehicle events, controller events, simulator controls, commands, and paginated history.

## Maintainers

- [Takib Khan (@thetakibkhan)](https://github.com/thetakibkhan)

## Contributing

Open an [issue](https://github.com/thetakibkhan/factory-traffic-management-system/issues) for questions or bug reports. Pull requests are welcome; include the behavior being changed and run the backend tests and both builds before submitting.

## License

`UNLICENSED`. Copyright © Takib Khan. This repository does not grant permission to use, copy, modify, or distribute the software.
