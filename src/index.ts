import cron from "node-cron";
import { loadAppConfig } from "./config/loader.js";
import { Store } from "./db/store.js";
import { Controller } from "./controller/controller.js";
import logger from "./logger.js";

async function main(): Promise<void> {
  logger.info("code-monkey controller starting");

  // Load config
  const config = loadAppConfig();
  logger.level = config.logLevel;

  // Initialize database
  const store = new Store({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl,
  });
  await store.initialize();

  // Initialize controller
  const controller = new Controller(config, store);

  // Start polling cron
  logger.info(`Starting poll cron: ${config.pollIntervalCron}`);
  cron.schedule(config.pollIntervalCron, async () => {
    try {
      await controller.poll();
    } catch (error) {
      logger.error("Poll cycle failed", { error });
    }
  });

  // Run initial poll
  await controller.poll();

  logger.info("code-monkey controller running");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    await store.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("Fatal error", { error });
  process.exit(1);
});
