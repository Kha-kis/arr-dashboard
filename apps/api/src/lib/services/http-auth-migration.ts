import type { FastifyInstance } from "fastify";
import { encryptHttpAuthCredentials, stripUrlCredentials } from "./http-auth.js";

export async function migrateUrlEmbeddedHttpAuth(app: FastifyInstance): Promise<number> {
	const instances = await app.prisma.serviceInstance.findMany({
		select: {
			id: true,
			userId: true,
			baseUrl: true,
			externalUrl: true,
			encryptedHttpAuthCredentials: true,
			httpAuthEncryptionIv: true,
		},
	});
	let migrated = 0;
	for (const instance of instances) {
		let parsedBase: ReturnType<typeof stripUrlCredentials>;
		try {
			parsedBase = stripUrlCredentials(instance.baseUrl);
		} catch {
			app.log.warn({ instanceId: instance.id }, "Skipping malformed service URL migration");
			continue;
		}

		let sanitizedExternalUrl: string | undefined;
		if (instance.externalUrl) {
			try {
				const parsedExternal = stripUrlCredentials(instance.externalUrl);
				if (parsedExternal.credentials) sanitizedExternalUrl = parsedExternal.baseUrl;
			} catch {
				app.log.warn(
					{ instanceId: instance.id },
					"Skipping malformed external service URL migration",
				);
			}
		}
		if (!parsedBase.credentials && sanitizedExternalUrl === undefined) continue;
		const encrypted =
			!parsedBase.credentials ||
			(instance.encryptedHttpAuthCredentials && instance.httpAuthEncryptionIv)
				? {}
				: encryptHttpAuthCredentials(app.encryptor, parsedBase.credentials);
		await app.prisma.serviceInstance.updateMany({
			where: { id: instance.id, userId: instance.userId },
			data: {
				...(parsedBase.credentials ? { baseUrl: parsedBase.baseUrl } : {}),
				...(sanitizedExternalUrl === undefined ? {} : { externalUrl: sanitizedExternalUrl }),
				...encrypted,
			},
		});
		migrated += 1;
	}
	if (migrated > 0) {
		app.log.info({ count: migrated }, "Migrated URL-embedded HTTP credentials");
	}
	return migrated;
}
