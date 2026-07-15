/**
 * Unified Automation Engine — composer read surface.
 *
 * GET /api/automation/rules returns every domain's stored rules normalized to
 * the v1 grammar (charter §5.1: "the API serves only v1"). This is the read
 * half of the Operator Console rule composer, alongside the cross-domain draft,
 * dry-run, deployment, deactivation, and deletion lifecycle.
 */

import type {
	AutomationRulesResponse,
	CrossDomainDryRunResponse,
	CrossDomainRuleResponse,
	CrossDomainRulesResponse,
} from "@arr/shared";
import { createHash } from "node:crypto";
import { crossDomainRuleDraftSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { collectAutomationRules } from "../lib/automation/collect-rules.js";
import {
	DRY_RUN_MATCH_LIMIT,
	scanCrossDomainRule,
	serializeCrossDomainDraft,
	toCrossDomainRuleDto,
	validateCrossDomainDocument,
} from "../lib/automation/cross-domain-rules.js";
import { validateRequest } from "../lib/utils/validate.js";

const ruleParamsSchema = z.object({ id: z.string().min(1) });
const draftFingerprint = (row: {
	name: string;
	document: string;
	scope: string;
	actions: string;
}) =>
	createHash("sha256")
		.update(row.name)
		.update("\0")
		.update(row.document)
		.update("\0")
		.update(row.scope)
		.update("\0")
		.update(row.actions)
		.digest("hex");

export const registerAutomationRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/automation/rules", async (request) => {
		const userId = request.currentUser!.id;
		const rules = await collectAutomationRules(app.prisma, userId, request.log);
		return { rules } satisfies AutomationRulesResponse;
	});

	app.get("/automation/cross-domain-rules", async (request) => {
		const userId = request.currentUser!.id;
		const rows = await app.prisma.crossDomainRule.findMany({
			where: { userId },
			orderBy: { createdAt: "desc" },
		});
		return { rules: rows.map(toCrossDomainRuleDto) } satisfies CrossDomainRulesResponse;
	});

	app.get("/automation/cross-domain-rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParamsSchema, request.params);
		const userId = request.currentUser!.id;
		const row = await app.prisma.crossDomainRule.findFirst({ where: { id, userId } });
		if (!row) return reply.status(404).send({ error: "Cross-domain rule not found" });
		return { rule: toCrossDomainRuleDto(row) } satisfies CrossDomainRuleResponse;
	});

	app.post("/automation/cross-domain-rules", async (request, reply) => {
		const draft = validateRequest(crossDomainRuleDraftSchema, request.body);
		const documentError = validateCrossDomainDocument(draft.document);
		if (documentError)
			return reply.status(400).send({ error: documentError, message: documentError });
		const userId = request.currentUser!.id;
		const row = await app.prisma.crossDomainRule.create({
			data: { userId, ...serializeCrossDomainDraft(draft) },
		});
		return reply
			.status(201)
			.send({ rule: toCrossDomainRuleDto(row) } satisfies CrossDomainRuleResponse);
	});

	app.patch("/automation/cross-domain-rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParamsSchema, request.params);
		const draft = validateRequest(crossDomainRuleDraftSchema, request.body);
		const documentError = validateCrossDomainDocument(draft.document);
		if (documentError)
			return reply.status(400).send({ error: documentError, message: documentError });
		const userId = request.currentUser!.id;
		const existing = await app.prisma.crossDomainRule.findFirst({ where: { id, userId } });
		if (!existing) return reply.status(404).send({ error: "Cross-domain rule not found" });
		const row = await app.prisma.crossDomainRule.update({
			where: { id },
			data: { ...serializeCrossDomainDraft(draft), dryRunFingerprint: null, lastDryRunAt: null },
		});
		return { rule: toCrossDomainRuleDto(row) } satisfies CrossDomainRuleResponse;
	});

	app.delete("/automation/cross-domain-rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParamsSchema, request.params);
		const userId = request.currentUser!.id;
		const result = await app.prisma.crossDomainRule.deleteMany({ where: { id, userId } });
		if (result.count === 0) return reply.status(404).send({ error: "Cross-domain rule not found" });
		return reply.status(204).send();
	});

	app.post("/automation/cross-domain-rules/:id/dry-run", async (request, reply) => {
		const { id } = validateRequest(ruleParamsSchema, request.params);
		const userId = request.currentUser!.id;
		const row = await app.prisma.crossDomainRule.findFirst({ where: { id, userId } });
		if (!row) return reply.status(404).send({ error: "Cross-domain rule not found" });
		const rule = toCrossDomainRuleDto(row);
		const scan = await scanCrossDomainRule(app, userId, rule.document, rule.scope);
		const processed =
			row.deploymentVersion > 0
				? await app.prisma.crossDomainRuleMatch.findMany({
						where: { ruleId: id, deploymentVersion: row.deploymentVersion },
						select: { instanceId: true, arrItemId: true, itemType: true, completedActions: true },
					})
				: [];
		const processedKeys = new Set(
			processed
				.filter((match) => match.completedActions !== "[]")
				.map((match) => `${match.instanceId}:${match.arrItemId}:${match.itemType}`),
		);
		const response: CrossDomainDryRunResponse = {
			itemsEvaluated: scan.itemsEvaluated,
			itemsMatched: scan.matches.length,
			matches: scan.matches
				.slice(0, DRY_RUN_MATCH_LIMIT)
				.map(({ cacheId: _cacheId, ...match }) => ({
					...match,
					alreadyProcessed: processedKeys.has(
						`${match.instanceId}:${match.arrItemId}:${match.itemType}`,
					),
				})),
			truncated: scan.matches.length > DRY_RUN_MATCH_LIMIT,
			actions: rule.actions,
		};
		await app.prisma.crossDomainRule.update({
			where: { id },
			data: { dryRunFingerprint: draftFingerprint(row), lastDryRunAt: new Date() },
		});
		return response;
	});

	app.post("/automation/cross-domain-rules/:id/deploy", async (request, reply) => {
		const { id } = validateRequest(ruleParamsSchema, request.params);
		const userId = request.currentUser!.id;
		const row = await app.prisma.$transaction(async (tx) => {
			const existing = await tx.crossDomainRule.findFirst({ where: { id, userId } });
			if (!existing) return null;
			if (existing.dryRunFingerprint !== draftFingerprint(existing))
				return "preview_required" as const;
			const deployed = await tx.crossDomainRule.update({
				where: { id },
				data: {
					deployedName: existing.name,
					deployedDocument: existing.document,
					deployedScope: existing.scope,
					deployedActions: existing.actions,
					deploymentVersion: { increment: 1 },
					deployedAt: new Date(),
					dryRunFingerprint: null,
					lastRunAt: null,
					lastRunStatus: null,
					lastRunMessage: null,
				},
			});
			await tx.crossDomainRuleMatch.deleteMany({
				where: { ruleId: id, deploymentVersion: { lt: deployed.deploymentVersion } },
			});
			return deployed;
		});
		if (!row) return reply.status(404).send({ error: "Cross-domain rule not found" });
		if (row === "preview_required") {
			const message = "Dry-run this exact draft before deploying it";
			return reply.status(409).send({ error: message, message });
		}
		return { rule: toCrossDomainRuleDto(row) } satisfies CrossDomainRuleResponse;
	});

	app.post("/automation/cross-domain-rules/:id/deactivate", async (request, reply) => {
		const { id } = validateRequest(ruleParamsSchema, request.params);
		const userId = request.currentUser!.id;
		const row = await app.prisma.$transaction(async (tx) => {
			const existing = await tx.crossDomainRule.findFirst({ where: { id, userId } });
			if (!existing) return null;
			const deactivated = await tx.crossDomainRule.update({
				where: { id },
				data: {
					deployedName: null,
					deployedDocument: null,
					deployedScope: null,
					deployedActions: null,
					deployedAt: null,
					lastRunAt: null,
					lastRunStatus: null,
					lastRunMessage: null,
				},
			});
			await tx.crossDomainRuleMatch.deleteMany({ where: { ruleId: id } });
			return deactivated;
		});
		if (!row) return reply.status(404).send({ error: "Cross-domain rule not found" });
		return { rule: toCrossDomainRuleDto(row) } satisfies CrossDomainRuleResponse;
	});

	done();
};
