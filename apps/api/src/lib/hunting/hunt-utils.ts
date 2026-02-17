/**
 * Hunt utility functions.
 *
 * Small pure utilities used across the hunt executor:
 * array shuffling and release date checking.
 */

/**
 * Randomizes the order of elements in an array using Fisher-Yates shuffle.
 *
 * @param array - The input array to shuffle
 * @returns A new array containing the elements in randomized order
 */
export function shuffleArray<T>(array: T[]): T[] {
	const shuffled = [...array];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const temp = shuffled[i];
		shuffled[i] = shuffled[j] as T;
		shuffled[j] = temp as T;
	}
	return shuffled;
}

/**
 * Determine whether a release date is in the past or present.
 *
 * @param releaseDate - The release or air date as an ISO date string, or `null`/`undefined` if unknown
 * @returns `true` if `releaseDate` is present and not in the future, `false` otherwise
 */
export function isContentReleased(releaseDate: string | undefined | null): boolean {
	if (!releaseDate) return false; // No release date = treat as unreleased
	const release = new Date(releaseDate);
	const now = new Date();
	return release <= now;
}
