import { startServer } from "./server.ts";

const server = startServer(3000);
console.log(`Hono user/admin example listening on ${server.url}`);

async function shutdown(): Promise<void> {
  await server.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
