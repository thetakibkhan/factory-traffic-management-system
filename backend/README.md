# Factory Traffic Management Backend _(factory-traffic-management-backend)_

REST API and traffic-control services for the Factory Traffic Management System.

This package is the backend in the repository's assessment monorepo. It uses Express, Prisma, and PostgreSQL to validate vehicle and controller events, persist junction state, and schedule safe signal transitions.

## Security

Manual commands, sensor events, and simulator controls are unauthenticated. Keep the API on a trusted local network. This REST simulator does not verify physical signals and must not control real traffic equipment.

## Background

The traffic engine in `src/domain/traffic` is independent of HTTP and database code. The backend currently uses a REST simulator behind a controller port, so a future controller adapter can use the same command and event flow.

## Install

Requirements: Node.js 20.19 or newer (or 22.12 or newer), PostgreSQL 15 or newer, and npm.

From this directory, install dependencies and initialize the database:

```sh
npm install
cp .env.example .env
# Set DATABASE_URL to your local PostgreSQL credentials.
npm run db:generate
npm run db:migrate
npm run db:seed
```

Create a PostgreSQL database named `factory_traffic` first, or set `DATABASE_URL` to another local database. The seed initializes Junction A.

## Usage

Start the API from this directory:

```sh
npm run dev
```

It listens on port 3000 by default. Set `PORT` in `.env` to change the port. The parent repository's [`README`](../README.md) explains how to start the dashboard.

## Tests and Build

The integration tests use the configured database and create/delete a uniquely named `test-...` junction. Apply migrations before running them.

```sh
npm test
npm run build
```

## Traffic and Failure Behavior

- Sensor events use strict validation, unique junction/event IDs, canonical payload hashes, and per-direction sequence cursors. Queues derive from active vehicle records.
- Automatic scheduling weights employee vehicles at 1, forklifts at 2, and trucks at 4, with a capped age bonus and 90-second starvation priority.
- Emergencies outrank manual leases, which outrank automatic scheduling. Conflicting emergency phases are served by server arrival time, then arrival event ID. An emergency remains active until its matching clearance event; waits over 60 seconds are audited.
- Manual requests use a 120-second lease. All intents use the same safe transition engine.
- Commands are persisted before dispatch, retried once with the same ID, and locked out if the controller state remains unknown. Restart reconciliation fails pending commands and waits for a fresh snapshot.
- Controller, sensor, and signal-controller health is persisted and audited. An offline signal controller puts the junction into lockout until a fresh safe snapshot is accepted.
- Work is serialized per junction in a single process. Multi-server locking is not implemented.

## API

The complete request and response reference is in [`docs/API.md`](../docs/API.md). The API includes:

- `GET /api/health`, `GET /api/junctions`, `GET /api/junctions/:id`, and `POST /api/junctions`
- `GET /api/junctions/:id/status` and `GET /api/junctions/:id/history`
- `POST /api/sensor-events` and `POST /api/controller-events`
- `POST /api/junctions/:id/commands`
- `GET /api/simulators/:id` and `PATCH /api/simulators/:id`

## Maintainers

- [Takib Khan (@thetakibkhan)](https://github.com/thetakibkhan)

## Contributing

Open an [issue](https://github.com/thetakibkhan/factory-traffic-management-system/issues) for questions or bugs. Pull requests are welcome; include tests for behavior changes and run `npm test` and `npm run build` from this directory.

## License

`UNLICENSED`. Copyright © Takib Khan. This repository does not grant permission to use, copy, modify, or distribute the software.
