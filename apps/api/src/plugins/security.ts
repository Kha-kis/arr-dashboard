import fp from "fastify-plugin";
import { Encryptor } from "../lib/auth/encryption.js";
import { SessionService } from "../lib/auth/session.js";

export const securityPlugin = fp(async (app) => {
	const encryptor = new Encryptor(app.config.ENCRYPTION_KEY);
	const sessionService = new SessionService(app.prisma, app.config);

	app.decorate("encryptor", encryptor);
	app.decorate("sessionService", sessionService);
});
