import fp from "fastify-plugin";
import { migrateUrlEmbeddedHttpAuth } from "../lib/services/http-auth-migration.js";

export default fp(
	async (app) => {
		app.addHook("onReady", async () => {
			await migrateUrlEmbeddedHttpAuth(app);
		});
	},
	{ name: "http-auth-migration", dependencies: ["prisma", "security"] },
);
