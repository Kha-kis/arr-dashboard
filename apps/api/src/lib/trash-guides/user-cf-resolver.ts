/**
 * User Custom Format Resolver
 *
 * Batch-resolves user-created custom formats from the database for inclusion
 * in TRaSH Guide template configurations. User CFs use synthetic trash_id
 * "user-{cuid}" where the cuid is the UserCustomFormat primary key.
 */

import type { CustomFormatSpecification, TemplateCustomFormat } from "@arr/shared";
import type { PrismaClientInstance } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";

/** Prefix for user-created custom format synthetic trash_ids */
export const USER_CF_PREFIX = "user-";

/** Type for the CF selection entries from the wizard payload */
export type CFSelection = {
	selected: boolean;
	scoreOverride?: number;
	conditionsEnabled: Record<string, boolean>;
};

/** Type guard for CustomFormatSpecification objects */
const isSpecification = (v: unknown): v is CustomFormatSpecification =>
	typeof v === "object" &&
	v !== null &&
	"name" in v &&
	"implementation" in v &&
	typeof (v as CustomFormatSpecification).name === "string" &&
	typeof (v as CustomFormatSpecification).implementation === "string";

/** Minimal logger interface matching pino's structured logging */
export type StructuredLogger = {
	warn: (obj: Record<string, unknown>, msg: string) => void;
};

/**
 * Batch-resolve user-created custom formats from the database.
 *
 * Filters selections to only those with the "user-" prefix, fetches all
 * matching records in a single query, parses their specifications JSON,
 * and returns TemplateCustomFormat entries ready for the template config.
 *
 * CFs with corrupted or unparseable specifications are skipped entirely
 * (logged as warnings) rather than included with empty specs, to prevent
 * silent no-op formats in deployed templates.
 */
export async function resolveUserCustomFormats(
	prisma: PrismaClientInstance,
	userId: string,
	selections: Record<string, CFSelection>,
	log: StructuredLogger,
): Promise<TemplateCustomFormat[]> {
	const userCFEntries = Object.entries(selections)
		.filter(([trashId, sel]) => sel.selected && trashId.startsWith(USER_CF_PREFIX))
		.map(([trashId, sel]) => ({
			trashId,
			dbId: trashId.slice(USER_CF_PREFIX.length),
			selection: sel,
		}));

	if (userCFEntries.length === 0) return [];

	const dbIds = userCFEntries.map((e) => e.dbId);
	const userCFs = await prisma.userCustomFormat.findMany({
		where: { id: { in: dbIds }, userId },
	});
	const userCFMap = new Map(userCFs.map((cf) => [cf.id, cf]));

	const results: TemplateCustomFormat[] = [];
	for (const entry of userCFEntries) {
		const userCF = userCFMap.get(entry.dbId);
		if (!userCF) {
			log.warn(
				{ cfTrashId: entry.trashId, userCFId: entry.dbId },
				"User-created custom format not found in database, skipping",
			);
			continue;
		}

		const rawParsed = safeJsonParse<unknown[]>(userCF.specifications, null);

		if (rawParsed === null) {
			log.warn(
				{ userCFId: userCF.id, userCFName: userCF.name },
				"Failed to parse specifications JSON for user custom format, skipping",
			);
			continue;
		}

		if (!Array.isArray(rawParsed)) {
			log.warn(
				{ userCFId: userCF.id, userCFName: userCF.name, type: typeof rawParsed },
				"User custom format specifications is not an array, skipping",
			);
			continue;
		}

		// Explicit empty array is valid (placeholder/scoring-only CFs)
		if (rawParsed.length === 0) {
			results.push({
				trashId: entry.trashId,
				name: userCF.name,
				scoreOverride: entry.selection.scoreOverride,
				conditionsEnabled: entry.selection.conditionsEnabled,
				originalConfig: {
					trash_id: entry.trashId,
					name: userCF.name,
					specifications: [],
					includeCustomFormatWhenRenaming: userCF.includeCustomFormatWhenRenaming,
					trash_scores: { default: userCF.defaultScore },
				},
			});
			continue;
		}

		const specs = rawParsed.filter(isSpecification);

		if (specs.length < rawParsed.length) {
			log.warn(
				{
					userCFId: userCF.id,
					userCFName: userCF.name,
					totalSpecs: rawParsed.length,
					validSpecs: specs.length,
				},
				"Some specifications in user custom format failed validation and were dropped",
			);
		}

		if (specs.length === 0) {
			log.warn(
				{ userCFId: userCF.id, userCFName: userCF.name },
				"User custom format has no valid specifications after parsing, skipping",
			);
			continue;
		}

		results.push({
			trashId: entry.trashId,
			name: userCF.name,
			scoreOverride: entry.selection.scoreOverride,
			conditionsEnabled: entry.selection.conditionsEnabled,
			originalConfig: {
				trash_id: entry.trashId,
				name: userCF.name,
				specifications: specs,
				includeCustomFormatWhenRenaming: userCF.includeCustomFormatWhenRenaming,
				trash_scores: { default: userCF.defaultScore },
			},
		});
	}

	return results;
}
