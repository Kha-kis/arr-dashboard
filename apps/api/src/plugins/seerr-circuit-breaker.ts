/**
 * Seerr Circuit Breaker Plugin
 *
 * Registers a per-instance circuit breaker on the Fastify instance.
 * Prevents cascading failures when Seerr instances are unreachable.
 */

import fp from "fastify-plugin";
import { SeerrCircuitBreaker } from "../lib/seerr/seerr-circuit-breaker.js";

declare module "fastify" {
	interface FastifyInstance {
		seerrCircuitBreaker: SeerrCircuitBreaker;
	}
}

const seerrCircuitBreakerPlugin = fp(
	async (app) => {
		const breaker = new SeerrCircuitBreaker();
		app.decorate("seerrCircuitBreaker", breaker);

		app.addHook("onClose", async () => {
			breaker.destroy();
			app.log.info("Seerr circuit breaker destroyed");
		});
	},
	{
		name: "seerr-circuit-breaker",
	},
);

export default seerrCircuitBreakerPlugin;
