import { PrismaClient } from "@prisma/client";
import { createApplication } from "./app.js";

const prisma = new PrismaClient();
const { app, controllerScheduler } = createApplication(prisma);
const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

await controllerScheduler.start();

const server = app.listen(port, () => {
  console.log(`Factory traffic API listening on port ${port}`);
});

async function shutdown(): Promise<void> {
  controllerScheduler.stop();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
