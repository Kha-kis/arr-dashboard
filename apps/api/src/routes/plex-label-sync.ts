/**
 * Plex Label Sync Routes
 *
 * CRUD for `PlexLabelSyncRule` — auto-applies a Plex label to items whose
 * matching *arr (Sonarr/Radarr) record carries a configured tag.
 * See issue #384. Execution engine is the next phase; this PR ships
 * the rule shape and management surface.
 */

import type {
	ArrServiceForLabelSync,
	PlexLabelSyncRule as PlexLabelSyncRuleDto,
	PlexLabelSyncRuleResponse,
	PlexLabelSyncRulesResponse,
	PlexLabelSyncRunStatus,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { executeLabelSyncRule } from "../lib/plex-label-sync/execute-rule.js";
import { validateRequest } from "../lib/utils/validate.js";

const arrServiceSchema = z.enum(["sonarr", "radarr"]);

const createRuleBody = z.object({
	name: z.string().trim().min(1).max(120),
	enabled: z.boolean().optional(),
	arrService: arrServiceSchema,
	arrInstanceId: z.string().nullable().optional(),
	arrTagName: z.string().trim().min(1).max(120),
	plexInstanceId: z.string().min(1),
	plexLabel: z.string().trim().min(1).max(120),
});

const updateRuleBody = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	enabled: z.boolean().optional(),
	arrService: arrServiceSchema.optional(),
	arrInstanceId: z.string().nullable().optional(),
	arrTagName: z.string().trim().min(1).max(120).optional(),
	plexInstanceId: z.string().min(1).optional(),
	plexLabel: z.string().trim().min(1).max(120).optional(),
});

const ruleParams = z.object({
	id: z.string().min(1),
});

