import fastifyCookie from "@fastify/cookie";
import fp from "fastify-plugin";
import { Encryptor } from "../lib/auth/encryption.js";
import { SecretManager } from "../lib/auth/secret-manager.js";
import { SessionService } from "../lib/auth/session.js";
import { resolveSecretsPath } from "../lib/utils/secrets-path.js";

export const securityPlugin = fp(
	async (app) => {
		// Determine secrets path based on DATABASE_URL using shared helper
		// DATABASE_URL is guaranteed by the env schema transform (auto-configured if not provided)
		const databaseUrl = app.config.DATABASE_URL!;
		const secretsPath = resolveSecretsPath(databaseUrl);

		// Always load the local secrets file because it also carries the
		// installation identity. Unlike database backups, that identity stays
		// with this deployment so restored clones cannot claim its resources.
		const secretManager = new SecretManager(secretsPath);
		const secrets =
			app.config.ENCRYPTION_KEY && app.config.SESSION_COOKIE_SECRET
				? secretManager.getOrCreateEnvironmentSecrets(
						{
							encryptionKey: app.config.ENCRYPTION_KEY,
							sessionCookieSecret: app.config.SESSION_COOKIE_SECRET,
						},
						`${databaseUrl}\0${app.config.APP_URL}`,
					)
				: secretManager.getOrCreateSecrets({
						...(app.config.ENCRYPTION_KEY ? { encryptionKey: app.config.ENCRYPTION_KEY } : {}),
						...(app.config.SESSION_COOKIE_SECRET
							? { sessionCookieSecret: app.config.SESSION_COOKIE_SECRET }
							: {}),
					});

		if (!app.config.ENCRYPTION_KEY || !app.config.SESSION_COOKIE_SECRET) {
			app.log.info("Auto-generating secrets (not provided in environment)");
		}

		// Register cookie plugin with the secret (auto-generated or from env)
		await app.register(fastifyCookie, {
			secret: secrets.sessionCookieSecret,
			hook: "onRequest",
		});

		const encryptor = new Encryptor(secrets.encryptionKey);
		const sessionService = new SessionService(
			app.prisma,
			{
				...app.config,
				SESSION_COOKIE_SECRET: secrets.sessionCookieSecret,
			},
			app.log,
		);

		app.decorate("encryptor", encryptor);
		app.decorate("sessionService", sessionService);
		app.decorate("installationId", secrets.installationId);
		app.decorate("secretsSynchronized", secretManager.secretsSynchronized);
	},
	{
		name: "security",
		dependencies: ["prisma"],
	},
);
