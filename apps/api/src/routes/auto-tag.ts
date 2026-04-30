/**
 * Auto-Tagger Routes
 *
 * CRUD + on-demand run for `AutoTagRule` — the criteria-based rule
 * system that applies tags to LibraryCache items matching the rule.
 * See `memory/auto-tagger-arc.md`.
 */

import type {
	AutoTagRule as AutoTagRuleDto,
	AutoTagRuleResponse,
	AutoTagRulesResponse,
	AutoTagRunStatus,
	CompositeOperator,
	Condition,
	RuleType,
} from "@arr/shared";
import { createAutoTagRuleSchema, ruleParamSchemaMap, updateAutoTagRuleSchema } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { executeAutoTagRule } from "../lib/auto-tag/execute-rule.js";
import { safeJsonParse } from "../lib/utils/json.js";
import { validateRequest } from "../lib/utils/validate.js";

const ruleParams = z.object({ id: z.string().min(1) });

// ============================================================================
// Wire shape conversion
// ============================================================================

function toDto(row: {
	id: string;
	userId: string;
	name: string;
	enabled: boolean;
	ruleType: string;
	parameters: string;
	operator: string | null;
	conditions: string | null;
	serviceFilter: string | null;
	instanceFilter: string | null;
	excludeTags: string | null;
	excludeTitles: string | null;
	plexLibraryFilter: string | null;
	tagName: string;
	lastRunAt: Date | null;
	lastRunStatus: string | null;
	lastRunMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
}): AutoTagRuleDto {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		enabled: row.enabled,
		ruleType: row.ruleType as RuleType,
		parameters: parseJsonRecord(row.parameters),
		operator: row.operator as CompositeOperator | null,
		conditions: parseJsonArray<Condition>(row.conditions),
		serviceFilter: parseJsonArray<string>(row.serviceFilter),
		instanceFilter: parseJsonArray<string>(row.instanceFilter),
		excludeTags: parseJsonArray<number>(row.excludeTags),
		excludeTitles: parseJsonArray<string>(row.excludeTitles),
		plexLibraryFilter: parseJsonArray<string>(row.plexLibraryFilter),
		tagName: row.tagName,
		lastRunAt: row.lastRunAt?.toISOString() ?? null,
		lastRunStatus: (row.lastRunStatus ?? null) as AutoTagRunStatus | null,
		lastRunMessage: row.lastRunMessage ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
	if (!value) return {};
	const parsed = safeJsonParse(value);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}
	return {};
}

function parseJsonArray<T>(value: string | null): T[] | null {
	if (!value) return null;
	const parsed = safeJsonParse(value);
	if (Array.isArray(parsed)) return parsed as T[];
	return null;
}

// ============================================================================
// Per-rule-type parameter validation (delegates to ruleParamSchemaMap)
// ============================================================================

function validateRuleParameters(
	ruleType: string,
	parameters: Record<string, unknown>,
	conditions: Array<{ ruleType: string; parameters: Record<string, unknown> }> | null,
): string | null {
	if (ruleType === "composite" && conditions) {
		for (let i = 0; i < conditions.length; i++) {
			const cond = conditions[i];
			if (!cond) continue;
			const schema = ruleParamSchemaMap[cond.ruleType];
			if (schema) {
				const result = schema.safeParse(cond.parameters);
				if (!result.success) {
					const flat = result.error.flatten();
					const msgs =
						Object.values(flat.fieldErrors).flat().join(", ") || flat.formErrors.join(", ");
					return `Invalid parameters for condition[${i}] (${cond.ruleType}): ${msgs}`;
				}
			}
		}
		return null;
	}
	const schema = ruleParamSchemaMap[ruleType];
	if (schema) {
		const result = schema.safeParse(parameters);
		if (!result.success) {
			const flat = result.error.flatten();
			const msgs = Object.values(flat.fieldErrors).flat().join(", ") || flat.formErrors.join(", ");
			return `Invalid parameters for rule type "${ruleType}": ${msgs}`;
		}
	}
	return null;
}

// ============================================================================
// Route handlers
// ============================================================================

