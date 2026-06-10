/**
 * Auto-Tagger Routes
 *
 * CRUD + on-demand run for `AutoTagRule` — the criteria-based rule
 * system that applies tags to LibraryCache items matching the rule.
 * See `memory/auto-tagger-arc.md`.
 */

import { createHash, randomBytes } from "node:crypto";
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
import { runRuleWithLock } from "../lib/auto-tag/run-with-lock.js";
import {
	DEFAULT_EVENTS,
	installOnInstance,
	listEligibleInstances,
	probeInstallStatus,
} from "../lib/auto-tag/webhook-installer.js";
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
	operator: "AND" | "OR" | null | undefined,
): string | null {
	const compositeByShape = operator != null && conditions != null && conditions.length > 0;
	const compositeByRuleType = ruleType === "composite";

	// Reject mode-mismatch: rule says "composite" but no conditions, or vice-versa.
	// This catches a PATCH that adds operator+conditions while leaving the leaf
	// ruleType unchanged (and would otherwise validate against the leaf schema
	// while the executor evaluates as composite).
	if (compositeByShape !== compositeByRuleType) {
		return compositeByShape
			? 'Composite rules must use ruleType="composite" (got rule type plus operator+conditions — pick one mode)'
			: 'Rule type "composite" requires operator + conditions';
	}

	if (compositeByShape && conditions) {
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
			body.operator ?? null,
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

		// If rule type or params changed, re-validate. We must compute the
		// post-PATCH `operator` too so `validateRuleParameters` sees the same
		// composite-vs-leaf shape the executor will eventually evaluate.
		const nextRuleType = body.ruleType ?? (existing.ruleType as RuleType);
		const nextParams = body.parameters ?? parseJsonRecord(existing.parameters);
		const nextConditions =
			body.conditions !== undefined
				? body.conditions
				: parseJsonArray<{ ruleType: string; parameters: Record<string, unknown> }>(
						existing.conditions,
					);
		const nextOperator =
			body.operator !== undefined ? body.operator : (existing.operator as "AND" | "OR" | null);
		const paramErr = validateRuleParameters(
			nextRuleType,
			nextParams,
			nextConditions ?? null,
			nextOperator ?? null,
		);
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

		// Per-rule lock prevents this on-demand run from racing the scheduler
		// tick (or another concurrent on-demand request) for the same rule.
		const lockResult = await runRuleWithLock(rule.id, () =>
			executeAutoTagRule({
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
			}),
		);

		if (lockResult.status === "skipped") {
			return reply.status(409).send({
				error: "Rule is currently running",
				message:
					"Another execution of this rule is in progress (scheduler tick or concurrent run). Try again in a moment.",
			});
		}

		const result = lockResult.result;
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

	// ========================================================================
	// Webhook config (read + rotate)
	//
	// Returns the user's webhook secret (lazy-generated on first read) plus
	// instructions for wiring up Sonarr/Radarr Connect. The secret is shown
	// in plaintext to the authenticated user — they need it to copy into the
	// Connect webhook header. Rotation invalidates any prior Connect config
	// using the old secret.
	// ========================================================================

	// GET returns the existing secret only if we still have it cached (i.e., it
	// was generated/rotated *this session*); otherwise we tell the user to
	// rotate to see a fresh one. We never persist the plaintext, so once it's
	// lost from the response, only rotation can show it again. This is a small
	// UX loss for a meaningful security win — a DB dump no longer yields the
	// auth token.
	app.get("/webhook-config", async (request, reply) => {
		const userId = request.currentUser!.id;
		const user = await app.prisma.user.findUnique({ where: { id: userId } });
		if (!user) return reply.status(404).send({ error: "User not found" });

		if (!user.hashedWebhookSecret) {
			// First-ever access: generate, persist hash, return plaintext once.
			const secret = generateWebhookSecret();
			await app.prisma.user.update({
				where: { id: userId },
				data: { hashedWebhookSecret: hashSecret(secret) },
			});
			return reply.send({ secret, configured: true, freshlyGenerated: true });
		}

		// Secret already configured — we don't store the plaintext, so we can
		// only confirm "you have one; rotate to view".
		return reply.send({ secret: null, configured: true, freshlyGenerated: false });
	});

	app.post("/webhook-config/regenerate", async (request, reply) => {
		const userId = request.currentUser!.id;
		const secret = generateWebhookSecret();
		await app.prisma.user.update({
			where: { id: userId },
			data: { hashedWebhookSecret: hashSecret(secret) },
		});
		return reply.send({ secret, configured: true, freshlyGenerated: true });
	});

	// Note: the inbound Connect webhook (`POST /webhook/:instanceId`) is
	// mounted in `PUBLIC_ROUTE_GROUPS` via `auto-tag-webhook.ts` so
	// Sonarr/Radarr can reach it without a session cookie. It authenticates
	// via Bearer token (the user's hashed webhook secret).

	// ─────────────────────────────────────────────────────────────────────
	// Programmatic Connect webhook auto-install (issue #422).
	//
	// Auto-discovers the user's enabled Sonarr/Radarr instances and
	// installs/updates the arr-dashboard webhook in each via *arr's
	// notification API. The plaintext webhook secret is passed in the
	// install request body (the frontend has it from a recent rotation/
	// generation) — we never persist plaintext.
	// ─────────────────────────────────────────────────────────────────────

	app.get("/webhook/install/status", async (request, reply) => {
		const userId = request.currentUser!.id;
		const instances = await listEligibleInstances(app.prisma, userId);
		const probes = await Promise.all(
			instances.map((instance) =>
				probeInstallStatus(
					{ prisma: app.prisma, arrClientFactory: app.arrClientFactory },
					instance,
				),
			),
		);
		return reply.send({ instances: probes });
	});

	const installBody = z.object({
		// The plaintext webhook secret. We never read this from the DB —
		// frontend gets it via /webhook-config (which only returns it on
		// freshly-generated/rotated requests) and passes it through here.
		secret: z.string().min(16),
		instanceIds: z.array(z.string().min(1)).min(1).max(20),
		events: z
			.object({
				onDownload: z.boolean().optional(),
				onUpgrade: z.boolean().optional(),
				onGrab: z.boolean().optional(),
			})
			.optional(),
	});

	app.post("/webhook/install", async (request, reply) => {
		const userId = request.currentUser!.id;
		const {
			secret,
			instanceIds,
			events: eventsOverride,
		} = validateRequest(installBody, request.body);

		// Verify the supplied secret matches the user's stored hash. This is
		// the same fast-path check the inbound Connect webhook handler uses,
		// just inverted (we have plaintext + hash, want to confirm match).
		const user = await app.prisma.user.findUnique({ where: { id: userId } });
		if (!user?.hashedWebhookSecret) {
			return reply
				.status(412)
				.send({ error: "Webhook secret not configured. Generate one first." });
		}
		const supplied = createHash("sha256").update(secret).digest("hex");
		if (supplied !== user.hashedWebhookSecret) {
			return reply.status(401).send({
				error:
					"Supplied webhook secret does not match the stored value. Rotate via the Webhook Config panel and try again.",
			});
		}

		// Resolve the public-facing URL the *arr will POST to. Precedence:
		//   1. SystemSettings.externalUrl — admin-configured canonical URL
		//   2. Fastify-managed request.protocol/hostname — already respects
		//      the trustProxy flag (set in server.ts), so X-Forwarded-* are
		//      only honoured behind a real reverse proxy
		// Reading X-Forwarded-* directly would bypass that trust gate and
		// let a forged Host header redirect the bearer secret to an attacker.
		const settings = await app.prisma.systemSettings.findUnique({ where: { id: 1 } });
		const externalBase = settings?.externalUrl
			? settings.externalUrl.replace(/\/$/, "")
			: `${request.protocol}://${request.hostname}`;
		const events = { ...DEFAULT_EVENTS, ...(eventsOverride ?? {}) };

		// Resolve instances scoped to this user and the eligible service set.
		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId,
				id: { in: instanceIds },
				service: { in: ["SONARR", "RADARR"] },
				enabled: true,
			},
		});
		if (instances.length === 0) {
			return reply.status(404).send({ error: "No matching enabled Sonarr/Radarr instances" });
		}

		const results = await Promise.all(
			instances.map((instance) =>
				installOnInstance(
					{ prisma: app.prisma, arrClientFactory: app.arrClientFactory },
					instance,
					{
						webhookUrl: `${externalBase}/api/auto-tag/webhook/${instance.id}`,
						bearerSecret: secret,
						events,
					},
				),
			),
		);

		const installed = results.filter(
			(r) => r.status === "installed" || r.status === "updated",
		).length;
		const failed = results.filter((r) => r.status === "failed").length;

		return reply.send({ results, summary: { total: results.length, installed, failed } });
	});
}

function generateWebhookSecret(): string {
	// 32 bytes = 256 bits of entropy, base64url-encoded for URL/header safety.
	return randomBytes(32).toString("base64url");
}

function hashSecret(plaintext: string): string {
	// SHA-256 hex. Constant-time comparison happens at the database lookup
	// (Prisma `findUnique` against an indexed unique column) — there's no
	// userspace string compare on the auth path.
	return createHash("sha256").update(plaintext).digest("hex");
}
