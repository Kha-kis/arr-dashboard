import "dotenv/config";
import { buildServer } from "./server.js";
import { envSchema } from "./config/env.js";

const env = envSchema.parse(process.env);

const start = async () => {
  const app = buildServer({ env });

  try {
    await app.listen({
      port: env.API_PORT,
      host: env.API_HOST,
    });
    app.log.info({ port: env.API_PORT, host: env.API_HOST }, "API server started");
  } catch (error) {
    app.log.error({ err: error }, "Failed to start API server");
    process.exit(1);
  }
};

void start();