export async function registerAutoTagRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/rules", async (request, reply) => {
		const userId = request.currentUser!.id;
		const rows = await app.prisma.autoTagRule.findMany({
			where: { userId },
			orderBy: { createdAt: "desc" },
		});
		const response: AutoTagRulesResponse = { rules: rows.map(toDto) };
		return reply.send(response);
	});

	app.post("/rules", async (request, reply) => {
		const body = validateRequest(createAutoTagRuleSchema, request.body);
		const userId = request.currentUser!.id;

		const paramErr = validateRuleParameters(
			body.ruleType,
			body.parameters,
			body.conditions ?? null,
		);
		if (paramErr) {
			return reply.status(400).send({ error: paramErr });
		}

		const created = await app.prisma.autoTagRule.create({
			data: {
				userId,
				name: body.name,
				enabled: body.enabled ?? true,
				ruleType: body.ruleType,
				parameters: JSON.stringify(body.parameters),
				operator: body.operator ?? null,
				conditions: body.conditions ? JSON.stringify(body.conditions) : null,
				serviceFilter: body.serviceFilter ? JSON.stringify(body.serviceFilter) : null,
				instanceFilter: body.instanceFilter ? JSON.stringify(body.instanceFilter) : null,
				excludeTags: body.excludeTags ? JSON.stringify(body.excludeTags) : null,
				excludeTitles: body.excludeTitles ? JSON.stringify(body.excludeTitles) : null,
				plexLibraryFilter: body.plexLibraryFilter ? JSON.stringify(body.plexLibraryFilter) : null,
				tagName: body.tagName,
			},
		});

		const response: AutoTagRuleResponse = { rule: toDto(created) };
		return reply.status(201).send(response);
	});

	app.patch("/rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const body = validateRequest(updateAutoTagRuleSchema, request.body);
		const userId = request.currentUser!.id;

		const existing = await app.prisma.autoTagRule.findFirst({ where: { id, userId } });
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		// If rule type or params changed, re-validate
		const nextRuleType = body.ruleType ?? (existing.ruleType as RuleType);
		const nextParams = body.parameters ?? parseJsonRecord(existing.parameters);
		const nextConditions =
			body.conditions !== undefined
				? body.conditions
				: parseJsonArray<{ ruleType: string; parameters: Record<string, unknown> }>(
						existing.conditions,
					);
		const paramErr = validateRuleParameters(nextRuleType, nextParams, nextConditions ?? null);
		if (paramErr) {
			return reply.status(400).send({ error: paramErr });
		}

		const updated = await app.prisma.autoTagRule.update({
			where: { id },
			data: {
				name: body.name,
				enabled: body.enabled,
				ruleType: body.ruleType,
				parameters: body.parameters !== undefined ? JSON.stringify(body.parameters) : undefined,
				operator: body.operator !== undefined ? body.operator : undefined,
				conditions:
					body.conditions !== undefined
						? body.conditions
							? JSON.stringify(body.conditions)
							: null
						: undefined,
				serviceFilter:
					body.serviceFilter !== undefined
						? body.serviceFilter
							? JSON.stringify(body.serviceFilter)
							: null
						: undefined,
				instanceFilter:
					body.instanceFilter !== undefined
						? body.instanceFilter
							? JSON.stringify(body.instanceFilter)
							: null
						: undefined,
				excludeTags:
					body.excludeTags !== undefined
						? body.excludeTags
							? JSON.stringify(body.excludeTags)
							: null
						: undefined,
				excludeTitles:
					body.excludeTitles !== undefined
						? body.excludeTitles
							? JSON.stringify(body.excludeTitles)
							: null
						: undefined,
				plexLibraryFilter:
					body.plexLibraryFilter !== undefined
						? body.plexLibraryFilter
							? JSON.stringify(body.plexLibraryFilter)
							: null
						: undefined,
				tagName: body.tagName,
			},
		});

		const response: AutoTagRuleResponse = { rule: toDto(updated) };
		return reply.send(response);
	});

	app.delete("/rules/:id", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const userId = request.currentUser!.id;

		const existing = await app.prisma.autoTagRule.findFirst({
			where: { id, userId },
			select: { id: true },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		await app.prisma.autoTagRule.delete({ where: { id } });
		return reply.status(204).send();
	});

	/**
	 * POST /api/auto-tag/rules/:id/run — execute on demand. Walks the rule
	 * end-to-end and persists the result on the rule's lastRunAt/Status/Message.
	 */
	app.post("/rules/:id/run", async (request, reply) => {
		const { id } = validateRequest(ruleParams, request.params);
		const userId = request.currentUser!.id;

		const rule = await app.prisma.autoTagRule.findFirst({ where: { id, userId } });
		if (!rule) {
			return reply.status(404).send({ error: "Rule not found" });
		}
		if (!rule.enabled) {
			return reply.status(400).send({ error: "Rule is disabled. Enable it before running." });
		}

		const result = await executeAutoTagRule({
			rule: {
				id: rule.id,
				userId: rule.userId,
				name: rule.name,
				ruleType: rule.ruleType,
				parameters: parseJsonRecord(rule.parameters),
				operator: rule.operator as "AND" | "OR" | null,
				conditions: parseJsonArray<{
					ruleType: string;
					parameters: Record<string, unknown>;
				}>(rule.conditions),
				serviceFilter: parseJsonArray<string>(rule.serviceFilter),
				instanceFilter: parseJsonArray<string>(rule.instanceFilter),
				excludeTags: parseJsonArray<number>(rule.excludeTags),
				excludeTitles: parseJsonArray<string>(rule.excludeTitles),
				plexLibraryFilter: parseJsonArray<string>(rule.plexLibraryFilter),
				tagName: rule.tagName,
			},
			prisma: app.prisma,
			arrClientFactory: app.arrClientFactory,
			encryptor: app.encryptor,
			log: request.log,
		});

		const updated = await app.prisma.autoTagRule.update({
			where: { id },
			data: {
				lastRunAt: new Date(),
				lastRunStatus: result.status,
				lastRunMessage: result.message,
			},
		});

		const response: AutoTagRuleResponse = { rule: toDto(updated) };
		return reply.send(response);
	});
}
