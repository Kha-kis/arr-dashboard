/**
 * Label Sync Routes
 *
 * CRUD + on-demand run for `LabelSyncRule` — the generic any-to-any
 * tag/label mapping rules. Sub-arc 1 ships the renamed schema and
 * routes; sub-arcs 2-3 expand the source/destination service support.
 * See issue #384 + memory/label-sync-generalization-arc.md.
 */

import type {
	LabelSyncDestService,
	LabelSyncRule as LabelSyncRuleDto,
	LabelSyncRuleResponse,
	LabelSyncRulesResponse,
	LabelSyncRunStatus,
	LabelSyncService,
	LabelSyncSourceService,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { executeLabelSyncRule } from "../lib/label-sync/execute-rule.js";
import { validateRequest } from "../lib/utils/validate.js";

const serviceSchema = z.enum(["sonarr", "radarr", "plex", "jellyfin", "emby"]);

const createRuleBody = z.object({
	name: z.string().trim().min(1).max(120),
	enabled: z.boolean().optional(),
	sourceService: serviceSchema,
	sourceInstanceId: z.string().nullable().optional(),
	sourceTagName: z.string().trim().min(1).max(120),
	destService: serviceSchema,
	destInstanceId: z.string().min(1),
	destTagName: z.string().trim().min(1).max(120),
});

const updateRuleBody = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	enabled: z.boolean().optional(),
	sourceService: serviceSchema.optional(),
	sourceInstanceId: z.string().nullable().optional(),
	sourceTagName: z.string().trim().min(1).max(120).optional(),
	destService: serviceSchema.optional(),
	destInstanceId: z.string().min(1).optional(),
	destTagName: z.string().trim().min(1).max(120).optional(),
});

const ruleParams = z.object({
	id: z.string().min(1),
});

