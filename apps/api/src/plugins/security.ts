import fastifyCookie from "@fastify/cookie";
import fp from "fastify-plugin";
import { Encryptor } from "../lib/auth/encryption.js";
import { SecretManager } from "../lib/auth/secret-manager.js";
import { SessionService } from "../lib/auth/session.js";
import { resolveSecretsPath } from "../lib/utils/secrets-path.js";

export const securityPlugin = fp(async (app) => {
	// Determine secrets path based on DATABASE_URL using shared helper
	const databaseUrl = app.config.DATABASE_URL;
	const secretsPath = resolveSecretsPath(databaseUrl);

	// Get or generate secrets
	let encryptionKey = app.config.ENCRYPTION_KEY;
	let sessionCookieSecret = app.config.SESSION_COOKIE_SECRET;

	if (!encryptionKey || !sessionCookieSecret) {
		app.log.info("Auto-generating secrets (not provided in environment)");
		const secretManager = new SecretManager(secretsPath);
		const secrets = secretManager.getOrCreateSecrets();
		encryptionKey = encryptionKey || secrets.encryptionKey;
		sessionCookieSecret = sessionCookieSecret || secrets.sessionCookieSecret;
	}

	// Register cookie plugin with the secret (auto-generated or from env)
	await app.register(fastifyCookie, {
		secret: sessionCookieSecret,
		hook: "onRequest",
	});

	const encryptor = new Encryptor(encryptionKey);
	const sessionService = new SessionService(app.prisma, {
		...app.config,
		SESSION_COOKIE_SECRET: sessionCookieSecret,
	});

	app.decorate("encryptor", encryptor);
	app.decorate("sessionService", sessionService);
});
