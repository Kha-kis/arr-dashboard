import { createHash } from "node:crypto";

function canonicalizeEvidence(input: unknown): unknown {
	if (input instanceof Date) return input.toISOString();
	if (input instanceof Map) {
		return [...input.entries()]
			.map(([key, entry]) => [String(key), canonicalizeEvidence(entry)])
			.sort(([left], [right]) => String(left).localeCompare(String(right)));
	}
	if (input instanceof Set) {
		return [...input]
			.map(canonicalizeEvidence)
			.sort((left, right) => String(left).localeCompare(String(right)));
	}
	if (Array.isArray(input)) return input.map(canonicalizeEvidence);
	if (typeof input === "object" && input !== null) {
		return Object.fromEntries(
			Object.entries(input as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalizeEvidence(entry)]),
		);
	}
	return input;
}

export function evidenceFingerprint(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalizeEvidence(value)))
		.digest("hex");
}

export type EvidenceFingerprintArrayAccumulator = {
	append(value: unknown): void;
	digest(): string;
};

/**
 * Hashes a canonical JSON array incrementally without retaining its values.
 * Its bytes match `evidenceFingerprint(materializedArray)` exactly.
 * Only supply fixed record keys when every item is a plain record projected
 * with the same own enumerable keys in the same order.
 */
export function createEvidenceFingerprintArrayAccumulator(
	fixedRecordKeys?: readonly string[],
): EvidenceFingerprintArrayAccumulator {
	const orderedKeys =
		fixedRecordKeys && [...fixedRecordKeys].sort((left, right) => left.localeCompare(right));
	const alreadyOrdered = orderedKeys?.every((key, index) => key === fixedRecordKeys![index]);
	const canonicalizeItem = orderedKeys
		? (value: unknown) => {
				const record = value as Record<string, unknown>;
				if (
					alreadyOrdered &&
					orderedKeys.every((key) => {
						const field = record[key];
						return field === null || typeof field !== "object";
					})
				)
					return record;
				const ordered: Record<string, unknown> = Object.create(null);
				for (const key of orderedKeys) ordered[key] = canonicalizeEvidence(record[key]);
				return ordered;
			}
		: canonicalizeEvidence;
	const hash = createHash("sha256");
	hash.update("[");
	let count = 0;
	let result: string | undefined;

	return {
		append(value) {
			if (result !== undefined) throw new Error("Evidence fingerprint is already finalized");
			if (count > 0) hash.update(",");
			// Array stringification turns otherwise omitted values into null.
			const canonicalArrayValue = JSON.stringify([canonicalizeItem(value)]);
			hash.update(canonicalArrayValue.slice(1, -1));
			count += 1;
		},
		digest() {
			if (result === undefined) {
				hash.update("]");
				result = hash.digest("hex");
			}
			return result;
		},
	};
}
