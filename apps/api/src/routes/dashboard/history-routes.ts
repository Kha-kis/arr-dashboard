import { historyResponseV2Schema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { parseHistoryReadQuery } from "../../lib/history/history-read-contract.js";
import { readHistoryRepository } from "../../lib/history/history-read-repository.js";

export const HISTORY_CURSOR_INVALID_MESSAGE = "History pagination cursor is invalid.";
export const HISTORY_CURSOR_STALE_MESSAGE = "History pagination cursor is stale.";
export const HISTORY_QUERY_INVALID_MESSAGE = "History query is invalid.";
export const HISTORY_READ_UNAVAILABLE_MESSAGE = "History is temporarily unavailable.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const mapRepositoryResult = (value: unknown) => {
	if (!isRecord(value) || typeof value.kind !== "string") return null;
	if (value.kind === "ok") {
		if (!hasExactKeys(value, ["kind", "response"])) return null;
		const parsed = historyResponseV2Schema.safeParse(value.response);
		return parsed.success ? { kind: "ok" as const, response: parsed.data } : null;
	}
	if (
		(value.kind === "cursor-invalid" ||
			value.kind === "cursor-stale" ||
			value.kind === "unavailable") &&
		hasExactKeys(value, ["kind"])
	) {
		return { kind: value.kind } as
			| { kind: "cursor-invalid" }
			| { kind: "cursor-stale" }
			| { kind: "unavailable" };
	}
	return null;
};

/**
 * History-related routes for the dashboard. Reads are served exclusively from
 * the local durable observation repository; provider clients are never called.
 */
export const historyRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/dashboard/history", { logLevel: "silent" }, async (request, reply) => {
		try {
			const parsed = parseHistoryReadQuery(request.query);
			if (!parsed.ok) {
				return reply.code(400).send({ error: HISTORY_QUERY_INVALID_MESSAGE });
			}

			const result = mapRepositoryResult(
				await readHistoryRepository({
					prisma: app.prisma,
					encryptor: app.encryptor,
					dialect: app.dbProvider,
					ownerId: request.currentUser!.id,
					query: parsed.query,
				}),
			);
			if (!result) return reply.code(503).send({ error: HISTORY_READ_UNAVAILABLE_MESSAGE });
			if (result.kind === "ok") return reply.code(200).send(result.response);
			if (result.kind === "cursor-invalid") {
				return reply.code(400).send({ error: HISTORY_CURSOR_INVALID_MESSAGE });
			}
			if (result.kind === "cursor-stale") {
				return reply.code(409).send({ error: HISTORY_CURSOR_STALE_MESSAGE });
			}
			return reply.code(503).send({ error: HISTORY_READ_UNAVAILABLE_MESSAGE });
		} catch {
			return reply.code(503).send({ error: HISTORY_READ_UNAVAILABLE_MESSAGE });
		}
	});

	done();
};
