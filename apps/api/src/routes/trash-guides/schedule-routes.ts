/**
 * TRaSH Sync Schedule Routes
 *
 * CRUD routes for managing scheduled TRaSH template syncs.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const createScheduleSchema = z.object({
	templateId: z.string().min(1),
	instanceId: z.string().min(1),
	frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
	enabled: z.boolean().optional().default(true),
	autoApply: z.boolean().optional().default(false),
	notifyUser: z.boolean().optional().default(true),
});

const updateScheduleSchema = z.object({
	frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).optional(),
	enabled: z.boolean().optional(),
	autoApply: z.boolean().optional(),
	notifyUser: z.boolean().optional(),
});

// ============================================================================
// Helper: Calculate initial nextRunAt
// ============================================================================

function calculateNextRunAt(frequency: string): Date {
	const now = new Date();
	switch (frequency) {
		case "DAILY":
			return new Date(now.getTime() + 24 * 60 * 60 * 1000);
		case "WEEKLY":
			return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
		case "MONTHLY":
			return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
		default:
			return new Date(now.getTime() + 24 * 60 * 60 * 1000);
	}
}

// ============================================================================
// Routes
// ============================================================================

export async function registerScheduleRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/trash-guides/schedules
	 * List all sync schedules for the current user
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const schedules = await app.prisma.trashSyncSchedule.findMany({
			where: { userId },
			include: {
				template: { select: { id: true, name: true, serviceType: true } },
				instance: { select: { id: true, label: true, service: true } },
			},
			orderBy: { createdAt: "desc" },
		});

		return reply.send({ success: true, data: schedules });
	});

	/**
	 * GET /api/trash-guides/schedules/by-link?templateId=&instanceId=
	 * Get schedule for a specific template+instance pair
	 */
	app.get("/by-link", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { templateId, instanceId } = validateRequest(
			z.object({
				templateId: z.string().min(1),
				instanceId: z.string().min(1),
			}),
			request.query,
		);

		const schedule = await app.prisma.trashSyncSchedule.findFirst({
			where: { userId, templateId, instanceId },
		});

		return reply.send({ success: true, data: schedule });
	});

	/**
	 * POST /api/trash-guides/schedules
	 * Create a new sync schedule
	 */
	app.post("/", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(createScheduleSchema, request.body);

		// Verify template and instance exist and belong to user
		const template = await app.prisma.trashTemplate.findFirst({
			where: { id: body.templateId, userId },
		});
		if (!template) {
			return reply.status(404).send({ error: "Template not found" });
		}

		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: body.instanceId, userId },
		});
		if (!instance) {
			return reply.status(404).send({ error: "Instance not found" });
		}

		// Check for existing schedule for this template+instance pair
		const existing = await app.prisma.trashSyncSchedule.findFirst({
			where: { userId, templateId: body.templateId, instanceId: body.instanceId },
		});
		if (existing) {
			return reply.status(409).send({
				error: "A schedule already exists for this template and instance",
				data: existing,
			});
		}

		const schedule = await app.prisma.trashSyncSchedule.create({
			data: {
				userId,
				templateId: body.templateId,
				instanceId: body.instanceId,
				frequency: body.frequency,
				enabled: body.enabled,
				autoApply: body.autoApply,
				notifyUser: body.notifyUser,
				nextRunAt: calculateNextRunAt(body.frequency),
			},
		});

		return reply.status(201).send({ success: true, data: schedule });
	});

	/**
	 * PUT /api/trash-guides/schedules/:id
	 * Update an existing sync schedule
	 */
	app.put("/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = request.params as { id: string };
		const body = validateRequest(updateScheduleSchema, request.body);

		// Verify ownership
		const existing = await app.prisma.trashSyncSchedule.findFirst({
			where: { id, userId },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Schedule not found" });
		}

		// If frequency changed, recalculate nextRunAt
		const data: Record<string, unknown> = { ...body };
		if (body.frequency && body.frequency !== existing.frequency) {
			data.nextRunAt = calculateNextRunAt(body.frequency);
		}

		const schedule = await app.prisma.trashSyncSchedule.update({
			where: { id },
			data,
		});

		return reply.send({ success: true, data: schedule });
	});

	/**
	 * DELETE /api/trash-guides/schedules/:id
	 * Delete a sync schedule
	 */
	app.delete("/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = request.params as { id: string };

		// Verify ownership
		const existing = await app.prisma.trashSyncSchedule.findFirst({
			where: { id, userId },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Schedule not found" });
		}

		await app.prisma.trashSyncSchedule.delete({ where: { id } });

		return reply.send({ success: true, message: "Schedule deleted" });
	});
}
