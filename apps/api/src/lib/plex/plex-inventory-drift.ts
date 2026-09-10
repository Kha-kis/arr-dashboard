export type PlexInventoryDriftDomain =
	| "membership"
	| "display"
	| "watch"
	| "collections"
	| "labels"
	| "unknown";

const DOMAIN_FIELDS = [
	["membership", [0, 1, 2, 3, 10]],
	["display", [4, 6, 9]],
	["watch", [5, 7, 8]],
	["collections", [11]],
	["labels", [12]],
] as const;

function indexSignatures(signatures: readonly string[]): Map<string, unknown[]> | null {
	const indexed = new Map<string, unknown[]>();
	for (const signature of signatures) {
		const fields: unknown = JSON.parse(signature);
		if (
			!Array.isArray(fields) ||
			fields.length !== 13 ||
			![0, 1, 2, 3, 4].every((index) => typeof fields[index] === "string") ||
			fields[0] === "" ||
			fields[2] === "" ||
			![5, 6, 7, 8].every(
				(index) =>
					fields[index] === null ||
					(typeof fields[index] === "number" && Number.isFinite(fields[index])),
			) ||
			(fields[9] !== null && typeof fields[9] !== "string") ||
			![10, 11, 12].every(
				(index) =>
					Array.isArray(fields[index]) &&
					fields[index].every((value: unknown) => typeof value === "string"),
			)
		)
			return null;
		const key = JSON.stringify([fields[0], fields[2]]);
		if (indexed.has(key)) return null;
		indexed.set(key, fields);
	}
	return indexed;
}

/** Diagnostic categories only: never grants publication or mutation authority. */
export function classifyPlexInventoryDrift(
	before: readonly string[],
	after: readonly string[],
): PlexInventoryDriftDomain[] {
	try {
		const initial = indexSignatures(before);
		const final = indexSignatures(after);
		if (!initial || !final) return ["unknown"];
		const changed = new Set<PlexInventoryDriftDomain>();
		for (const key of new Set([...initial.keys(), ...final.keys()])) {
			const left = initial.get(key);
			const right = final.get(key);
			if (!left || !right) {
				changed.add("membership");
				continue;
			}
			for (const [domain, fields] of DOMAIN_FIELDS) {
				if (fields.some((index) => JSON.stringify(left[index]) !== JSON.stringify(right[index]))) {
					changed.add(domain);
				}
			}
		}
		return DOMAIN_FIELDS.map(([domain]) => domain).filter((domain) => changed.has(domain));
	} catch {
		return ["unknown"];
	}
}
