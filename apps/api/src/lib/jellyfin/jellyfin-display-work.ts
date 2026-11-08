import { setImmediate as turn } from "node:timers/promises";

/** Scheduling only: never grants authority or replaces a runtime guard. */
export function createJellyfinDisplayCheckpoint(): () => Promise<void> | undefined {
	let units = 0;
	let deadline = performance.now() + 4;
	return () => {
		if (++units < 256 && performance.now() < deadline) return;
		units = 0;
		return turn().then(() => {
			deadline = performance.now() + 4;
		});
	};
}

/** Stable merge sort over an owned work array, with bounded comparison/copy work. */
export async function sortJellyfinDisplayRows<T>(
	rows: T[],
	compare: (left: T, right: T) => number,
	checkpoint: () => Promise<void> | undefined,
): Promise<T[]> {
	let source = rows;
	let target = new Array<T>(rows.length);
	for (let width = 1; width < rows.length; width *= 2) {
		for (let start = 0; start < rows.length; start += width * 2) {
			const middle = Math.min(start + width, rows.length);
			const end = Math.min(start + width * 2, rows.length);
			let left = start;
			let right = middle;
			for (let output = start; output < end; output++) {
				target[output] =
					right >= end || (left < middle && !(compare(source[left]!, source[right]!) > 0))
						? source[left++]!
						: source[right++]!;
				const pause = checkpoint();
				if (pause) await pause;
			}
		}
		[source, target] = [target, source];
	}
	return source;
}
