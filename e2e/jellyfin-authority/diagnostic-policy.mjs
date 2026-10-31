import { normalizeJellyfinFixtureRoutes } from "./live-matrix-lib.mjs";
export const stages = [
	"phase-start",
	"jellyfin-public-info",
	"jellyfin-startup",
	"jellyfin-auth",
	"jellyfin-library-setup",
	"jellyfin-scan",
	"jellyfin-boxset",
	"dashboard-auth",
	"service-lookup",
	"service-create",
	"service-update",
	"mode-selection",
	"refresh-durable-read",
	"refresh-submit",
	"refresh-health",
	"state-write",
	"phase-complete",
];
export const categories = [
	"refresh-evidence-rejected",
	"assertion",
	"http-status",
	"sqlite",
	"type",
	"syntax",
	"other",
];
const phases = ["bootstrap", "boxset", "pagination", "shapes", "recovery", "rotation"];
const exact = (object, keys) =>
	object !== null &&
	typeof object === "object" &&
	!Array.isArray(object) &&
	JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort());
export function normalizeDiagnostic(value) {
	if (
		!exact(value, [
			"diagnostic",
			"phase",
			"status",
			"stage",
			"category",
			"httpStatus",
			"durable",
			"health",
			"refresh",
			"rejection",
		]) ||
		value.diagnostic !== true ||
		value.status !== "FAIL" ||
		!phases.includes(value.phase) ||
		!stages.includes(value.stage) ||
		!categories.includes(value.category) ||
		!(
			value.httpStatus === null ||
			(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
		)
	)
		return null;
	let durable = null;
	if (value.durable !== null) {
		const counts = ["statusRows", "rows", "itemCount"];
		const booleans = [
			"hasAttemptAt",
			"hasRefreshedAt",
			"hasReceiptStart",
			"hasReceiptObserved",
			"hasGeneration",
		];
		const publicationCheck = value.durable.publicationCheck;
		if (
			!(
				exact(value.durable, [...counts, ...booleans, "attempt"]) ||
				exact(value.durable, [...counts, ...booleans, "attempt", "publicationCheck"])
			) ||
			!["missing", "in-progress", "success", "error", "other"].includes(value.durable.attempt)
		)
			return null;
		durable = {};
		for (const key of counts) {
			const n = value.durable[key];
			if (n !== null && (!Number.isSafeInteger(n) || n < 0 || n > 1000000)) return null;
			durable[key] = n;
		}
		durable.attempt = value.durable.attempt;
		for (const key of booleans) {
			if (typeof value.durable[key] !== "boolean") return null;
			durable[key] = value.durable[key];
		}
		if (Object.hasOwn(value.durable, "publicationCheck")) {
			if (
				![
					"valid",
					"metadata",
					"schema",
					"receipt",
					"domains",
					"units",
					"mapping",
					"watch",
					"other",
				].includes(publicationCheck)
			)
				return null;
			durable.publicationCheck = publicationCheck;
		}
	}
	let health = null;
	if (value.health !== null) {
		const h = value.health;
		if (
			!exact(h, ["lastResult", "itemCount", "isStale"]) ||
			!["success", "partial", "error", "unknown"].includes(h.lastResult) ||
			!(
				h.itemCount === null ||
				(Number.isSafeInteger(h.itemCount) && h.itemCount >= 0 && h.itemCount <= 1000000)
			) ||
			!(h.isStale === null || typeof h.isStale === "boolean")
		)
			return null;
		health = { lastResult: h.lastResult, itemCount: h.itemCount, isStale: h.isStale };
	}
	let refresh = null;
	if (value.refresh !== null) {
		const r = value.refresh;
		if (
			!exact(r, [
				"reads",
				"submitted",
				"accepted",
				"elapsedMs",
				"timestampsSupported",
				"markerValid",
			]) ||
			!["reads", "elapsedMs"].every(
				(key) =>
					r[key] === null || (Number.isSafeInteger(r[key]) && r[key] >= 0 && r[key] <= 1000000),
			) ||
			typeof r.submitted !== "boolean" ||
			typeof r.accepted !== "boolean" ||
			(r.accepted && !r.submitted) ||
			!["timestampsSupported", "markerValid"].every(
				(key) => r[key] === null || typeof r[key] === "boolean",
			)
		)
			return null;
		refresh = {
			reads: r.reads,
			submitted: r.submitted,
			accepted: r.accepted,
			elapsedMs: r.elapsedMs,
			timestampsSupported: r.timestampsSupported,
			markerValid: r.markerValid,
		};
	}
	let rejection = null;
	if (value.rejection !== null) {
		const r = value.rejection;
		if (
			!exact(r, ["kind", "line"]) ||
			!["assertion", "completion", "other"].includes(r.kind) ||
			!(r.line === null || (Number.isSafeInteger(r.line) && r.line > 0 && r.line <= 10000)) ||
			(r.kind === "other" && r.line !== null)
		)
			return null;
		rejection = { kind: r.kind, line: r.line };
	}
	return {
		diagnostic: true,
		phase: value.phase,
		status: "FAIL",
		stage: value.stage,
		category: value.category,
		httpStatus: value.httpStatus,
		durable,
		health,
		refresh,
		rejection,
	};
}

export function normalizeObservation(value) {
	if (
		!exact(value, [
			"observation",
			"phase",
			"status",
			"outcome",
			"elapsedMs",
			"samples",
			"durable",
			"firstRoutes",
			"lastRoutes",
			"errorCategory",
		]) ||
		value.observation !== true ||
		value.phase !== "bootstrap" ||
		value.status !== "FAIL" ||
		!["terminal-success", "terminal-error", "still-running", "superseded", "unavailable"].includes(
			value.outcome,
		) ||
		!(
			value.elapsedMs === null ||
			(Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 1000000)
		) ||
		!Number.isSafeInteger(value.samples) ||
		value.samples < 0 ||
		value.samples > 10000 ||
		![
			null,
			"observer-deadline",
			"durable-evidence-unavailable",
			"proxy-status-unavailable",
			"observer-unavailable",
		].includes(value.errorCategory)
	)
		return null;
	const projected = normalizeDiagnostic({
		diagnostic: true,
		phase: "bootstrap",
		status: "FAIL",
		stage: "refresh-durable-read",
		category: "other",
		httpStatus: null,
		durable: value.durable,
		health: null,
		refresh: null,
		rejection: null,
	});
	if (!projected) return null;
	const firstRoutes =
		value.firstRoutes === null ? null : normalizeJellyfinFixtureRoutes(value.firstRoutes);
	const lastRoutes =
		value.lastRoutes === null ? null : normalizeJellyfinFixtureRoutes(value.lastRoutes);
	if (
		(value.firstRoutes !== null && firstRoutes === null) ||
		(value.lastRoutes !== null && lastRoutes === null)
	)
		return null;
	return {
		observation: true,
		phase: "bootstrap",
		status: "FAIL",
		outcome: value.outcome,
		elapsedMs: value.elapsedMs,
		samples: value.samples,
		durable: projected.durable,
		firstRoutes,
		lastRoutes,
		errorCategory: value.errorCategory,
	};
}
