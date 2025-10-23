/**
 * Custom Formats Routes - Manual CRUD Management
 * Allows manual creation, editing, and deletion of custom formats across instances
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CustomFormatSchema } from "@arr/shared"; // Exported from profiles.ts
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";

// Request schemas
const GetCustomFormatsQuerySchema = z.object({
	instanceId: z.string().optional(),
});

const CreateCustomFormatSchema = z.object({
	instanceId: z.string(),
	customFormat: CustomFormatSchema.omit({ id: true }),
});

const UpdateCustomFormatSchema = z.object({
	instanceId: z.string(),
	customFormatId: z.number(),
	customFormat: CustomFormatSchema.partial().omit({ id: true }),
});

const DeleteCustomFormatSchema = z.object({
	instanceId: z.string(),
	customFormatId: z.number(),
});

const CopyCustomFormatSchema = z.object({
	sourceInstanceId: z.string(),
	targetInstanceId: z.string(),
	customFormatId: z.number(),
});

const ImportCustomFormatSchema = z.object({
	instanceId: z.string(),
	customFormat: CustomFormatSchema.omit({ id: true }),
});

/**
 * Transform custom format from API format to clean export format
 * Removes UI metadata and converts fields array to object
 */
function transformToExportFormat(customFormat: any): any {
	const { id, ...baseFormat } = customFormat;

	return {
		...baseFormat,
		specifications: customFormat.specifications?.map((spec: any) => {
			// Convert fields array to object (key-value pairs)
			const fieldsObj: Record<string, any> = {};
			if (Array.isArray(spec.fields)) {
				for (const field of spec.fields) {
					if (field.name && field.value !== undefined) {
						fieldsObj[field.name] = field.value;
					}
				}
			} else if (spec.fields && typeof spec.fields === 'object') {
				// Already in object format
				Object.assign(fieldsObj, spec.fields);
			}

			// Keep only essential specification fields
			return {
				name: spec.name,
				implementation: spec.implementation,
				negate: spec.negate,
				required: spec.required,
				fields: fieldsObj,
			};
		}) || [],
	};
}

