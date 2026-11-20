/**
 * Bound ordinary Jellyfin GET reads even when a transport ignores cancellation.
 * This must not wrap an executing mutation or database publication.
 */
export function awaitJellyfinRead<T>(
	task: Promise<T>,
	signal: AbortSignal,
	discardLateValue?: (value: T) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let aborted = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			aborted = true;
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void task.then(
			(value) => {
				if (settled) {
					if (aborted) {
						try {
							discardLateValue?.(value);
						} catch {
							/* Disposal cannot revive an expired read. */
						}
					}
					return;
				}
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}

export function discardLateJellyfinResponse(response: Response): void {
	try {
		void response.body?.cancel().catch(() => {});
	} catch {
		// A disposal failure cannot turn an expired GET into a successful read.
	}
}

/** Own the body reader so abort can cancel a stream independently of fetch. */
export async function readJellyfinJson(response: Response, signal: AbortSignal): Promise<unknown> {
	// Empty responses still take the same deadline boundary and JSON failure path.
	if (!response.body) return await awaitJellyfinRead(response.json(), signal);
	const reader = response.body.getReader();
	let cancelRequested = false;
	const cancel = () => {
		if (cancelRequested) return;
		cancelRequested = true;
		try {
			void reader.cancel(signal.reason).catch(() => {});
		} catch {
			/* Keep the read outcome. */
		}
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		if (signal.aborted) cancel();
		signal.throwIfAborted();
		const decoder = new TextDecoder();
		const chunks: string[] = [];
		while (true) {
			const chunk = await awaitJellyfinRead(reader.read(), signal);
			if (chunk.done) break;
			chunks.push(decoder.decode(chunk.value, { stream: true }));
		}
		chunks.push(decoder.decode());
		signal.throwIfAborted();
		return JSON.parse(chunks.join(""));
	} finally {
		signal.removeEventListener("abort", cancel);
		if (signal.aborted) cancel();
		reader.releaseLock();
	}
}
