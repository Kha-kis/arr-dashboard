import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import fp from "fastify-plugin";

export const registerHealthRoutes = fp(
  async (app: FastifyInstance, _opts: FastifyPluginOptions) => {
    app.get("/", async () => ({ status: "ok" }));

    app.get("/metrics", async () => ({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    }));
  },
  {
    name: "health-routes",
  },
);