export async function customFormatsRoutes(app: FastifyInstance) {
	// ========================================================================
	// Get All Custom Formats
	// ========================================================================

	app.get("/api/custom-formats", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const queryValidation = GetCustomFormatsQuerySchema.safeParse(
			request.query,
		);
		if (!queryValidation.success) {
			return reply.code(400).send({
				error: "Invalid query parameters",
				details: queryValidation.error.errors,
			});
		}

		const { instanceId } = queryValidation.data;

		try {
			// Get instances (either specific one or all Sonarr/Radarr instances)
			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					...(instanceId ? { id: instanceId } : {}),
					service: { in: ["SONARR", "RADARR"] },
				},
			});

			// Fetch custom formats from each instance
			app.log.info(`Fetching custom formats from ${instances.length} instances`);

			const results = await Promise.all(
				instances.map(async (instance) => {
					try {
						const fetcher = createInstanceFetcher(app, instance);
						const response = await fetcher("/api/v3/customformat");
						const customFormats = await response.json();

						app.log.info({
							instanceLabel: instance.label,
							instanceService: instance.service,
							responseType: Array.isArray(customFormats) ? 'array' : typeof customFormats,
							count: Array.isArray(customFormats) ? customFormats.length : 'N/A',
							sampleData: Array.isArray(customFormats) && customFormats.length > 0
								? { id: customFormats[0].id, name: customFormats[0].name }
								: customFormats,
						}, `Custom formats fetched from ${instance.label}`);

						return {
							instanceId: instance.id,
							instanceLabel: instance.label,
							instanceService: instance.service,
							customFormats,
							error: null,
						};
					} catch (error) {
						app.log.error({
							instanceLabel: instance.label,
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined,
						}, `Failed to fetch custom formats from ${instance.label}`);

						return {
							instanceId: instance.id,
							instanceLabel: instance.label,
							instanceService: instance.service,
							customFormats: [],
							error:
								error instanceof Error ? error.message : String(error),
						};
					}
				}),
			);

			return reply.send({ instances: results });
		} catch (error) {
			app.log.error("Failed to get custom formats:", error);
			return reply.code(500).send({
				error: "Failed to get custom formats",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get Custom Format Schema (for new format creation)
	// ========================================================================

	app.get(
		"/api/custom-formats/schema/:instanceId",
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.code(401).send({ error: "Unauthorized" });
			}

			const { instanceId } = request.params as { instanceId: string };

			try {
				const instance = await app.prisma.serviceInstance.findUnique({
					where: { id: instanceId },
				});

				if (!instance) {
					return reply.code(404).send({ error: "Instance not found" });
				}

				if (
					instance.service !== "SONARR" &&
					instance.service !== "RADARR"
				) {
					return reply.code(400).send({
						error: `Instance service ${instance.service} does not support custom formats`,
					});
				}

				const fetcher = createInstanceFetcher(app, instance);
				const response = await fetcher("/api/v3/customformat/schema");
				const schema = await response.json();

				return reply.send(schema);
			} catch (error) {
				app.log.error("Failed to get custom format schema:", error);
				return reply.code(500).send({
					error: "Failed to get custom format schema",
					details:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	);

	// ========================================================================
	// Get Single Custom Format
	// ========================================================================

	app.get(
		"/api/custom-formats/:instanceId/:customFormatId",
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.code(401).send({ error: "Unauthorized" });
			}

			const { instanceId, customFormatId } = request.params as {
				instanceId: string;
				customFormatId: string;
			};

			try {
				const instance = await app.prisma.serviceInstance.findUnique({
					where: { id: instanceId },
				});

				if (!instance) {
					return reply.code(404).send({ error: "Instance not found" });
				}

				if (
					instance.service !== "SONARR" &&
					instance.service !== "RADARR"
				) {
					return reply.code(400).send({
						error: `Instance service ${instance.service} does not support custom formats`,
					});
				}

				const fetcher = createInstanceFetcher(app, instance);
				const response = await fetcher(
					`/api/v3/customformat/${customFormatId}`,
				);
				const customFormat = await response.json();

				return reply.send(customFormat);
			} catch (error) {
				app.log.error("Failed to get custom format:", error);
				return reply.code(500).send({
					error: "Failed to get custom format",
					details:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	);

	// ========================================================================
	// Create Custom Format
	// ========================================================================

	app.post("/api/custom-formats", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = CreateCustomFormatSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { instanceId, customFormat } = validation.data;

		try {
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			if (instance.service !== "SONARR" && instance.service !== "RADARR") {
				return reply.code(400).send({
					error: `Instance service ${instance.service} does not support custom formats`,
				});
			}

			const fetcher = createInstanceFetcher(app, instance);
			const response = await fetcher("/api/v3/customformat", {
				method: "POST",
				body: JSON.stringify(customFormat),
			});
			const created = await response.json();

			return reply.code(201).send(created);
		} catch (error) {
			app.log.error("Failed to create custom format:", error);
			return reply.code(500).send({
				error: "Failed to create custom format",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Update Custom Format
	// ========================================================================

	app.put(
		"/api/custom-formats/:instanceId/:customFormatId",
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.code(401).send({ error: "Unauthorized" });
			}

			const { instanceId, customFormatId } = request.params as {
				instanceId: string;
				customFormatId: string;
			};

			const customFormatValidation = CustomFormatSchema.partial()
				.omit({ id: true })
				.safeParse(request.body);

			if (!customFormatValidation.success) {
				return reply.code(400).send({
					error: "Invalid custom format data",
					details: customFormatValidation.error.errors,
				});
			}

			try {
				const instance = await app.prisma.serviceInstance.findUnique({
					where: { id: instanceId },
				});

				if (!instance) {
					return reply.code(404).send({ error: "Instance not found" });
				}

				if (
					instance.service !== "SONARR" &&
					instance.service !== "RADARR"
				) {
					return reply.code(400).send({
						error: `Instance service ${instance.service} does not support custom formats`,
					});
				}

				const fetcher = createInstanceFetcher(app, instance);

				// First, get the existing custom format to merge changes
				const existingResponse = await fetcher(
					`/api/v3/customformat/${customFormatId}`,
				);
				const existing = await existingResponse.json();

				// Merge the changes
				const updated = {
					...existing,
					...customFormatValidation.data,
					id: Number(customFormatId), // Ensure ID is preserved
				};

				// Update via API
				const resultResponse = await fetcher(
					`/api/v3/customformat/${customFormatId}`,
					{
						method: "PUT",
						body: JSON.stringify(updated),
					},
				);
				const result = await resultResponse.json();

				return reply.send(result);
			} catch (error) {
				app.log.error("Failed to update custom format:", error);
				return reply.code(500).send({
					error: "Failed to update custom format",
					details:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	);

	// ========================================================================
	// Delete Custom Format
	// ========================================================================

	app.delete(
		"/api/custom-formats/:instanceId/:customFormatId",
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.code(401).send({ error: "Unauthorized" });
			}

			const { instanceId, customFormatId } = request.params as {
				instanceId: string;
				customFormatId: string;
			};

			try {
				const instance = await app.prisma.serviceInstance.findUnique({
					where: { id: instanceId },
				});

				if (!instance) {
					return reply.code(404).send({ error: "Instance not found" });
				}

				if (
					instance.service !== "SONARR" &&
					instance.service !== "RADARR"
				) {
					return reply.code(400).send({
						error: `Instance service ${instance.service} does not support custom formats`,
					});
				}

				const fetcher = createInstanceFetcher(app, instance);
				await fetcher(`/api/v3/customformat/${customFormatId}`, {
					method: "DELETE",
				});

				return reply.code(204).send();
			} catch (error) {
				app.log.error("Failed to delete custom format:", error);
				return reply.code(500).send({
					error: "Failed to delete custom format",
					details:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	);

	// ========================================================================
	// Copy Custom Format Between Instances
	// ========================================================================

	app.post("/api/custom-formats/copy", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = CopyCustomFormatSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { sourceInstanceId, targetInstanceId, customFormatId } =
			validation.data;

		try {
			// Get both instances
			const [sourceInstance, targetInstance] = await Promise.all([
				app.prisma.serviceInstance.findUnique({
					where: { id: sourceInstanceId },
				}),
				app.prisma.serviceInstance.findUnique({
					where: { id: targetInstanceId },
				}),
			]);

			if (!sourceInstance || !targetInstance) {
				return reply.code(404).send({
					error: "Source or target instance not found",
				});
			}

			// Both must support custom formats
			if (
				(sourceInstance.service !== "SONARR" &&
					sourceInstance.service !== "RADARR") ||
				(targetInstance.service !== "SONARR" &&
					targetInstance.service !== "RADARR")
			) {
				return reply.code(400).send({
					error: "Both instances must be Sonarr or Radarr",
				});
			}

			// Fetch the custom format from source
			const sourceFetcher = createInstanceFetcher(app, sourceInstance);
			const sourceResponse = await sourceFetcher(
				`/api/v3/customformat/${customFormatId}`,
			);
			const customFormat = await sourceResponse.json();

			// Transform to clean format (removes UI metadata, converts fields)
			const cleanFormat = transformToExportFormat(customFormat);

			// Create on target
			const targetFetcher = createInstanceFetcher(app, targetInstance);
			const targetResponse = await targetFetcher("/api/v3/customformat", {
				method: "POST",
				body: JSON.stringify(cleanFormat),
			});
			const created = await targetResponse.json();

			return reply.code(201).send({
				message: "Custom format copied successfully",
				sourceId: customFormatId,
				targetId: created.id,
				customFormat: created,
			});
		} catch (error) {
			app.log.error("Failed to copy custom format:", error);
			return reply.code(500).send({
				error: "Failed to copy custom format",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Export Custom Format as JSON
	// ========================================================================

	app.get(
		"/api/custom-formats/:instanceId/:customFormatId/export",
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.code(401).send({ error: "Unauthorized" });
			}

			const { instanceId, customFormatId } = request.params as {
				instanceId: string;
				customFormatId: string;
			};

			try {
				const instance = await app.prisma.serviceInstance.findUnique({
					where: { id: instanceId },
				});

				if (!instance) {
					return reply.code(404).send({ error: "Instance not found" });
				}

				if (
					instance.service !== "SONARR" &&
					instance.service !== "RADARR"
				) {
					return reply.code(400).send({
						error: `Instance service ${instance.service} does not support custom formats`,
					});
				}

				const fetcher = createInstanceFetcher(app, instance);
				const response = await fetcher(
					`/api/v3/customformat/${customFormatId}`,
				);
				const customFormat = await response.json();

				// Transform to clean export format (removes UI metadata, converts fields)
				const exportData = transformToExportFormat(customFormat);

				// Set content disposition header for file download
				const filename = `${customFormat.name?.replace(/[^a-z0-9]/gi, "_").toLowerCase() || "custom-format"}.json`;
				reply.header(
					"Content-Disposition",
					`attachment; filename="${filename}"`,
				);
				reply.header("Content-Type", "application/json");

				return reply.send(exportData);
			} catch (error) {
				app.log.error("Failed to export custom format:", error);
				return reply.code(500).send({
					error: "Failed to export custom format",
					details:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	);

	// ========================================================================
	// Import Custom Format from JSON
	// ========================================================================

	app.post("/api/custom-formats/import", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = ImportCustomFormatSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { instanceId, customFormat } = validation.data;

		try {
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			if (instance.service !== "SONARR" && instance.service !== "RADARR") {
				return reply.code(400).send({
					error: `Instance service ${instance.service} does not support custom formats`,
				});
			}

			const fetcher = createInstanceFetcher(app, instance);
			const response = await fetcher("/api/v3/customformat", {
				method: "POST",
				body: JSON.stringify(customFormat),
			});
			const created = await response.json();

			return reply.code(201).send({
				message: "Custom format imported successfully",
				customFormat: created,
			});
		} catch (error) {
			app.log.error("Failed to import custom format:", error);
			return reply.code(500).send({
				error: "Failed to import custom format",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
