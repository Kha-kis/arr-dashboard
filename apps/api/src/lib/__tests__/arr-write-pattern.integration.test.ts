/**
 * Live-instance integration test for the *arr tag-write pattern.
 *
 * Validates the fix from issue #384: Radarr/Sonarr's PUT /movie|/series
 * endpoints reject partial bodies with `'Quality Profile Id' must be
 * greater than '0'`. The fix is to fetch the full resource via
 * `getById()` and spread it into the update body — same pattern used by
 * `lib/auto-tag/execute-rule.ts`, `lib/label-sync/dest-writers/arr-writer.ts`,
 * and `lib/library-cleanup/cleanup-executor.ts`.
 *
 * --- HOW TO RUN ---
 *
 *   INTEGRATION_TESTS=1 \
 *   RADARR_INTEGRATION_URL=https://radarr.example/ \
 *   RADARR_INTEGRATION_API_KEY=xxxxxxxx \
 *   RADARR_INTEGRATION_MOVIE_ID=42 \
 *   SONARR_INTEGRATION_URL=https://sonarr.example/ \
 *   SONARR_INTEGRATION_API_KEY=yyyyyyyy \
 *   SONARR_INTEGRATION_SERIES_ID=12 \
 *   pnpm --filter @arr/api exec vitest run arr-write-pattern.integration
 *
 * Either service block is independently optional — if the SONARR_* vars
 * aren't set, only the Radarr block runs (and vice versa). If
 * INTEGRATION_TESTS isn't `1`, the entire suite is skipped silently so
 * CI never tries to call out to live infrastructure.
 *
 * --- WHAT IT DOES ---
 *
 * For each configured service:
 *   1. Creates a unique tag named `arr-dashboard-itest-<timestamp>`
 *   2. Fetches the configured movie/series via `getById`
 *   3. Spreads the result into the update body and adds the test tag
 *      (this is the exact pattern from PR #418)
 *   4. Re-fetches the item and asserts the tag is now present
 *   5. Reverts: removes the test tag from the item and deletes the tag
 *
 * --- WHY THIS LIVES IN-TREE ---
 *
 * This is permanent regression coverage, not a one-off script. Every PR
 * that touches `client.movie.update()` / `client.series.update()` should
 * be run against this before tagging a release.
 *
 * --- WHAT IT DOES NOT TEST ---
 *
 * Plex label-sync end-to-end (those use a different writer, no PUT to
 * *arr at all). The Plex path has its own writer in `dest-writers/`.
 */

import { RadarrClient, SonarrClient } from "arr-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Tag isn't exported at the top level of arr-sdk and the per-service
// types differ on optionality of `id` / `label`. Use the only field we
// actually need and assert it's present after creation.
type TestTag = { id: number };

function asTag(t: { id?: number | undefined } | undefined): TestTag {
	if (!t || typeof t.id !== "number" || t.id <= 0) {
		throw new Error("tag.create returned no usable id");
	}
	return { id: t.id };
}

const INTEGRATION_GATE = process.env.INTEGRATION_TESTS === "1";

// vitest's `describe.skipIf(!gate)` pattern is the canonical way to gate
// integration tests — the suite registers but every `it` reports as
// skipped when the gate is closed. CI runs see clean "skipped" markers
// rather than red failures.
const onlyWhenIntegration = describe.skipIf(!INTEGRATION_GATE);

interface ServiceEnv {
	url: string;
	apiKey: string;
	itemId: number;
}

function readEnv(prefix: "RADARR" | "SONARR", itemEnvName: string): ServiceEnv | null {
	const url = process.env[`${prefix}_INTEGRATION_URL`];
	const apiKey = process.env[`${prefix}_INTEGRATION_API_KEY`];
	const itemIdRaw = process.env[`${prefix}_INTEGRATION_${itemEnvName}`];
	if (!url || !apiKey || !itemIdRaw) return null;
	const itemId = Number.parseInt(itemIdRaw, 10);
	if (!Number.isFinite(itemId) || itemId <= 0) return null;
	return { url: url.replace(/\/$/, ""), apiKey, itemId };
}

const TEST_TAG_LABEL = `arr-dashboard-itest-${Date.now()}`;

