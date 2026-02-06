import { arrServiceTypeSchema } from "@arr/shared";
import type { ServiceType } from "../lib/prisma.js";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { testServiceConnection } from "../lib/services/connection-tester.js";
import { formatServiceInstance } from "../lib/services/service-formatter.js";
import { updateInstanceTags, upsertTags } from "../lib/services/tag-manager.js";
import { buildUpdateData } from "../lib/services/update-builder.js";

const servicePayloadSchema = z.object({
	label: z.string().min(1).max(120),
	baseUrl: z.string().url(),
	externalUrl: z.string().url().nullable().optional(), // Optional browser-accessible URL for reverse proxy setups
	apiKey: z.string().min(8),
	service: arrServiceTypeSchema,
	enabled: z.boolean().default(true),
	isDefault: z.boolean().default(false),
	tags: z.array(z.string().min(1).max(64)).default([]),
	defaultQualityProfileId: z.number().int().min(0).nullable().optional(),
	defaultLanguageProfileId: z.number().int().min(0).nullable().optional(),
	defaultRootFolderPath: z.string().min(1).nullable().optional(),
	defaultSeasonFolder: z.boolean().nullable().optional(),
	storageGroupId: z.string().min(1).max(64).nullable().optional(),
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
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	app.get("/services", async (request, reply) => {
		try {
			const instances = await app.prisma.serviceInstance.findMany({
				where: { userId: request.currentUser?.id },
				include: {
					tags: {
						include: {
							tag: true,
						},
					},
				},
				orderBy: { createdAt: "asc" },
			});

			const formatted = instances.map(formatServiceInstance);
			return reply.send({ services: formatted });
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch service instances");
			return reply.status(500).send({ error: "Failed to fetch service instances" });
		}
	});

	app.post("/services", async (request, reply) => {
		const parsed = servicePayloadSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		try {
			const { apiKey, service, tags, isDefault, ...rest } = parsed.data;
			const encrypted = app.encryptor.encrypt(apiKey);

			const serviceEnum = service.toUpperCase() as ServiceType;

			if (isDefault) {
				await app.prisma.serviceInstance.updateMany({
					where: { service: serviceEnum },
					data: { isDefault: false },
				});
			}

			const tagRecords = await upsertTags(app.prisma, tags);

			const created = await app.prisma.serviceInstance.create({
				data: {
					userId: request.currentUser!.id, // preHandler guarantees auth
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
				service: formatServiceInstance(created),
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to create service instance");
			return reply.status(500).send({ error: "Failed to create service instance" });
		}
	});

	app.put("/services/:id", async (request, reply) => {
		const { id } = request.params as { id: string };
		const parsed = serviceUpdateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		try {
			const payload = parsed.data;
			const userId = request.currentUser?.id; // preHandler guarantees authentication

			// Verify instance exists and is owned by the current user.
			// Including userId in the where clause ensures non-owned instances return null,
			// preventing instance enumeration attacks (all non-owned instances return 404).
			const existing = await app.prisma.serviceInstance.findFirst({
				where: {
					id,
					userId,
				},
			});

			if (!existing) {
				return reply.status(404).send({ error: "Service instance not found" });
			}

			const updateData = buildUpdateData(payload, app.encryptor);

			if (payload.isDefault === true || payload.service) {
				const targetService = (
					payload.service ?? existing.service.toLowerCase()
				).toUpperCase() as ServiceType;
				await app.prisma.serviceInstance.updateMany({
					where: { service: targetService, NOT: { id } },
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
				await updateInstanceTags(app.prisma, id, payload.tags);
			}

			// Fetch updated instance - include userId to ensure we only get owned instances
			const fresh = await app.prisma.serviceInstance.findFirst({
				where: {
					id,
					userId,
				},
				include: { tags: { include: { tag: true } } },
			});

			if (!fresh) {
				return reply.status(404).send({ error: "Service instance not found" });
			}

			return reply.send({
				service: formatServiceInstance(fresh),
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to update service instance");
			return reply.status(500).send({ error: "Failed to update service instance" });
		}
	});

	app.delete("/services/:id", async (request, reply) => {
		const { id } = request.params as { id: string };
		const userId = request.currentUser?.id; // preHandler guarantees authentication

		try {
			// Verify instance exists and is owned by the current user.
			// Including userId in the where clause ensures non-owned instances return null,
			// preventing instance enumeration attacks (all non-owned instances return 404).
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id,
					userId,
				},
			});

			if (!instance) {
				return reply.status(404).send({ error: "Service instance not found" });
			}

			await app.prisma.serviceInstance.delete({ where: { id } });
			return reply.status(204).send();
		} catch (error) {
			request.log.error({ err: error }, "Failed to delete service instance");
			return reply.status(500).send({ error: "Failed to delete service instance" });
		}
	});

	app.get("/tags", async (request, reply) => {
		try {
			const tags = await app.prisma.serviceTag.findMany({
				orderBy: { name: "asc" },
			});

			return reply.send({ tags });
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch tags");
			return reply.status(500).send({ error: "Failed to fetch tags" });
		}
	});

	app.post("/tags", async (request, reply) => {
		const parsed = tagCreateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		try {
			const tag = await app.prisma.serviceTag.upsert({
				where: { name: parsed.data.name },
				update: {},
				create: { name: parsed.data.name },
			});

			return reply.status(201).send({ tag });
		} catch (error) {
			request.log.error({ err: error }, "Failed to create tag");
			return reply.status(500).send({ error: "Failed to create tag" });
		}
	});

	app.delete("/tags/:id", async (request, reply) => {
		const { id } = request.params as { id: string };

		try {
			await app.prisma.serviceTag.delete({
				where: { id },
			});
			return reply.status(204).send();
		} catch (error) {
			// Prisma P2025 = Record not found
			const prismaError = error as { code?: string };
			if (prismaError.code === "P2025") {
				return reply.status(404).send({ error: "Tag not found" });
			}
			request.log.error({ err: error }, "Failed to delete tag");
			return reply.status(500).send({ error: "Failed to delete tag" });
		}
	});

	app.post("/services/test-connection", async (request, reply) => {
		const payload = request.body as {
			baseUrl?: unknown;
			apiKey?: unknown;
			service?: unknown;
		};
		const baseUrl = typeof payload?.baseUrl === "string" ? payload.baseUrl : undefined;
		const apiKey = typeof payload?.apiKey === "string" ? payload.apiKey : undefined;
		const service =
			typeof payload?.service === "string" ? payload.service.toLowerCase() : undefined;

		if (!baseUrl || !apiKey || !service) {
			return reply.status(400).send({
				error: "Missing required fields",
				details: "baseUrl, apiKey, and service are required",
			});
		}

		if (!["sonarr", "radarr", "prowlarr", "lidarr", "readarr"].includes(service)) {
			return reply.status(400).send({
				error: "Invalid service type",
				details: "Service must be sonarr, radarr, prowlarr, lidarr, or readarr",
			});
		}

		try {
			const result = await testServiceConnection(baseUrl, apiKey, service);
			return reply.status(200).send(result);
		} catch (error) {
			request.log.error({ err: error }, "Failed to test service connection");
			return reply.status(500).send({ error: "Failed to test service connection" });
		}
	});

	app.post("/services/:id/test", async (request, reply) => {
		const { id } = request.params as { id: string };
		const userId = request.currentUser?.id; // preHandler guarantees authentication

		try {
			// Verify instance exists and is owned by the current user.
			// Including userId in the where clause ensures non-owned instances return null,
			// preventing instance enumeration attacks (all non-owned instances return 404).
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id,
					userId,
				},
			});

			if (!instance) {
				return reply.status(404).send({ error: "Service instance not found" });
			}

			const apiKey = app.encryptor.decrypt({
				value: instance.encryptedApiKey,
				iv: instance.encryptionIv,
			});
			const service = instance.service.toLowerCase();

			const result = await testServiceConnection(instance.baseUrl, apiKey, service);
			return reply.status(200).send(result);
		} catch (error) {
			request.log.error({ err: error }, "Failed to test service instance connection");
			return reply.status(500).send({ error: "Failed to test service instance connection" });
		}
	});

	done();
};

export const registerServiceRoutes = servicesRoute;
