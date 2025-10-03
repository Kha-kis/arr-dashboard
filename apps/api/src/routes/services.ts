import { arrServiceTypeSchema } from "@arr/shared";
import type { ServiceType } from "@prisma/client";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const servicePayloadSchema = z.object({
	label: z.string().min(1).max(120),
	baseUrl: z.string().url(),
	apiKey: z.string().min(8),
	service: arrServiceTypeSchema,
	enabled: z.boolean().default(true),
	isDefault: z.boolean().default(false),
	tags: z.array(z.string().min(1).max(64)).default([]),
	defaultQualityProfileId: z.number().int().min(0).nullable().optional(),
	defaultLanguageProfileId: z.number().int().min(0).nullable().optional(),
	defaultRootFolderPath: z.string().min(1).nullable().optional(),
	defaultSeasonFolder: z.boolean().nullable().optional(),
});

const serviceUpdateSchema = servicePayloadSchema
	.partial({
		label: true,
		baseUrl: true,
		apiKey: true,
		service: true,
		enabled: true,
		isDefault: true,
		tags: true,
	})
	.refine((data) => Object.keys(data).length > 0, {
		message: "At least one field must be provided",
	});

const tagCreateSchema = z.object({
	name: z.string().min(1).max(64),
});

const servicesRoute: FastifyPluginCallback = (app, _opts, done) => {
	const requireUser = (request: FastifyRequest, reply: FastifyReply) => {
		if (!request.currentUser) {
			reply.status(401).send({ error: "Unauthorized" });
			return null;
		}
		return request.currentUser;
	};

	app.get("/services", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: user.id },
			include: {
				tags: {
					include: {
						tag: true,
					},
				},
			},
			orderBy: { createdAt: "asc" },
		});

		const formatted = instances.map((instance) => ({
			id: instance.id,
			service: instance.service.toLowerCase(),
			label: instance.label,
			baseUrl: instance.baseUrl,
			enabled: instance.enabled,
			isDefault: instance.isDefault,
			createdAt: instance.createdAt,
			updatedAt: instance.updatedAt,
			hasApiKey: Boolean(instance.encryptedApiKey),
			defaultQualityProfileId: instance.defaultQualityProfileId,
			defaultLanguageProfileId: instance.defaultLanguageProfileId,
			defaultRootFolderPath: instance.defaultRootFolderPath,
			defaultSeasonFolder: instance.defaultSeasonFolder,
			tags: instance.tags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
		}));

		return reply.send({ services: formatted });
	});

	app.post("/services", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const parsed = servicePayloadSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const { apiKey, service, tags, isDefault, ...rest } = parsed.data;
		const encrypted = app.encryptor.encrypt(apiKey);

		const serviceEnum = service.toUpperCase() as ServiceType;

		if (isDefault) {
			await app.prisma.serviceInstance.updateMany({
				where: { userId: user.id, service: serviceEnum },
				data: { isDefault: false },
			});
		}

		const tagRecords = await Promise.all(
			tags.map(async (name) => {
				const tag = await app.prisma.serviceTag.upsert({
					where: { userId_name: { userId: user.id, name } },
					update: {},
					create: { userId: user.id, name },
				});
				return {
					tagId: tag.id,
				};
			}),
		);

		const created = await app.prisma.serviceInstance.create({
			data: {
				userId: user.id,
				service: serviceEnum,
				encryptedApiKey: encrypted.value,
				encryptionIv: encrypted.iv,
				isDefault,
				...rest,
				tags: {
					create: tagRecords,
				},
			},
			include: {
				tags: {
					include: {
						tag: true,
					},
				},
			},
		});

		return reply.status(201).send({
			service: {
				id: created.id,
				service: created.service.toLowerCase(),
				label: created.label,
				baseUrl: created.baseUrl,
				enabled: created.enabled,
				isDefault: created.isDefault,
				createdAt: created.createdAt,
				updatedAt: created.updatedAt,
				hasApiKey: true,
				defaultQualityProfileId: created.defaultQualityProfileId,
				defaultLanguageProfileId: created.defaultLanguageProfileId,
				defaultRootFolderPath: created.defaultRootFolderPath,
				defaultSeasonFolder: created.defaultSeasonFolder,
				tags: created.tags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
			},
		});
	});

	app.put("/services/:id", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const { id } = request.params as { id: string };
		const parsed = serviceUpdateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const payload = parsed.data;
		const existing = await app.prisma.serviceInstance.findFirst({
			where: { id, userId: user.id },
		});

		if (!existing) {
			return reply.status(404).send({ error: "Service instance not found" });
		}

		const updateData: any = {};
		if (payload.label) {
			updateData.label = payload.label;
		}
		if (payload.baseUrl) {
			updateData.baseUrl = payload.baseUrl;
		}
		if (typeof payload.enabled === "boolean") {
			updateData.enabled = payload.enabled;
		}
		if (typeof payload.isDefault === "boolean") {
			updateData.isDefault = payload.isDefault;
		}
		if (payload.service) {
			updateData.service = payload.service.toUpperCase() as ServiceType;
		}
		if (payload.apiKey) {
			const encrypted = app.encryptor.encrypt(payload.apiKey);
			updateData.encryptedApiKey = encrypted.value;
			updateData.encryptionIv = encrypted.iv;
		}

		if (Object.prototype.hasOwnProperty.call(payload, "defaultQualityProfileId")) {
			updateData.defaultQualityProfileId = payload.defaultQualityProfileId ?? null;
		}
		if (Object.prototype.hasOwnProperty.call(payload, "defaultLanguageProfileId")) {
			updateData.defaultLanguageProfileId = payload.defaultLanguageProfileId ?? null;
		}
		if (Object.prototype.hasOwnProperty.call(payload, "defaultRootFolderPath")) {
			updateData.defaultRootFolderPath = payload.defaultRootFolderPath ?? null;
		}
		if (Object.prototype.hasOwnProperty.call(payload, "defaultSeasonFolder")) {
			updateData.defaultSeasonFolder = payload.defaultSeasonFolder ?? null;
		}

		if (payload.isDefault === true || payload.service) {
			const targetService = (
				payload.service ?? existing.service.toLowerCase()
			).toUpperCase() as ServiceType;
			await app.prisma.serviceInstance.updateMany({
				where: { userId: user.id, service: targetService, NOT: { id } },
				data: { isDefault: false },
			});
		}

		const updated = await app.prisma.serviceInstance.update({
			where: { id },
			data: updateData,
			include: {
				tags: { include: { tag: true } },
			},
		});

		if (payload.tags) {
			await app.prisma.serviceInstanceTag.deleteMany({ where: { instanceId: id } });
			const connections = await Promise.all(
				payload.tags.map(async (name) => {
					const tag = await app.prisma.serviceTag.upsert({
						where: { userId_name: { userId: user.id, name } },
						update: {},
						create: { userId: user.id, name },
					});
					return { instanceId: id, tagId: tag.id };
				}),
			);
			if (connections.length > 0) {
				await app.prisma.serviceInstanceTag.createMany({ data: connections });
			}
		}

		const fresh = await app.prisma.serviceInstance.findUnique({
			where: { id },
			include: { tags: { include: { tag: true } } },
		});

		return reply.send({
			service: {
				id: fresh!.id,
				service: fresh!.service.toLowerCase(),
				label: fresh!.label,
				baseUrl: fresh!.baseUrl,
				enabled: fresh!.enabled,
				isDefault: fresh!.isDefault,
				createdAt: fresh!.createdAt,
				updatedAt: fresh!.updatedAt,
				hasApiKey: Boolean(fresh!.encryptedApiKey),
				defaultQualityProfileId: fresh!.defaultQualityProfileId,
				defaultLanguageProfileId: fresh!.defaultLanguageProfileId,
				defaultRootFolderPath: fresh!.defaultRootFolderPath,
				defaultSeasonFolder: fresh!.defaultSeasonFolder,
				tags: fresh!.tags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
			},
		});
	});

	app.delete("/services/:id", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const { id } = request.params as { id: string };

		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id, userId: user.id },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Service instance not found" });
		}

		await app.prisma.serviceInstance.delete({ where: { id } });
		return reply.status(204).send();
	});

	app.get("/tags", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const tags = await app.prisma.serviceTag.findMany({
			where: { userId: user.id },
			orderBy: { name: "asc" },
		});

		return reply.send({ tags });
	});

	app.post("/tags", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const parsed = tagCreateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const tag = await app.prisma.serviceTag.upsert({
			where: { userId_name: { userId: user.id, name: parsed.data.name } },
			update: {},
			create: { userId: user.id, name: parsed.data.name },
		});

		return reply.status(201).send({ tag });
	});

	app.delete("/tags/:id", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const { id } = request.params as { id: string };

		await app.prisma.serviceTag
			.delete({
				where: { id },
			})
			.catch(() => {
				return reply.status(404).send({ error: "Tag not found" });
			});

		return reply.status(204).send();
	});

	app.post("/services/test-connection", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const payload = request.body as any;
		const baseUrl = payload?.baseUrl;
		const apiKey = payload?.apiKey;
		const service = payload?.service?.toLowerCase();

		if (!baseUrl || !apiKey || !service) {
			return reply.status(400).send({
				error: "Missing required fields",
				details: "baseUrl, apiKey, and service are required",
			});
		}

		if (!["sonarr", "radarr", "prowlarr"].includes(service)) {
			return reply.status(400).send({
				error: "Invalid service type",
				details: "Service must be sonarr, radarr, or prowlarr",
			});
		}

		try {
			const apiPath = service === "prowlarr" ? "/api/v1/system/status" : "/api/v3/system/status";
			const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
			const testUrl = `${normalizedBaseUrl}${apiPath}`;

			if (service === "prowlarr") {
				const pingUrl = `${normalizedBaseUrl}/ping`;
				try {
					const pingResponse = await fetch(pingUrl, {
						method: "GET",
						signal: AbortSignal.timeout(3000),
					});

					if (!pingResponse.ok && pingResponse.status !== 404) {
						return reply.status(200).send({
							success: false,
							error: `Ping failed: HTTP ${pingResponse.status}`,
							details: `Cannot reach ${pingUrl}. Check the base URL is correct.`,
						});
					}
				} catch (pingError: any) {
					return reply.status(200).send({
						success: false,
						error: "Cannot reach Prowlarr",
						details: `Ping to ${pingUrl} failed. ${pingError.message ?? "Check if Prowlarr is running and the base URL is correct."}`,
					});
				}
			}

			const response = await fetch(testUrl, {
				headers: {
					"X-Api-Key": apiKey,
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				const contentType = response.headers.get("content-type");
				let details = "Check your base URL and API key";

				if (contentType?.includes("text/html")) {
					details =
						"Received HTML instead of JSON. The base URL or API path might be incorrect. Ensure base URL includes the full path (e.g., http://localhost:7878 not http://localhost:7878/radarr)";
				}

				return reply.status(200).send({
					success: false,
					error: `HTTP ${response.status}: ${response.statusText}`,
					details,
				});
			}

			const contentType = response.headers.get("content-type");
			if (!contentType?.includes("application/json")) {
				return reply.status(200).send({
					success: false,
					error: "Invalid response format",
					details:
						"Received HTML instead of JSON. Check if the base URL is correct and includes any URL base if configured in the service (e.g., http://localhost:7878 for root, or http://localhost/radarr if using a URL base).",
				});
			}

			const data = await response.json();
			const version = data.version ?? "unknown";

			return reply.send({
				success: true,
				message: `Successfully connected to ${service.charAt(0).toUpperCase() + service.slice(1)}`,
				version,
			});
		} catch (error: any) {
			let errorMessage = "Connection failed";
			let details = "Unknown error";

			if (error.name === "TimeoutError" || error.code === "ETIMEDOUT") {
				errorMessage = "Connection timeout";
				details =
					"The service did not respond within 5 seconds. Check if the service is running and the base URL is correct.";
			} else if (error.code === "ECONNREFUSED") {
				errorMessage = "Connection refused";
				details =
					"Could not connect to the service. Verify the base URL and that the service is running.";
			} else if (error.message) {
				details = error.message;
			}

			return reply.status(200).send({
				success: false,
				error: errorMessage,
				details,
			});
		}
	});

	app.post("/services/:id/test", async (request, reply) => {
		const user = requireUser(request, reply);
		if (!user) {
			return;
		}

		const { id } = request.params as { id: string };

		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id, userId: user.id },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Service instance not found" });
		}

		const apiKey = app.encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		});
		const service = instance.service.toLowerCase();

		try {
			const apiPath = service === "prowlarr" ? "/api/v1/system/status" : "/api/v3/system/status";

			// Normalize base URL - remove trailing slash if present
			const normalizedBaseUrl = instance.baseUrl.replace(/\/$/, "");
			const testUrl = `${normalizedBaseUrl}${apiPath}`;

			// Try ping endpoint first for Prowlarr to verify basic connectivity
			if (service === "prowlarr") {
				const pingUrl = `${normalizedBaseUrl}/ping`;
				try {
					const pingResponse = await fetch(pingUrl, {
						method: "GET",
						signal: AbortSignal.timeout(3000),
					});

					if (!pingResponse.ok && pingResponse.status !== 404) {
						return reply.status(200).send({
							success: false,
							error: `Ping failed: HTTP ${pingResponse.status}`,
							details: `Cannot reach ${pingUrl}. Check the base URL is correct.`,
						});
					}
				} catch (pingError: any) {
					return reply.status(200).send({
						success: false,
						error: "Cannot reach Prowlarr",
						details: `Ping to ${pingUrl} failed. ${pingError.message ?? "Check if Prowlarr is running and the base URL is correct."}`,
					});
				}
			}

			const response = await fetch(testUrl, {
				headers: {
					"X-Api-Key": apiKey,
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				const contentType = response.headers.get("content-type");
				let details = "Check your base URL and API key";

				if (contentType?.includes("text/html")) {
					details =
						"Received HTML instead of JSON. The base URL or API path might be incorrect. Ensure base URL includes the full path (e.g., http://localhost:7878 not http://localhost:7878/radarr)";
				}

				return reply.status(200).send({
					success: false,
					error: `HTTP ${response.status}: ${response.statusText}`,
					details,
				});
			}

			const contentType = response.headers.get("content-type");
			if (!contentType?.includes("application/json")) {
				return reply.status(200).send({
					success: false,
					error: "Invalid response format",
					details:
						"Received HTML instead of JSON. Check if the base URL is correct and includes any URL base if configured in the service (e.g., http://localhost:7878 for root, or http://localhost/radarr if using a URL base).",
				});
			}

			const data = await response.json();
			const version = data.version ?? "unknown";

			return reply.send({
				success: true,
				message: `Successfully connected to ${service.charAt(0).toUpperCase() + service.slice(1)}`,
				version,
			});
		} catch (error: any) {
			let errorMessage = "Connection failed";
			let details = "Unknown error";

			if (error.name === "TimeoutError" || error.code === "ETIMEDOUT") {
				errorMessage = "Connection timeout";
				details =
					"The service did not respond within 5 seconds. Check if the service is running and the base URL is correct.";
			} else if (error.code === "ECONNREFUSED") {
				errorMessage = "Connection refused";
				details =
					"Could not connect to the service. Verify the base URL and that the service is running.";
			} else if (error.message) {
				details = error.message;
			}

			return reply.status(200).send({
				success: false,
				error: errorMessage,
				details,
			});
		}
	});

	done();
};

export const registerServiceRoutes = servicesRoute;
