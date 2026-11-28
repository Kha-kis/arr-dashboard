import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export const EXPECTED_JELLYFIN_VERSION = "10.11.11";

function requireRefreshEvidence(condition) {
	if (!condition) throw new Error("Jellyfin refresh completion evidence rejected");
}

function attemptTimestamp(value) {
	if (value === null || value === undefined) return null;
	const timestamp =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
				? Date.parse(value)
				: NaN;
	requireRefreshEvidence(
		Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime()),
	);
	return timestamp;
}

function durableAttempt(db) {
	requireRefreshEvidence(db !== null && typeof db === "object" && [0, 1].includes(db.statusRows));
	const at = attemptTimestamp(db.lastAttemptAt);
	const state = db.lastAttemptResult;
	const active =
		typeof state === "string" &&
		/^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			state,
		);
	requireRefreshEvidence(
		state === null || state === undefined || state === "success" || state === "error" || active,
	);
	requireRefreshEvidence(db.statusRows !== 0 || (at === null && state == null));
	requireRefreshEvidence(!active || at !== null);
	requireRefreshEvidence((state !== "success" && state !== "error") || at !== null);
	return {
		at,
		state,
		active,
		refreshed: attemptTimestamp(db.lastRefreshedAt),
		start: attemptTimestamp(db.publicationAttemptStartedAt),
		observed: attemptTimestamp(db.publicationObservedAt),
	};
}

