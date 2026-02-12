import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import fp from "fastify-plugin";

export const registerHealthRoutes = fp(
	async (app: FastifyInstance, _opts: FastifyPluginOptions) => {
		app.get("/", async () => ({ status: "ok" }));
	},
	{
		name: "health-routes",
	},
);
