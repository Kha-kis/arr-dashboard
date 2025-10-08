import { dirname } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fp from "fastify-plugin";
import { Encryptor } from "../lib/auth/encryption.js";
import { SecretManager } from "../lib/auth/secret-manager.js";
import { SessionService } from "../lib/auth/session.js";

export const securityPlugin = fp(async (app) => {
	// Determine secrets path based on DATABASE_URL
	const databaseUrl = app.config.DATABASE_URL;
	let secretsPath: string;

	if (databaseUrl.startsWith("file:")) {
		// Extract directory from SQLite database path
		const dbPath = databaseUrl.replace("file:", "");
		const dbDir = dirname(dbPath);
		secretsPath = `${dbDir}/secrets.json`;
	} else {
		// For non-SQLite databases, use a default path
		secretsPath = "./data/secrets.json";
	}

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
