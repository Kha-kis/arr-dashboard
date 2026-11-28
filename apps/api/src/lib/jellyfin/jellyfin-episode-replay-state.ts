import { z } from "zod";
import { JELLYFIN_EPISODE_MAX_SCOPE_ROWS } from "./jellyfin-episode-refresh-policy.js";

const base = {
	version: z.literal(1),
	collectUnitId: z.string().min(1).max(128),
};
const clock = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const rowCount = z.number().int().min(0).max(JELLYFIN_EPISODE_MAX_SCOPE_ROWS);
const completedPages = rowCount.positive();
const active = {
	...base,
	deadlineMs: clock,
	rowBudget: z
		.number()
		.int()
		.nonnegative()
		.max(2 * JELLYFIN_EPISODE_MAX_SCOPE_ROWS),
	cursor: rowCount,
	completedPages: rowCount,
	expectedRawCount: rowCount.nullable(),
	lease: z.strictObject({ token: z.string().uuid(), untilMs: clock }).nullable(),
};
const replaySchema = z.discriminatedUnion("state", [
	z.strictObject({ ...active, state: z.literal("collecting"), collectRawCount: z.null() }),
	z.strictObject({
		...active,
		state: z.literal("verifying"),
		collectRawCount: rowCount,
		collectPages: completedPages,
	}),
	z.strictObject({
		...base,
		state: z.literal("original"),
		reason: z.enum(["deadline", "transport", "coverage"]),
	}),
	z.strictObject({
		...base,
		state: z.literal("selected"),
		rawCount: rowCount,
		collectPages: completedPages,
		verifyPages: completedPages,
		completedMs: clock,
	}),
]);

export type JellyfinEpisodeReplayState = z.infer<typeof replaySchema>;

/** Malformed persisted state can neither restart a scope nor authorize a publication. */
export function decodeJellyfinEpisodeReplayState(raw: unknown): JellyfinEpisodeReplayState | null {
	if (typeof raw !== "string" || raw.length > 1024) return null;
	try {
		const result = replaySchema.safeParse(JSON.parse(raw));
		if (!result.success) return null;
		const state = result.data;
		if (
			(state.state === "collecting" || state.state === "verifying") &&
			(state.completedPages > state.cursor ||
				(state.expectedRawCount === null
					? state.cursor !== 0
					: state.cursor > state.expectedRawCount ||
						2 * state.expectedRawCount > state.rowBudget) ||
				(state.state === "verifying" &&
					(2 * state.collectRawCount > state.rowBudget ||
						(state.expectedRawCount !== null &&
							state.expectedRawCount !== state.collectRawCount))) ||
				(state.lease !== null && state.lease.untilMs > state.deadlineMs))
		)
			return null;
		return state;
	} catch {
		return null;
	}
}

export function parseJellyfinEpisodeScope(value: string | null) {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as { userId?: unknown }).userId !== "string" ||
			typeof (parsed as { libraryId?: unknown }).libraryId !== "string"
		)
			return null;
		return parsed as { userId: string; libraryId: string };
	} catch {
		return null;
	}
}