/** Controlled single-owner fixture completion; acceptance alone never proves publication. */
export async function waitForFreshJellyfinCache({
	submit,
	readDurable,
	readHealth,
	expected,
	timeoutMs = 20_000,
	pollMs = 100,
	now = () => performance.now(),
	pause = (ms, { signal }) => delay(ms, undefined, { signal }),
	onRejected,
}) {
	let timer;
	const controller = new AbortController();
	try {
		requireRefreshEvidence(
			Number.isFinite(timeoutMs) &&
				timeoutMs > 0 &&
				timeoutMs <= 120_000 &&
				Number.isFinite(pollMs) &&
				pollMs > 0,
		);
		const beginning = now();
		requireRefreshEvidence(Number.isFinite(beginning));
		const deadline = beginning + timeoutMs;
		const remaining = () => {
			const current = now();
			requireRefreshEvidence(
				Number.isFinite(current) &&
					current >= beginning &&
					current < deadline &&
					!controller.signal.aborted,
			);
			return deadline - current;
		};
		timer = setTimeout(() => controller.abort(), timeoutMs);
		const bounded = async (operation) => {
			remaining();
			let onAbort;
			try {
				const aborted = new Promise((_, reject) => {
					onAbort = () => reject(new Error("Jellyfin refresh completion evidence rejected"));
					controller.signal.addEventListener("abort", onAbort, { once: true });
				});
				const value = await Promise.race([Promise.resolve().then(operation), aborted]);
				remaining();
				return value;
			} finally {
				controller.signal.removeEventListener("abort", onAbort);
			}
		};
		const baselineDb = await bounded(readDurable);
		const baseline = durableAttempt(baselineDb);
		requireRefreshEvidence(!baseline.active);
		const after = baseline.at ?? -Infinity;
		const accepted = await bounded(() => submit({ signal: controller.signal }));
		requireRefreshEvidence(
			accepted?.status === 202 &&
				accepted.body?.status === "accepted" &&
				accepted.body?.cacheType === "jellyfin",
		);
		let pinned;
		const terminalEvidence = (db, attempt) => {
			requireRefreshEvidence(attempt.at !== null && attempt.at > after);
			if (attempt.state === "success") {
				requireRefreshEvidence(
					attempt.start !== null &&
						attempt.start > after &&
						(!pinned || attempt.start === pinned.at) &&
						attempt.observed !== null &&
						attempt.observed === attempt.at &&
						attempt.refreshed === attempt.at &&
						attempt.at >= attempt.start &&
						typeof db.generationId === "string" &&
						db.generationId.trim().length > 0 &&
						db.generationId !== baselineDb.generationId,
				);
			} else {
				requireRefreshEvidence(
					attempt.state === "error" &&
						(!pinned || attempt.at === pinned.at) &&
						db.generationId === baselineDb.generationId &&
						attempt.start === baseline.start &&
						attempt.observed === baseline.observed &&
						attempt.refreshed === baseline.refreshed,
				);
			}
		};
		while (true) {
			const db = await bounded(readDurable);
			const attempt = durableAttempt(db);
			if (attempt.active) {
				if (pinned)
					requireRefreshEvidence(attempt.at === pinned.at && attempt.state === pinned.state);
				if (attempt.at > after) {
					requireRefreshEvidence(db.generationId === baselineDb.generationId);
					pinned ??= attempt;
				}
			} else if (attempt.state === "success" || attempt.state === "error") {
				if (pinned || (attempt.at !== null && attempt.at > after)) {
					terminalEvidence(db, attempt);
					requireRefreshEvidence(attempt.state === expected.attempt);
					const health = await bounded(() => readHealth({ signal: controller.signal }));
					// Refuse a replacement that appeared while the real health request was in flight.
					const settledDb = await bounded(readDurable);
					const settled = durableAttempt(settledDb);
					terminalEvidence(settledDb, settled);
					requireRefreshEvidence(
						settled.state === attempt.state &&
							settled.at === attempt.at &&
							settled.start === attempt.start &&
							settled.observed === attempt.observed &&
							settledDb.generationId === db.generationId,
					);
					assertCacheEvidence({ db: settledDb, health, expected });
					return;
				}
			}
			await bounded(() => pause(Math.min(pollMs, remaining()), { signal: controller.signal }));
		}
	} catch (error) {
		// Diagnostic-only: preserve the original generic rejection and never emit exception text.
		try {
			const kind =
				error?.code === "ERR_ASSERTION"
					? "assertion"
					: error?.message === "Jellyfin refresh completion evidence rejected"
						? "completion"
						: "other";
			let line = null;
			if (kind !== "other" && typeof error?.stack === "string") {
				for (const frame of error.stack.split("\n")) {
					const suffix = frame.split(`${import.meta.url}:`)[1];
					const match = suffix?.match(/^(\d+):\d+\)?$/);
					if (match) {
						const n = Number(match[1]);
						if (Number.isSafeInteger(n) && n > 0 && n <= 10_000) line = n;
						break;
					}
				}
			}
			if (typeof onRejected === "function") onRejected({ kind, line });
		} catch {
			/* A diagnostic observer must never replace the original rejection. */
		}
		throw new Error("Jellyfin refresh completion evidence rejected");
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

export function validateFixtureIdentity(project, runToken) {
	assert.match(project ?? "", /^jf-authority-[a-z0-9-]+$/);
	assert.match(runToken ?? "", /^[a-f0-9]{64}$/);
}

export function firstCookie(headers) {
	const value = headers.get("set-cookie");
	assert.ok(value, "dashboard authentication did not return a session cookie");
	return value.split(";", 1)[0];
}

export function assertExactJellyfinVersion(info) {
	assert.equal(info?.Version, EXPECTED_JELLYFIN_VERSION);
}

/** Private fixture projection only: never return metadata, scope keys, dates or identifiers. */
export function projectJellyfinLibraryEvidence(
	value,
	schema,
	onRejected,
	profile = "domain-bounded-v2",
) {
	const reject = (category) => {
		try {
			if (typeof onRejected === "function") onRejected(category);
		} catch {}
		return null;
	};
	try {
		let metadata;
		try {
			metadata = typeof value === "string" ? JSON.parse(value) : value;
		} catch {
			return reject("metadata");
		}
		const limited = profile === "unsupported-object-positive-v2";
		if (profile !== "domain-bounded-v2" && !limited) return reject("metadata");
		const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000;
		if (
			metadata?.version !== 1 ||
			metadata.provider !== "jellyfin" ||
			metadata.cacheType !== "jellyfin" ||
			metadata.publicationLevel !== (limited ? "positive-only" : "authoritative") ||
			metadata.completeness !== (limited ? "partial" : "complete") ||
			metadata.canonicalizationVersion !== 1 ||
			!count(metadata.itemCount) ||
			(limited && metadata.itemCount === 0) ||
			!count(metadata.connectionGeneration) ||
			!count(metadata.identityGeneration) ||
			!/^[0-9a-f]{64}$/.test(metadata.contentFingerprint)
		)
			return reject("metadata");
		const parsed = schema.safeParse(metadata.coverageReceipt);
		if (!parsed.success) return reject("schema");
		const receipt = parsed.data;
		if (
			receipt.provider !== "jellyfin" ||
			receipt.evidence !== (limited ? "positive-only" : "complete") ||
			receipt.publishedCanonicalEntities !== metadata.itemCount
		)
			return reject("receipt");
		const expectedDomains = [
			"library-inventory",
			"mapping",
			"watch-count",
			"watch-attribution",
			"on-deck",
		];
		if (
			receipt.domains.length !== expectedDomains.length ||
			expectedDomains.some((name) => !receipt.domains.some((d) => d.domain === name))
		)
			return reject("domains");
		const unsupportedCount = (units) =>
			units.reduce(
				(sum, unit) =>
					sum +
					unit.acceptedSkips.reduce(
						(n, skip) => n + (skip.reason === "unsupported-provider-object" ? skip.count : 0),
						0,
					),
				0,
			);
		const unitsComplete = (units, allowUnsupported = false, inventory = false) =>
			units.length > 0 &&
			units.every(
				(unit) =>
					unit.pagesAttempted > 0 &&
					unit.pagesAttempted === unit.pagesCompleted &&
					unit.fatalCount === (inventory ? unsupportedCount([unit]) : 0) &&
					(unit.expectedRawCount === null || unit.expectedRawCount === unit.rawObserved) &&
					unit.canonicalEntities <= unit.sourceBindings &&
					unit.sourceBindings <= unit.rawObserved &&
					unit.acceptedSkips.every(
						(skip) =>
							skip.reason === "known-container" ||
							(allowUnsupported && skip.reason === "unsupported-provider-object"),
					) &&
					unit.sourceBindings + unit.acceptedSkips.reduce((sum, skip) => sum + skip.count, 0) ===
						unit.rawObserved,
			);
		const publishedCountValid = (group) => {
			const total = group.units.reduce((sum, unit) => sum + unit.canonicalEntities, 0);
			const largest = group.units.reduce((max, unit) => Math.max(max, unit.canonicalEntities), 0);
			return (
				Number.isSafeInteger(total) &&
				(group.publishedCanonicalEntities === undefined ||
					(group.publishedCanonicalEntities >= largest &&
						group.publishedCanonicalEntities <= total))
			);
		};
		if (
			!unitsComplete(receipt.units, limited) ||
			!publishedCountValid(receipt) ||
			receipt.domains.some((group) => !publishedCountValid(group))
		)
			return reject("units");
		const domain = (name) => receipt.domains.find((d) => d.domain === name);
		const exact = (name) => {
			const d = domain(name);
			return d.evidence === "complete" && d.valueSemantics === "exact" && unitsComplete(d.units);
		};
		const inventory = domain("library-inventory"),
			unsupported = unsupportedCount(receipt.units);
		const inventoryValid = limited
			? inventory.evidence === "unknown" &&
				inventory.valueSemantics === "unknown" &&
				unitsComplete(inventory.units, true, true) &&
				Number.isSafeInteger(unsupported) &&
				unsupported > 0 &&
				unsupported === unsupportedCount(inventory.units)
			: exact("library-inventory");
		if (
			!inventoryValid ||
			!exact("mapping") ||
			!exact("on-deck") ||
			domain("mapping").publishedCanonicalEntities !== metadata.itemCount
		)
			return reject("mapping");
		const watch = (name) => {
			const d = domain(name);
			if (!unitsComplete(d.units)) return null;
			const observed = d.units.reduce((sum, unit) => sum + unit.rawObserved, 0);
			return d.evidence === "unknown" && d.valueSemantics === "unknown" && observed === 0
				? "unknown"
				: d.evidence === "positive-only" && d.valueSemantics === "lower-bound" && observed > 0
					? "positive-only"
					: null;
		};
		const watchCount = watch("watch-count"),
			watchAttribution = watch("watch-attribution");
		if (!watchCount || !watchAttribution) return reject("watch");
		return {
			valid: true,
			version: 2,
			itemCount: metadata.itemCount,
			connectionGeneration: metadata.connectionGeneration,
			identityGeneration: metadata.identityGeneration,
			inventoryExact: !limited,
			mappingExact: true,
			onDeckExact: true,
			watchCount,
			watchAttribution,
		};
	} catch {
		return reject("other");
	}
}

export function assertCacheEvidence({ db, health, expected }) {
	assert.equal(db.rows, expected.rows, "unexpected durable Jellyfin cache row count");
	assert.equal(db.statusRows, 1, "expected one durable Jellyfin cache status row");
	assert.equal(db.itemCount, expected.rows, "durable status count diverged from cache rows");
	assert.equal(db.lastResult, "success", "last published generation must remain successful");
	assert.equal(db.lastAttemptResult, expected.attempt, "unexpected durable attempt state");
	assert.equal(health.cacheType, "jellyfin");
	assert.equal(health.lastResult, expected.health);
	const limited = expected.publicationProfile === "unsupported-object-positive-v2";
	if (expected.publicationProfile === "domain-bounded-v2" || limited) {
		if (limited) assert.ok(expected.rows > 0);
		assert.ok(expected.attempt === "success" || expected.attempt === "error");
		assert.equal(expected.health, expected.attempt === "error" ? "error" : "partial");
		const p = db.publicationEvidence;
		assert.ok(p && typeof p === "object");
		assert.deepEqual(
			Object.keys(p).sort(),
			[
				"valid",
				"version",
				"itemCount",
				"connectionGeneration",
				"identityGeneration",
				"inventoryExact",
				"mappingExact",
				"onDeckExact",
				"watchCount",
				"watchAttribution",
			].sort(),
		);
		assert.equal(p.valid, true);
		assert.equal(p.version, 2);
		assert.equal(p.itemCount, expected.rows);
		assert.equal(p.connectionGeneration, db.connectionGeneration);
		assert.equal(p.identityGeneration, db.identityGeneration);
		assert.equal(p.inventoryExact, !limited);
		assert.equal(p.mappingExact, true);
		assert.equal(p.onDeckExact, true);
		assert.ok(["unknown", "positive-only"].includes(p.watchCount));
		assert.ok(["unknown", "positive-only"].includes(p.watchAttribution));
		assert.equal(health.itemCount, null);
		assert.equal(health.observedItemCount, expected.rows);
		const availability = expected.attempt === "error" ? "last-known" : "partial";
		assert.equal(health.providerStatus?.availability, availability);
		assert.equal(health.providerStatus.sources.length, 1);
		const source = health.providerStatus.sources[0];
		assert.ok(typeof health.instanceId === "string" && health.instanceId.length > 0);
		assert.equal(source.instanceId, health.instanceId);
		assert.equal(source.service, "jellyfin");
		assert.equal(source.cacheType, "jellyfin");
		assert.equal(source.status.availability, availability);
		assert.equal(source.status.evidence, limited ? "positive-only" : "partial");
		assert.equal(
			source.status.latestAttempt,
			expected.attempt === "error" ? "failed" : "successful",
		);
		assert.ok(
			Array.isArray(source.status.reasonCodes) &&
				source.status.reasonCodes.includes("coverage-incomplete"),
		);
		const allowed =
			expected.attempt === "error"
				? ["coverage-incomplete", "accepted-skips", "refresh-failed"]
				: ["coverage-incomplete", "accepted-skips"];
		if (limited) {
			allowed.push("positive-only");
			assert.ok(
				source.status.reasonCodes.includes("positive-only") &&
					source.status.reasonCodes.includes("accepted-skips"),
			);
		}
		assert.ok(source.status.reasonCodes.every((reason) => allowed.includes(reason)));
		assert.equal(
			source.status.reasonCodes.includes("refresh-failed"),
			expected.attempt === "error",
		);
	} else {
		assert.equal(expected.publicationProfile, undefined);
		assert.equal(health.itemCount, expected.health === "error" ? null : expected.rows);
	}
	assert.equal(health.isStale, false);
	assert.equal(db.connectionGeneration, db.statusConnectionGeneration);
	assert.equal(db.identityGeneration, db.statusIdentityGeneration);
	if (expected.rows > 0) {
		assert.equal(db.connectionGeneration, db.rowConnectionGeneration);
		assert.equal(db.identityGeneration, db.rowIdentityGeneration);
	}
}

export function assertOwnedResources(resources, project, runToken) {
	validateFixtureIdentity(project, runToken);
	for (const resource of resources) {
		assert.equal(resource.project, project, `refusing unowned ${resource.kind}`);
		assert.equal(resource.runToken, runToken, `refusing mismatched ${resource.kind}`);
	}
}

const routeCategories = [
	"identity",
	"users",
	"libraries",
	"library-items",
	"episode-items",
	"resume",
	"next-up",
	"other",
];
const statusClasses = ["1xx", "2xx", "3xx", "4xx", "5xx", "error", "aborted", "other"];
const exactKeys = (value, keys) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const boundedCount = (value, max = 1_000_000) =>
	Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Fixture-only metadata projection; never return arbitrary proxy payload fields. */
export function normalizeJellyfinFixtureRoutes(value) {
	if (!exactKeys(value, routeCategories)) return null;
	const result = {};
	for (const category of routeCategories) {
		const r = value[category];
		if (
			!exactKeys(r, [
				"started",
				"completed",
				"active",
				"statusClasses",
				"totalMs",
				"maxMs",
				"oldestActiveMs",
			]) ||
			!["started", "completed", "active"].every((key) => boundedCount(r[key])) ||
			!exactKeys(r.statusClasses, statusClasses) ||
			!statusClasses.every((key) => boundedCount(r.statusClasses[key])) ||
			r.started !== r.completed + r.active ||
			statusClasses.reduce((sum, key) => sum + r.statusClasses[key], 0) !== r.completed ||
			!boundedCount(r.totalMs, 1_000_000_000) ||
			!boundedCount(r.maxMs, 1_000_000_000) ||
			r.maxMs > r.totalMs ||
			(r.active === 0 ? r.oldestActiveMs !== null : !boundedCount(r.oldestActiveMs, 1_000_000_000))
		)
			return null;
		result[category] = {
			started: r.started,
			completed: r.completed,
			active: r.active,
			statusClasses: Object.fromEntries(statusClasses.map((key) => [key, r.statusClasses[key]])),
			totalMs: r.totalMs,
			maxMs: r.maxMs,
			oldestActiveMs: r.oldestActiveMs,
		};
	}
	return result;
}

function observedDurable(db) {
	const count = (value) => (boundedCount(value) ? value : null);
	const state = db.lastAttemptResult;
	return {
		statusRows: count(db.statusRows),
		rows: count(db.rows),
		itemCount: count(db.itemCount),
		attempt:
			state === "success" || state === "error"
				? state
				: typeof state === "string" && state.startsWith("in_progress:")
					? "in-progress"
					: "other",
		hasAttemptAt: db.lastAttemptAt != null,
		hasRefreshedAt: db.lastRefreshedAt != null,
		hasReceiptStart: db.publicationAttemptStartedAt != null,
		hasReceiptObserved: db.publicationObservedAt != null,
		hasGeneration: typeof db.generationId === "string" && db.generationId.length > 0,
	};
}

/** Observe only the already failed attempt; this can NEVER turn its test into PASS. */
export async function observeFailedJellyfinRefresh({
	attempt,
	readDurable,
	readProxy,
	timeoutMs = 45_000,
	pollMs = 1_000,
	now = () => performance.now(),
	pause = (ms, { signal }) => delay(ms, undefined, { signal }),
}) {
	const result = {
		observation: true,
		phase: "bootstrap",
		status: "FAIL",
		outcome: "unavailable",
		elapsedMs: null,
		samples: 0,
		durable: null,
		firstRoutes: null,
		lastRoutes: null,
		errorCategory: null,
	};
	const controller = new AbortController();
	let timer,
		beginning,
		stage = "observer-unavailable";
	try {
		requireRefreshEvidence(
			Number.isFinite(timeoutMs) &&
				timeoutMs > 0 &&
				timeoutMs <= 45_000 &&
				Number.isFinite(pollMs) &&
				pollMs > 0 &&
				pollMs <= 5_000,
		);
		beginning = now();
		requireRefreshEvidence(Number.isFinite(beginning));
		const deadline = beginning + timeoutMs;
		const remaining = () => {
			const current = now();
			requireRefreshEvidence(
				Number.isFinite(current) &&
					current >= beginning &&
					current < deadline &&
					!controller.signal.aborted,
			);
			return deadline - current;
		};
		timer = setTimeout(() => controller.abort(), timeoutMs);
		const bounded = async (callback) => {
			remaining();
			let onAbort;
			try {
				const aborted = new Promise((_, reject) => {
					onAbort = () => reject(new Error("Observation unavailable"));
					controller.signal.addEventListener("abort", onAbort, { once: true });
				});
				const value = await Promise.race([Promise.resolve().then(callback), aborted]);
				remaining();
				return value;
			} finally {
				controller.signal.removeEventListener("abort", onAbort);
			}
		};
		const pinned = durableAttempt(attempt);
		requireRefreshEvidence(pinned.active && attempt.statusRows === 1);
		while (true) {
			stage = "durable-evidence-unavailable";
			const db = await bounded(readDurable),
				state = durableAttempt(db);
			requireRefreshEvidence(db.statusRows === 1);
			result.samples++;
			result.durable = observedDurable(db);
			stage = "proxy-status-unavailable";
			const routes = normalizeJellyfinFixtureRoutes(
				(await bounded(() => readProxy({ signal: controller.signal })))?.routes,
			);
			requireRefreshEvidence(routes !== null);
			result.firstRoutes ??= routes;
			result.lastRoutes = routes;
			if (state.active) {
				if (state.at !== pinned.at || state.state !== pinned.state) {
					result.outcome = "superseded";
					break;
				}
			} else if (state.state === "success") {
				result.outcome =
					state.start === pinned.at &&
					state.observed === state.at &&
					state.refreshed === state.at &&
					state.at >= pinned.at &&
					typeof db.generationId === "string" &&
					db.generationId.length > 0 &&
					db.generationId !== attempt.generationId
						? "terminal-success"
						: "superseded";
				break;
			} else if (state.state === "error") {
				result.outcome =
					state.at === pinned.at &&
					db.generationId === attempt.generationId &&
					state.start === pinned.start &&
					state.observed === pinned.observed &&
					state.refreshed === pinned.refreshed
						? "terminal-error"
						: "superseded";
				break;
			} else {
				result.outcome = "unavailable";
				break;
			}
			stage = "observer-deadline";
			await bounded(() => pause(Math.min(pollMs, remaining()), { signal: controller.signal }));
		}
	} catch {
		result.errorCategory = stage;
		result.outcome =
			stage === "observer-deadline" && result.durable?.attempt === "in-progress"
				? "still-running"
				: "unavailable";
	} finally {
		clearTimeout(timer);
		controller.abort();
		try {
			const elapsed = now() - beginning;
			result.elapsedMs =
				Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 1_000_000
					? Math.floor(elapsed)
					: null;
		} catch {
			/* unknown stays null */
		}
	}
	return result;
}
