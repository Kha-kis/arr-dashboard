import { ALL_SERVICES, arrServiceTypeSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { requireInstance } from "../lib/arr/instance-helpers.js";
import { clearFileIdIndexCache } from "../lib/library-sync/infohash-backfill-by-inode.js";
import type { ServiceType } from "../lib/prisma.js";
import { invalidateTorrentListCache } from "../lib/qui/torrent-list-cache.js";
import { testServiceConnection } from "../lib/services/connection-tester.js";
import { formatServiceInstance } from "../lib/services/service-formatter.js";
import { updateInstanceTags, upsertTags } from "../lib/services/tag-manager.js";
import { buildUpdateData } from "../lib/services/update-builder.js";
import { validateRequest } from "../lib/utils/validate.js";

const idParams = z.object({ id: z.string().min(1) });

const servicePayloadSchema = z.object({
	label: z.string().min(1).max(120),
	baseUrl: z.string().url(),
	externalUrl: z.string().url().nullable().optional(), // Optional browser-accessible URL for reverse proxy setups
	apiKey: z.string().min(8),
	service: arrServiceTypeSchema,
	enabled: z.boolean().default(true),
	isDefault: z.boolean().default(false),
	tags: z.array(z.string().min(1).max(64)).default([]),
	storageGroupId: z.string().min(1).max(64).nullable().optional(),
	// qui-only: enables inode-based hardlink correlation. When true,
	// arr-dashboard reads files directly via stat() to verify which
	// library files are hardlinked to which qui torrents. Requires the
	// arr-dashboard process to have read access to both the qBit content
	// tree and the *arr library tree. Mirrors qui's own
	// `HasLocalFilesystemAccess` per-instance toggle.
	hasLocalFilesystemAccess: z.boolean().default(false),
	// qui-only: optional prefix rewrite for paths reported by qui that
	// arr-dashboard sees at a different mount point. Format:
	// "qui-prefix>local-prefix" (e.g., "/downloads>/qbit-data"). Empty/null
	// = no rewrite. Capped at 256 chars to bound config sprawl.
	pathPrefix: z.string().max(256).nullable().optional(),
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
	app.get("/services", async (request, reply) => {
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser!.id },
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
	});

	app.post("/services", async (request, reply) => {
		const { apiKey, service, tags, isDefault, ...rest } = validateRequest(
			servicePayloadSchema,
			request.body,
		);

		const encrypted = app.encryptor.encrypt(apiKey);

		const serviceEnum = service.toUpperCase() as ServiceType;

		if (isDefault) {
			await app.prisma.serviceInstance.updateMany({
				where: { service: serviceEnum, userId: request.currentUser!.id },
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

		request.log.info({ service, label: rest.label }, "Service instance added");

		return reply.status(201).send({
			service: formatServiceInstance(created),
		});
	});

	app.put("/services/:id", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const payload = validateRequest(serviceUpdateSchema, request.body);
		const userId = request.currentUser!.id;
		const existing = await requireInstance(app, userId, id);

		const updateData = buildUpdateData(payload, app.encryptor);

		if (payload.isDefault === true || payload.service) {
			const targetService = (
				payload.service ?? existing.service.toLowerCase()
			).toUpperCase() as ServiceType;
			await app.prisma.serviceInstance.updateMany({
				where: { service: targetService, userId, NOT: { id } },
				data: { isDefault: false },
			});
		}

		await app.prisma.serviceInstance.updateMany({
			where: { id, userId },
			data: updateData,
		});

		if (payload.tags) {
			await updateInstanceTags(app.prisma, id, payload.tags);
		}

		// Drop process-local qui caches when a qui instance becomes
		// unreachable from this app's perspective — either disabled
		// (enabled: true → false) or its service type changed away from
		// QUI. Mirrors the DELETE handler's invalidation but for the
		// "kept but inert" case. Without this, a disabled instance's
		// inode index + torrent list would sit in memory for the rest
		// of the process lifetime (TTL is read-only; nothing reads a
		// disabled instance, so no self-healing). No-op for non-qui
		// services because the keys won't be in those caches.
		const wasQui = existing.service === "QUI";
		const nowDisabled = payload.enabled === false && existing.enabled === true;
		const switchedAwayFromQui =
			payload.service !== undefined && payload.service.toLowerCase() !== "qui";
		if (wasQui && (nowDisabled || switchedAwayFromQui)) {
			invalidateTorrentListCache(id);
			clearFileIdIndexCache(id);
			request.log.info(
				{ instanceId: id, reason: nowDisabled ? "disabled" : "service-changed" },
				"qui caches dropped after instance update",
			);
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

		request.log.info(
			{ service: fresh.service, label: fresh.label, instanceId: id },
			"Service instance updated",
		);

		return reply.send({
			service: formatServiceInstance(fresh),
		});
	});

	app.delete("/services/:id", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		await requireInstance(app, userId, id);
		await app.prisma.serviceInstance.delete({ where: { id, userId } });

		// Free any process-local qui caches keyed to this instance. Both
		// the torrent-list cache and the inode index retain heavy entries
		// (TTL-checked on read only — a stale entry self-heals, but a
		// deleted instance is never read again, so its entry would linger
		// for the whole process life). No-op for non-qui services: the id
		// simply isn't a key in those caches.
		invalidateTorrentListCache(id);
		clearFileIdIndexCache(id);

		request.log.info({ instanceId: id }, "Service instance deleted");
		return reply.status(204).send();
	});

	app.get("/tags", async (_request, reply) => {
		const tags = await app.prisma.serviceTag.findMany({
			orderBy: { name: "asc" },
		});

		return reply.send({ tags });
	});

	app.post("/tags", async (request, reply) => {
		const { name } = validateRequest(tagCreateSchema, request.body);

		const tag = await app.prisma.serviceTag.upsert({
			where: { name },
			update: {},
			create: { name },
		});

		return reply.status(201).send({ tag });
	});

	app.delete("/tags/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(idParams, request.params);

		// Only delete tags that are associated with the current user's instances
		// (ServiceTag is shared, so verify at least one of the user's instances uses it)
		const userTag = await app.prisma.serviceInstanceTag.findFirst({
			where: { tagId: id, instance: { userId } },
		});

		if (!userTag) {
			return reply.status(404).send({ error: "Tag not found" });
		}

		await app.prisma.serviceTag.delete({
			where: { id },
		});
		return reply.status(204).send();
	});

	app.post("/services/test-connection", async (request, reply) => {
		const { baseUrl, apiKey, service } = validateRequest(
			z.object({
				baseUrl: z.string().min(1),
				apiKey: z.string().min(1),
				service: z
					.string()
					.min(1)
					.transform((s) => s.toLowerCase()),
			}),
			request.body,
		);

		// Validate URL scheme to prevent SSRF with non-HTTP schemes
		try {
			const parsed = new URL(baseUrl);
			if (!["http:", "https:"].includes(parsed.protocol)) {
				return reply.status(400).send({
					error: "Invalid URL scheme",
					details: "Base URL must use http:// or https://",
				});
			}
		} catch {
			return reply.status(400).send({
				error: "Invalid URL",
				details: "Base URL must be a valid URL",
			});
		}

		if (!(ALL_SERVICES as readonly string[]).includes(service)) {
			return reply.status(400).send({
				error: "Invalid service type",
				details: `Service must be one of: ${ALL_SERVICES.join(", ")}`,
			});
		}

		const result = await testServiceConnection(baseUrl, apiKey, service);
		if (!result.success) {
			request.log.warn({ service, baseUrl }, "Connection test failed");

			app.notificationService
				?.notify({
					eventType: "SERVICE_CONNECTION_FAILED",
					title: `Connection test failed for ${service}`,
					body: result.error ?? `Failed to connect to ${service} at ${baseUrl}`,
					metadata: {
						service,
						baseUrl,
					},
				})
				.catch((err) => {
					request.log.warn({ err }, "Service connection failed notification dispatch failed");
				});
		}
		return reply.status(200).send(result);
	});

	app.post("/services/:id/test", async (request, reply) => {
		const { id } = validateRequest(idParams, request.params);
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		const instance = await requireInstance(app, userId, id);

		const apiKey = app.encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		});
		const service = instance.service.toLowerCase();

		const result = await testServiceConnection(instance.baseUrl, apiKey, service);
		return reply.status(200).send(result);
	});

	done();
};

export const registerServiceRoutes = servicesRoute;