/** Normalize a Prisma row into the wire DTO. */
function toDto(row: {
	id: string;
	userId: string;
	name: string;
	enabled: boolean;
	arrService: string;
	arrInstanceId: string | null;
	arrTagName: string;
	plexInstanceId: string;
	plexLabel: string;
	lastRunAt: Date | null;
	lastRunStatus: string | null;
	lastRunMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
}): PlexLabelSyncRuleDto {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		enabled: row.enabled,
		arrService: row.arrService as ArrServiceForLabelSync,
		arrInstanceId: row.arrInstanceId,
		arrTagName: row.arrTagName,
		plexInstanceId: row.plexInstanceId,
		plexLabel: row.plexLabel,
		lastRunAt: row.lastRunAt?.toISOString() ?? null,
		lastRunStatus: (row.lastRunStatus ?? null) as PlexLabelSyncRunStatus | null,
		lastRunMessage: row.lastRunMessage ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Verify that the referenced *arr instance (when specified) and Plex
 * instance both belong to the requesting user. Throws 404 on mismatch
 * to avoid leaking the existence of other users' instances.
 */
async function assertInstanceOwnership(
	app: FastifyInstance,
	userId: string,
	opts: {
		arrService: ArrServiceForLabelSync;
		arrInstanceId: string | null | undefined;
		plexInstanceId: string;
	},
): Promise<void> {
	if (opts.arrInstanceId) {
		const arr = await app.prisma.serviceInstance.findFirst({
			where: {
				id: opts.arrInstanceId,
				userId,
				service: opts.arrService.toUpperCase() as "SONARR" | "RADARR",
				enabled: true,
			},
			select: { id: true },
		});
		if (!arr) {
			const err: Error & { statusCode?: number } = new Error(
				`${opts.arrService} instance not found or access denied`,
			);
			err.statusCode = 404;
			throw err;
		}
	}

	const plex = await app.prisma.serviceInstance.findFirst({
		where: { id: opts.plexInstanceId, userId, service: "PLEX", enabled: true },
		select: { id: true },
	});
	if (!plex) {
		const err: Error & { statusCode?: number } = new Error(
			"Plex instance not found or access denied",
		);
		err.statusCode = 404;
		throw err;
	}
}

export async function registerPlexLabelSyncRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/** GET /api/plex/label-sync/rules — list user's rules, newest first */
	app.get("/rules", async (request, reply) => {
		const userId = request.currentUser!.id;
		const rows = await app.prisma.plexLabelSyncRule.findMany({
			where: { userId },
			orderBy: { createdAt: "desc" },
		});
		const response: PlexLabelSyncRulesResponse = { rules: rows.map(toDto) };
		return reply.send(response);
	});

	/** POST /api/plex/label-sync/rules — create a new rule */
	app.post("/rules", async (request, reply) => {
		const body = validateRequest(createRuleBody, request.body);
		const userId = request.currentUser!.id;

		await assertInstanceOwnership(app, userId, {
			arrService: body.arrService,
			arrInstanceId: body.arrInstanceId ?? null,
			plexInstanceId: body.plexInstanceId,
		});

		const created = await app.prisma.plexLabelSyncRule.create({
			data: {
				userId,
				name: body.name,
				enabled: body.enabled ?? true,
				arrService: body.arrService,
				arrInstanceId: body.arrInstanceId ?? null,
				arrTagName: body.arrTagName,
				plexInstanceId: body.plexInstanceId,
				plexLabel: body.plexLabel,
			},
		});

		const response: PlexLabelSyncRuleResponse = { rule: toDto(created) };
		return reply.status(201).send(response);
	});

	/** PATCH /api/plex/label-sync/rules/:id — partial update */
	app.patch("/rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const body = validateRequest(updateRuleBody, request.body);
		const userId = request.currentUser!.id;

		const existing = await app.prisma.plexLabelSyncRule.findFirst({
			where: { id, userId },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		// If any instance reference is being changed, re-validate ownership.
		const nextArrService =
			(body.arrService as ArrServiceForLabelSync | undefined) ??
			(existing.arrService as ArrServiceForLabelSync);
		const nextArrInstanceId =
			body.arrInstanceId !== undefined ? body.arrInstanceId : existing.arrInstanceId;
		const nextPlexInstanceId = body.plexInstanceId ?? existing.plexInstanceId;

		await assertInstanceOwnership(app, userId, {
			arrService: nextArrService,
			arrInstanceId: nextArrInstanceId,
			plexInstanceId: nextPlexInstanceId,
		});

		const updated = await app.prisma.plexLabelSyncRule.update({
			where: { id },
			data: {
				name: body.name,
				enabled: body.enabled,
				arrService: body.arrService,
				arrInstanceId: body.arrInstanceId,
				arrTagName: body.arrTagName,
				plexInstanceId: body.plexInstanceId,
				plexLabel: body.plexLabel,
			},
		});

		const response: PlexLabelSyncRuleResponse = { rule: toDto(updated) };
		return reply.send(response);
	});

	/** DELETE /api/plex/label-sync/rules/:id */
	app.delete("/rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const userId = request.currentUser!.id;

		const existing = await app.prisma.plexLabelSyncRule.findFirst({
			where: { id, userId },
			select: { id: true },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		await app.prisma.plexLabelSyncRule.delete({ where: { id } });
		return reply.status(204).send();
	});

	/**
	 * POST /api/plex/label-sync/rules/:id/run — execute a rule on demand.
	 *
	 * Walks the rule end-to-end (resolve *arr instances → find tagged items
	 * → match against PlexCache → apply label) and persists the result on
	 * the rule's lastRunAt/Status/Message fields.
	 */
	app.post("/rules/:id/run", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const userId = request.currentUser!.id;

		const rule = await app.prisma.plexLabelSyncRule.findFirst({
			where: { id, userId },
		});
		if (!rule) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		if (!rule.enabled) {
			return reply.status(400).send({ error: "Rule is disabled. Enable it before running." });
		}

		const result = await executeLabelSyncRule({
			rule: {
				id: rule.id,
				userId: rule.userId,
				arrService: rule.arrService,
				arrInstanceId: rule.arrInstanceId,
				arrTagName: rule.arrTagName,
				plexInstanceId: rule.plexInstanceId,
				plexLabel: rule.plexLabel,
			},
			prisma: app.prisma,
			arrClientFactory: app.arrClientFactory,
			encryptor: app.encryptor,
			log: request.log,
		});

		const updated = await app.prisma.plexLabelSyncRule.update({
			where: { id },
			data: {
				lastRunAt: new Date(),
				lastRunStatus: result.status,
				lastRunMessage: result.message,
			},
		});

		const response: PlexLabelSyncRuleResponse = { rule: toDto(updated) };
		return reply.send(response);
	});
}
