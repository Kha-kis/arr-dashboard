/**
 * User Custom Format Routes
 *
 * CRUD operations for user-created custom formats.
 * Users can create CFs from scratch, import from JSON, or import from connected instances.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
	createUserCustomFormatSchema,
	updateUserCustomFormatSchema,
	importUserCFFromJsonSchema,
	importUserCFFromInstanceSchema,
} from "@arr/shared";
import type { SonarrClient, RadarrClient } from "arr-sdk";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize specification fields from array format to object format for storage.
 * Sonarr/Radarr APIs return fields as [{name, value}], but we store as {name: value}.
 */
function normalizeFields(
	fields: Record<string, unknown> | Array<{ name: string; value: unknown }> | null | undefined,
): Record<string, unknown> {
	if (!fields) return {};
	if (Array.isArray(fields)) {
		const obj: Record<string, unknown> = {};
		for (const field of fields) {
			obj[field.name] = field.value;
		}
		return obj;
	}
	return fields;
}

// ============================================================================
// Route Registration
// ============================================================================

export async function registerUserCustomFormatRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /user-custom-formats
	 * List user custom formats with optional serviceType filter
	 */
	app.get<{
		Querystring: { serviceType?: string };
	}>("/", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { serviceType } = request.query;

		const where: { userId: string; serviceType?: string } = { userId };
		if (serviceType && (serviceType === "RADARR" || serviceType === "SONARR")) {
			where.serviceType = serviceType;
		}

		const customFormats = await app.prisma.userCustomFormat.findMany({
			where,
			orderBy: [{ serviceType: "asc" }, { name: "asc" }],
		});

		return reply.send({
			success: true,
			customFormats: customFormats.map((cf) => ({
				...cf,
				specifications: JSON.parse(cf.specifications),
			})),
			count: customFormats.length,
		});
	});

	/**
	 * POST /user-custom-formats
	 * Create a new user custom format
	 */
	app.post("/", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { name, serviceType, description, includeCustomFormatWhenRenaming, specifications, defaultScore } =
			validateRequest(createUserCustomFormatSchema, request.body);

		// Check for duplicate name
		const existing = await app.prisma.userCustomFormat.findFirst({
			where: { userId, name, serviceType },
		});

		if (existing) {
			return reply.status(409).send({
				error: "DUPLICATE",
				message: `A custom format named "${name}" already exists for ${serviceType}`,
			});
		}

		const cf = await app.prisma.userCustomFormat.create({
			data: {
				userId,
				name,
				serviceType,
				description: description ?? null,
				includeCustomFormatWhenRenaming,
				specifications: JSON.stringify(specifications),
				defaultScore,
			},
		});

		return reply.status(201).send({
			success: true,
			customFormat: {
				...cf,
				specifications: JSON.parse(cf.specifications),
			},
		});
	});

	/**
	 * PUT /user-custom-formats/:id
	 * Update an existing user custom format
	 */
	app.put<{
		Params: { id: string };
	}>("/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = request.params;
		const parsed = validateRequest(updateUserCustomFormatSchema, request.body);

		// Verify ownership
		const existing = await app.prisma.userCustomFormat.findFirst({
			where: { id, userId },
		});

		if (!existing) {
			return reply.status(404).send({
				error: "NOT_FOUND",
				message: "Custom format not found",
			});
		}

		const data: Record<string, unknown> = {};
		if (parsed.name !== undefined) data.name = parsed.name;
		if (parsed.serviceType !== undefined) data.serviceType = parsed.serviceType;
		if (parsed.description !== undefined) data.description = parsed.description;
		if (parsed.includeCustomFormatWhenRenaming !== undefined) data.includeCustomFormatWhenRenaming = parsed.includeCustomFormatWhenRenaming;
		if (parsed.specifications !== undefined) data.specifications = JSON.stringify(parsed.specifications);
		if (parsed.defaultScore !== undefined) data.defaultScore = parsed.defaultScore;

		// Check name uniqueness if name or serviceType changed
		if (data.name || data.serviceType) {
			const checkName = (data.name as string) || existing.name;
			const checkServiceType = (data.serviceType as string) || existing.serviceType;
			const duplicate = await app.prisma.userCustomFormat.findFirst({
				where: {
					userId,
					name: checkName,
					serviceType: checkServiceType,
					id: { not: id },
				},
			});
			if (duplicate) {
				return reply.status(409).send({
					error: "DUPLICATE",
					message: `A custom format named "${checkName}" already exists for ${checkServiceType}`,
				});
			}
		}

		const updated = await app.prisma.userCustomFormat.update({
			where: { id },
			data,
		});

		return reply.send({
			success: true,
			customFormat: {
				...updated,
				specifications: JSON.parse(updated.specifications),
			},
		});
	});

	/**
	 * DELETE /user-custom-formats/:id
	 * Delete a user custom format
	 */
	app.delete<{
		Params: { id: string };
	}>("/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = request.params;

		const existing = await app.prisma.userCustomFormat.findFirst({
			where: { id, userId },
		});

		if (!existing) {
			return reply.status(404).send({
				error: "NOT_FOUND",
				message: "Custom format not found",
			});
		}

		await app.prisma.userCustomFormat.delete({ where: { id } });

		return reply.send({
			success: true,
			message: `Deleted custom format "${existing.name}"`,
		});
	});

	/**
	 * POST /user-custom-formats/import-json
	 * Import custom formats from Sonarr/Radarr JSON export
	 */
	app.post("/import-json", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { serviceType, customFormats, defaultScore } =
			validateRequest(importUserCFFromJsonSchema, request.body);

		const results = {
			created: [] as string[],
			skipped: [] as string[],
			failed: [] as Array<{ name: string; error: string }>,
		};

		// Loop-level error collection — KEEP
		for (const cf of customFormats) {
			try {
				// Check for duplicate
				const existing = await app.prisma.userCustomFormat.findFirst({
					where: { userId, name: cf.name, serviceType },
				});

				if (existing) {
					results.skipped.push(cf.name);
					continue;
				}

				// Normalize specification fields from array to object format
				const normalizedSpecs = (cf.specifications || []).map((spec) => ({
					name: spec.name,
					implementation: spec.implementation,
					negate: spec.negate ?? false,
					required: spec.required ?? false,
					fields: normalizeFields(spec.fields as any),
				}));

				await app.prisma.userCustomFormat.create({
					data: {
						userId,
						name: cf.name,
						serviceType,
						includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming ?? false,
						specifications: JSON.stringify(normalizedSpecs),
						defaultScore: defaultScore ?? 0,
					},
				});

				results.created.push(cf.name);
			} catch (error) {
				results.failed.push({
					name: cf.name,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		return reply.send({
			success: results.failed.length === 0,
			...results,
		});
	});

	/**
	 * POST /user-custom-formats/import-from-instance
	 * Import custom formats from a connected Sonarr/Radarr instance
	 */
	app.post("/import-from-instance", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId, cfIds, defaultScore } =
			validateRequest(importUserCFFromInstanceSchema, request.body);

		const instance = await requireInstance(app, userId, instanceId);

		const serviceType = instance.service === "SONARR" ? "SONARR" : "RADARR";

		// Create SDK client
		const client = app.arrClientFactory.create(instance) as SonarrClient | RadarrClient;
		const allCFs = await client.customFormat.getAll();

		// Filter to requested CF IDs
		const selectedCFs = allCFs.filter((cf) => cf.id !== undefined && cfIds.includes(cf.id));

		if (selectedCFs.length === 0) {
			return reply.status(404).send({
				error: "NOT_FOUND",
				message: "No matching custom formats found in instance",
			});
		}

		const results = {
			created: [] as string[],
			skipped: [] as string[],
			failed: [] as Array<{ name: string; error: string }>,
		};

		// Loop-level error collection — KEEP
		for (const cf of selectedCFs) {
			const cfName = cf.name || `CF-${cf.id}`;
			try {
				// Check for duplicate
				const existing = await app.prisma.userCustomFormat.findFirst({
					where: { userId, name: cfName, serviceType },
				});

				if (existing) {
					results.skipped.push(cfName);
					continue;
				}

				// Normalize specifications
				const specs = ((cf as any).specifications || []).map((spec: any) => ({
					name: spec.name || "",
					implementation: spec.implementation || "",
					negate: spec.negate ?? false,
					required: spec.required ?? false,
					fields: normalizeFields(spec.fields),
				}));

				await app.prisma.userCustomFormat.create({
					data: {
						userId,
						name: cfName,
						serviceType,
						includeCustomFormatWhenRenaming: (cf as any).includeCustomFormatWhenRenaming ?? false,
						specifications: JSON.stringify(specs),
						defaultScore: defaultScore ?? 0,
						sourceInstanceId: instanceId,
						sourceCFId: cf.id,
					},
				});

				results.created.push(cfName);
			} catch (error) {
				results.failed.push({
					name: cfName,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		return reply.send({
			success: results.failed.length === 0,
			...results,
		});
	});

	/**
	 * POST /user-custom-formats/deploy
	 * Deploy user custom formats to an instance
	 */
	app.post<{
		Body: {
			userCFIds: string[];
			instanceId: string;
		};
	}>("/deploy", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { userCFIds, instanceId } = request.body as { userCFIds: string[]; instanceId: string };

		if (!userCFIds?.length || !instanceId) {
			return reply.status(400).send({
				error: "VALIDATION_ERROR",
				message: "userCFIds and instanceId are required",
			});
		}

		const instance = await requireInstance(app, userId, instanceId);

		// Fetch user custom formats
		const userCFs = await app.prisma.userCustomFormat.findMany({
			where: {
				id: { in: userCFIds },
				userId,
			},
		});

		if (userCFs.length === 0) {
			return reply.status(404).send({
				error: "NOT_FOUND",
				message: "No matching user custom formats found",
			});
		}

		const client = app.arrClientFactory.create(instance) as SonarrClient | RadarrClient;

		// Get existing CFs for dedup by name
		const existingFormats = await client.customFormat.getAll();
		const existingByName = new Map<string, (typeof existingFormats)[number]>();
		for (const cf of existingFormats) {
			if (cf.name) existingByName.set(cf.name, cf);
		}

		const results = {
			created: [] as string[],
			updated: [] as string[],
			failed: [] as Array<{ name: string; error: string }>,
		};

		// Loop-level error collection — KEEP
		for (const userCF of userCFs) {
			try {
				const specs = JSON.parse(userCF.specifications);

				// Transform fields from object to array format for the ARR API
				const transformedSpecs = specs.map((spec: any) => ({
					...spec,
					fields: Object.entries(spec.fields || {}).map(([name, value]) => ({ name, value })),
				}));

				const existing = existingByName.get(userCF.name);

				if (existing?.id) {
					const updatedCF = {
						...existing,
						name: userCF.name,
						includeCustomFormatWhenRenaming: userCF.includeCustomFormatWhenRenaming,
						specifications: transformedSpecs,
					};
					await client.customFormat.update(
						existing.id,
						updatedCF as unknown as Parameters<typeof client.customFormat.update>[1],
					);
					results.updated.push(userCF.name);
				} else {
					const newCF = {
						name: userCF.name,
						includeCustomFormatWhenRenaming: userCF.includeCustomFormatWhenRenaming,
						specifications: transformedSpecs,
					};
					await client.customFormat.create(
						newCF as unknown as Parameters<typeof client.customFormat.create>[0],
					);
					results.created.push(userCF.name);
				}
			} catch (error) {
				results.failed.push({
					name: userCF.name,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		return reply.send({
			success: results.failed.length === 0,
			...results,
		});
	});

	/**
	 * GET /user-custom-formats/instance-cfs/:instanceId
	 * List all custom formats from a connected instance (for import picker)
	 */
	app.get<{
		Params: { instanceId: string };
	}>("/instance-cfs/:instanceId", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId } = request.params;

		const instance = await requireInstance(app, userId, instanceId);

		const client = app.arrClientFactory.create(instance) as SonarrClient | RadarrClient;
		const allCFs = await client.customFormat.getAll();

		return reply.send({
			success: true,
			data: allCFs
				.filter((cf) => cf.id !== undefined && cf.name)
				.map((cf) => ({
					id: cf.id,
					name: cf.name,
				})),
		});
	});
}