onlyWhenIntegration("Radarr live tag-write round-trip (issue #384)", () => {
	const env = readEnv("RADARR", "MOVIE_ID");
	const skipReason = env
		? null
		: "RADARR_INTEGRATION_URL / RADARR_INTEGRATION_API_KEY / RADARR_INTEGRATION_MOVIE_ID not set";

	let client: RadarrClient | null = null;
	let createdTag: TestTag | null = null;
	let originalTags: number[] = [];

	beforeAll(() => {
		if (!env) return;
		client = new RadarrClient({ baseUrl: env.url, apiKey: env.apiKey, timeout: 10_000 });
	});

	afterAll(async () => {
		if (!client || !env || !createdTag) return;
		// Revert tag application on the movie + delete the test tag.
		try {
			const movie = await client.movie.getById(env.itemId);
			const remaining = (movie.tags ?? []).filter((t: number) => t !== createdTag?.id);
			await client.movie.update(env.itemId, { ...movie, id: env.itemId, tags: remaining });
		} catch {
			// best effort — if cleanup fails, the orphan tag can be removed manually
		}
		try {
			await client.tag.delete(createdTag.id);
		} catch {
			// best effort
		}
	});

	(env ? it : it.skip)(
		`creates tag, applies to movie ${env?.itemId} via getById+spread+update, verifies, reverts`,
		async () => {
			if (!client || !env) throw new Error(skipReason ?? "env missing");

			// 1. Capture the original tag list so we can spot the mutation.
			const before = await client.movie.getById(env.itemId);
			originalTags = Array.isArray(before.tags) ? [...before.tags] : [];

			// 2. Create a unique tag in this Radarr instance.
			const tag = asTag(await client.tag.create({ label: TEST_TAG_LABEL }));
			createdTag = tag;
			expect(tag.id).toBeGreaterThan(0);

			// 3. The fix from PR #418: spread the full resource, override id+tags.
			const merged = [...originalTags, tag.id];
			await client.movie.update(env.itemId, {
				...before,
				id: env.itemId,
				tags: merged,
			});

			// 4. Re-fetch and assert the tag landed AND the rest of the resource
			//    is intact (qualityProfileId in particular — the field that was
			//    breaking before).
			const after = await client.movie.getById(env.itemId);
			expect(after.tags).toContain(createdTag.id);
			expect(after.qualityProfileId).toBe(before.qualityProfileId);
			expect(after.rootFolderPath).toBe(before.rootFolderPath);
			expect(after.title).toBe(before.title);
		},
		30_000,
	);
});

onlyWhenIntegration("Sonarr live tag-write round-trip (issue #384)", () => {
	const env = readEnv("SONARR", "SERIES_ID");
	const skipReason = env
		? null
		: "SONARR_INTEGRATION_URL / SONARR_INTEGRATION_API_KEY / SONARR_INTEGRATION_SERIES_ID not set";

	let client: SonarrClient | null = null;
	let createdTag: TestTag | null = null;

	beforeAll(() => {
		if (!env) return;
		client = new SonarrClient({ baseUrl: env.url, apiKey: env.apiKey, timeout: 10_000 });
	});

	afterAll(async () => {
		if (!client || !env || !createdTag) return;
		try {
			const series = await client.series.getById(env.itemId);
			const remaining = (series.tags ?? []).filter((t: number) => t !== createdTag?.id);
			await client.series.update(env.itemId, {
				...series,
				id: env.itemId,
				tags: remaining,
			});
		} catch {
			// best effort
		}
		try {
			await client.tag.delete(createdTag.id);
		} catch {
			// best effort
		}
	});

	(env ? it : it.skip)(
		`creates tag, applies to series ${env?.itemId} via getById+spread+update, verifies, reverts`,
		async () => {
			if (!client || !env) throw new Error(skipReason ?? "env missing");

			const before = await client.series.getById(env.itemId);
			const originalTags = Array.isArray(before.tags) ? [...before.tags] : [];

			const tag = asTag(await client.tag.create({ label: TEST_TAG_LABEL }));
			createdTag = tag;
			expect(tag.id).toBeGreaterThan(0);

			await client.series.update(env.itemId, {
				...before,
				id: env.itemId,
				tags: [...originalTags, tag.id],
			});

			const after = await client.series.getById(env.itemId);
			expect(after.tags).toContain(tag.id);
			expect(after.qualityProfileId).toBe(before.qualityProfileId);
			expect(after.rootFolderPath).toBe(before.rootFolderPath);
			expect(after.title).toBe(before.title);
		},
		30_000,
	);
});
