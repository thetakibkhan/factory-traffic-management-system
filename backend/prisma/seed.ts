import { PrismaClient } from "@prisma/client";
import { DEFAULT_JUNCTION_CONFIG, allRedSignals } from "../src/domain/traffic/types.js";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const config = {
    directions: [...DEFAULT_JUNCTION_CONFIG.directions],
    phases: {
      NORTH_SOUTH: [...DEFAULT_JUNCTION_CONFIG.phases.NORTH_SOUTH],
      EAST_WEST: [...DEFAULT_JUNCTION_CONFIG.phases.EAST_WEST],
    },
    timing: {
      normalGreenSeconds: DEFAULT_JUNCTION_CONFIG.timing.normalGreenMs / 1_000,
      minimumGreenSeconds: DEFAULT_JUNCTION_CONFIG.timing.minimumGreenMs / 1_000,
      yellowSeconds: DEFAULT_JUNCTION_CONFIG.timing.yellowMs / 1_000,
      allRedSeconds: DEFAULT_JUNCTION_CONFIG.timing.allRedMs / 1_000,
      ackTimeoutSeconds: DEFAULT_JUNCTION_CONFIG.timing.ackTimeoutMs / 1_000,
    },
  };

  await prisma.junction.upsert({
    where: { id: DEFAULT_JUNCTION_CONFIG.id },
    update: { config },
    create: {
      id: DEFAULT_JUNCTION_CONFIG.id,
      config,
      runtime: {
        create: {
          mode: "DEGRADED",
          stage: "STARTUP_RECONCILIATION",
          desiredSignals: allRedSignals(),
          stateTrust: "UNKNOWN",
        },
      },
    },
  });

  await prisma.controllerSimulatorState.upsert({
    where: { junctionId: DEFAULT_JUNCTION_CONFIG.id },
    update: {},
    create: {
      junctionId: DEFAULT_JUNCTION_CONFIG.id,
      actualSignals: allRedSignals(),
      health: "ONLINE",
      automaticAck: true,
      ackDelayMs: 0,
      nextAckBehavior: "NORMAL",
    },
  });
}

main()
  .catch(() => {
    console.error("Database seed failed");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
