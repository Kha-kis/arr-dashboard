export interface ProfileOverrideReset {
	profileId: number;
	customFormatIds: number[];
}

/** Keep endpoint-scoped reset mutations serialized across quality profiles. */
export async function runProfileOverrideResetsSequentially<T>(
	resets: ProfileOverrideReset[],
	execute: (reset: ProfileOverrideReset) => Promise<T>,
): Promise<T[]> {
	const results: T[] = [];
	for (const reset of resets) {
		results.push(await execute(reset));
	}
	return results;
}
