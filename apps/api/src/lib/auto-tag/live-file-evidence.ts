import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { ArrClient } from "../arr/client-factory.js";
import { evaluateSingleConditionState } from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval } from "../library-cleanup/types.js";
import { adaptLiveArrItemForAutoTag, normalizeLiveMovieFile } from "./live-arr-evidence.js";

export interface AutoTagFileRule {
	ruleType: string;
	operator?: string | null;
	conditions?: ReadonlyArray<{ ruleType: string }> | null;
}
const FILE_FIELDS: Readonly<Record<string, string>> = {
	video_codec: "videoCodec",
	audio_codec: "audioCodec",
	resolution: "resolution",
	hdr_type: "videoDynamicRange",
	custom_format_score: "customFormatScore",
	release_group: "releaseGroup",
	audio_channels: "audioCodec",
};
// Unavailable/conflicting evidence belongs to this ephemeral projection, never a PUT.
const uncertainFileFields = new WeakMap<CacheItemForEval, ReadonlySet<string>>();
export function evaluateAutoTagConditionState(
	...args: Parameters<typeof evaluateSingleConditionState>
): ReturnType<typeof evaluateSingleConditionState> {
	const field = FILE_FIELDS[args[1]];
	if (typeof field === "string" && uncertainFileFields.get(args[0])?.has(field))
		return { state: "unknown", reason: null };
	return evaluateSingleConditionState(...args);
}

function fileFields(rules: readonly AutoTagFileRule[]): string[] {
	return [
		...new Set(
			rules.flatMap((rule) =>
				(rule.operator && rule.conditions?.length ? rule.conditions : [rule])
					.map((condition) => FILE_FIELDS[condition.ruleType])
					.filter((field): field is string => field !== undefined),
			),
		),
	];
}
export function autoTagRuleUsesFileEvidence(rule: AutoTagFileRule): boolean {
	return fileFields([rule]).length > 0;
}
function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function normalizeFileEvidence(file: Record<string, unknown>): Record<string, unknown> {
	const normalized = normalizeLiveMovieFile(file);
	// An explicitly observed empty HDR string is known absence, unlike missing/null.
	if (typeof normalized.videoDynamicRange !== "string") {
		const direct = file.videoDynamicRange;
		const nested = record(file.mediaInfo)?.videoDynamicRange;
		if (typeof direct === "string") normalized.videoDynamicRange = direct;
		else if (typeof nested === "string") normalized.videoDynamicRange = nested;
	}
	return normalized;
}
function usableFileField(field: string, value: unknown): boolean {
	return field === "customFormatScore"
		? typeof value === "number" && Number.isFinite(value)
		: typeof value === "string" && (field === "videoDynamicRange" || value.trim().length > 0);
}
function positiveId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function fileId(movie: Record<string, unknown>): number | null {
	if (movie.hasFile === false) return null;
	const embedded = record(movie.movieFile);
	if (embedded?.movieId !== undefined && embedded.movieId !== movie.id) return null;
	const direct = movie.movieFileId;
	const nested = embedded?.id;
	if (direct !== undefined && direct !== null && !positiveId(direct)) return null;
	if (nested !== undefined && nested !== null && !positiveId(nested)) return null;
	if (positiveId(direct) && positiveId(nested) && direct !== nested) return null;
	return positiveId(direct) ? direct : positiveId(nested) ? nested : null;
}
function matchesFile(
	file: Record<string, unknown> | null,
	id: number,
	movieId: number,
	external: boolean,
): file is Record<string, unknown> {
	return (
		file !== null &&
		file.id === id &&
		(external ? file.movieId === movieId : file.movieId === undefined || file.movieId === movieId)
	);
}

/** Missing enrichment must not erase positive fields from the latest matched movie. */
function mergeCurrentFileEvidence(
	embedded: Record<string, unknown> | null,
	observed: Record<string, unknown>,
	fields: readonly string[],
): { file: Record<string, unknown>; unavailable: Set<string> } {
	const unavailable = new Set<string>();
	const current = embedded ? normalizeFileEvidence(embedded) : {};
	const external = normalizeFileEvidence(observed);
	const merged = { ...current, ...external };
	for (const field of new Set(Object.values(FILE_FIELDS))) {
		const a = current[field],
			b = external[field];
		const usable = (value: unknown) => usableFileField(field, value);
		// Contradictory known values, including explicit HDR absence, are uncertain.
		if (
			fields.includes(field) &&
			usable(a) &&
			usable(b) &&
			(typeof a === "string" && typeof b === "string"
				? a.trim().toLowerCase() !== b.trim().toLowerCase()
				: a !== b)
		) {
			unavailable.add(field);
			merged[field] = undefined;
		} else merged[field] = usable(b) ? b : usable(a) ? a : undefined;
	}
	// Prevent a second normalization pass from reintroducing a conflicting nested value.
	return { file: { ...merged, mediaInfo: undefined }, unavailable };
}

/** Read current file evidence using the same bound client, keeping the latest full resource separate. */
export async function loadLiveArrItemForAutoTag(args: {
	client: ArrClient;
	target: { instanceId: string; arrItemId: number; itemType: "movie" | "series" };
	rules: readonly AutoTagFileRule[];
	assertCurrent: () => Promise<void>;
}) {
	const { client, target, rules, assertCurrent } = args;
	const fields = target.itemType === "movie" ? fileFields(rules) : [];
	const resource =
		target.itemType === "movie" ? (client as RadarrClient).movie : (client as SonarrClient).series;
	if (fields.length) await assertCurrent();
	let fullItem = (await resource.getById(target.arrItemId)) as unknown as Record<string, unknown>;
	// Validate the item before using any of its file coordinates.
	adaptLiveArrItemForAutoTag(fullItem, target);
	if (!fields.length) return { fullItem, item: adaptLiveArrItemForAutoTag(fullItem, target) };
	await assertCurrent();
	const id = fileId(fullItem);
	let file = record(fullItem.movieFile);
	let unavailableFields = new Set<string>();
	const normalized = file ? normalizeFileEvidence(file) : null;
	const complete =
		normalized !== null && fields.every((field) => usableFileField(field, normalized[field]));
	if (id === null) file = null;
	else if (!matchesFile(file, id, target.arrItemId, false) || !complete) {
		let observed: Record<string, unknown> | null = null;
		let unavailable = false;
		try {
			observed = record(await (client as RadarrClient).movieFile.getById(id));
		} catch {
			unavailable = true;
			// Missing enrichment never supplies authority; verified current fields may survive.
		}
		await assertCurrent();
		fullItem = (await resource.getById(target.arrItemId)) as unknown as Record<string, unknown>;
		adaptLiveArrItemForAutoTag(fullItem, target);
		await assertCurrent();
		const current = record(fullItem.movieFile);
		const embedded = matchesFile(current, id, target.arrItemId, false) ? current : null;
		if (fileId(fullItem) !== id) file = null;
		else if (unavailable) file = embedded;
		else if (matchesFile(observed, id, target.arrItemId, true)) {
			const merged = mergeCurrentFileEvidence(embedded, observed, fields);
			file = merged.file;
			unavailableFields = merged.unavailable;
		} else file = null;
	}
	if (
		fields.includes("videoDynamicRange") &&
		(!file || !usableFileField("videoDynamicRange", normalizeFileEvidence(file).videoDynamicRange))
	)
		unavailableFields.add("videoDynamicRange");
	const item = adaptLiveArrItemForAutoTag({ ...fullItem, movieFile: file ?? undefined }, target);
	if (unavailableFields.size) uncertainFileFields.set(item, unavailableFields);
	return { fullItem, item };
}
