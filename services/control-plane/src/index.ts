/**
 * Control Plane entrypoint.
 */

import { startControlPlaneFromEnv } from "./server.js";

const cp = await startControlPlaneFromEnv();

console.log(
  `control-plane listening on ${cp.baseUrl} (${process.env.DATABASE_URL ? "postgres" : "memory"})`
);

const shutdown = async () => {
  await cp.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