function toDto(row: {
	id: string;
	userId: string;
	name: string;
	enabled: boolean;
	sourceService: string;
	sourceInstanceId: string | null;
	sourceTagName: string;
	destService: string;
	destInstanceId: string;
	destTagName: string;
	lastRunAt: Date | null;
	lastRunStatus: string | null;
	lastRunMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
}): LabelSyncRuleDto {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		enabled: row.enabled,
		sourceService: row.sourceService as LabelSyncSourceService,
		sourceInstanceId: row.sourceInstanceId,
		sourceTagName: row.sourceTagName,
		destService: row.destService as LabelSyncDestService,
		destInstanceId: row.destInstanceId,
		destTagName: row.destTagName,
		lastRunAt: row.lastRunAt?.toISOString() ?? null,
		lastRunStatus: (row.lastRunStatus ?? null) as LabelSyncRunStatus | null,
		lastRunMessage: row.lastRunMessage ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

type LabelSyncPrismaService = "SONARR" | "RADARR" | "PLEX" | "JELLYFIN" | "EMBY";

const SERVICE_TO_PRISMA: Record<LabelSyncService, LabelSyncPrismaService> = {
	sonarr: "SONARR",
	radarr: "RADARR",
	plex: "PLEX",
	jellyfin: "JELLYFIN",
	emby: "EMBY",
};

/**
 * Verify that referenced source and destination instances belong to the
 * requesting user. 404 on mismatch (avoids leaking the existence of other
 * users' instances).
 */
async function assertInstanceOwnership(
	app: FastifyInstance,
	userId: string,
	opts: {
		sourceService: LabelSyncSourceService;
		sourceInstanceId: string | null | undefined;
		destService: LabelSyncDestService;
		destInstanceId: string;
	},
): Promise<void> {
	if (opts.sourceInstanceId) {
		const src = await app.prisma.serviceInstance.findFirst({
			where: {
				id: opts.sourceInstanceId,
				userId,
				service: SERVICE_TO_PRISMA[opts.sourceService],
				enabled: true,
			},
			select: { id: true },
		});
		if (!src) {
			const err: Error & { statusCode?: number } = new Error(
				`${opts.sourceService} instance not found or access denied`,
			);
			err.statusCode = 404;
			throw err;
		}
	}

	const dest = await app.prisma.serviceInstance.findFirst({
		where: {
			id: opts.destInstanceId,
			userId,
			service: SERVICE_TO_PRISMA[opts.destService],
			enabled: true,
		},
		select: { id: true },
	});
	if (!dest) {
		const err: Error & { statusCode?: number } = new Error(
			`${opts.destService} instance not found or access denied`,
		);
		err.statusCode = 404;
		throw err;
	}
}

export async function registerLabelSyncRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/rules", async (request, reply) => {
		const userId = request.currentUser!.id;
		const rows = await app.prisma.labelSyncRule.findMany({
			where: { userId },
			orderBy: { createdAt: "desc" },
		});
		const response: LabelSyncRulesResponse = { rules: rows.map(toDto) };
		return reply.send(response);
	});

	app.post("/rules", async (request, reply) => {
		const body = validateRequest(createRuleBody, request.body);
		const userId = request.currentUser!.id;
		await assertInstanceOwnership(app, userId, {
			sourceService: body.sourceService,
			sourceInstanceId: body.sourceInstanceId ?? null,
			destService: body.destService,
			destInstanceId: body.destInstanceId,
		});

		const created = await app.prisma.labelSyncRule.create({
			data: {
				userId,
				name: body.name,
				enabled: body.enabled ?? true,
				sourceService: body.sourceService,
				sourceInstanceId: body.sourceInstanceId ?? null,
				sourceTagName: body.sourceTagName,
				destService: body.destService,
				destInstanceId: body.destInstanceId,
				destTagName: body.destTagName,
			},
		});

		const response: LabelSyncRuleResponse = { rule: toDto(created) };
		return reply.status(201).send(response);
	});

	app.patch("/rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const body = validateRequest(updateRuleBody, request.body);
		const userId = request.currentUser!.id;

		const existing = await app.prisma.labelSyncRule.findFirst({
			where: { id, userId },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		const nextSourceService =
			(body.sourceService as LabelSyncSourceService | undefined) ??
			(existing.sourceService as LabelSyncSourceService);
		const nextSourceInstanceId =
			body.sourceInstanceId !== undefined ? body.sourceInstanceId : existing.sourceInstanceId;
		const nextDestService =
			(body.destService as LabelSyncDestService | undefined) ??
			(existing.destService as LabelSyncDestService);
		const nextDestInstanceId = body.destInstanceId ?? existing.destInstanceId;

		await assertInstanceOwnership(app, userId, {
			sourceService: nextSourceService,
			sourceInstanceId: nextSourceInstanceId,
			destService: nextDestService,
			destInstanceId: nextDestInstanceId,
		});

		const updated = await app.prisma.labelSyncRule.update({
			where: { id },
			data: {
				name: body.name,
				enabled: body.enabled,
				sourceService: body.sourceService,
				sourceInstanceId: body.sourceInstanceId,
				sourceTagName: body.sourceTagName,
				destService: body.destService,
				destInstanceId: body.destInstanceId,
				destTagName: body.destTagName,
			},
		});

		const response: LabelSyncRuleResponse = { rule: toDto(updated) };
		return reply.send(response);
	});

	app.delete("/rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const userId = request.currentUser!.id;

		const existing = await app.prisma.labelSyncRule.findFirst({
			where: { id, userId },
			select: { id: true },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		await app.prisma.labelSyncRule.delete({ where: { id } });
		return reply.status(204).send();
	});

	/**
	 * POST /api/label-sync/rules/:id/run — execute a rule on demand.
	 * Walks the rule end-to-end and persists the result on the rule's
	 * lastRunAt/Status/Message fields.
	 */
	app.post("/rules/:id/run", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const userId = request.currentUser!.id;

		const rule = await app.prisma.labelSyncRule.findFirst({
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
				sourceService: rule.sourceService,
				sourceInstanceId: rule.sourceInstanceId,
				sourceTagName: rule.sourceTagName,
				destService: rule.destService,
				destInstanceId: rule.destInstanceId,
				destTagName: rule.destTagName,
			},
			prisma: app.prisma,
			arrClientFactory: app.arrClientFactory,
			encryptor: app.encryptor,
			log: request.log,
		});

		const updated = await app.prisma.labelSyncRule.update({
			where: { id },
			data: {
				lastRunAt: new Date(),
				lastRunStatus: result.status,
				lastRunMessage: result.message,
			},
		});

		const response: LabelSyncRuleResponse = { rule: toDto(updated) };
		return reply.send(response);
	});
}
