// Diagnostic storage is independent of runtime authority, proof and admission.
const RETAINED_GAPS = 64;
const HEADER_WORDS = 5;
const WORDS = HEADER_WORDS + RETAINED_GAPS;
const SEQUENCE = 0;
const START = 1;
const LAST_TICK = 2;
const TICK_COUNT = 3;
const STOP = 4;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export type FinalizerLoopObservation =
	| { state: "unavailable" }
	| {
			state: "warming" | "sampled";
			sampleCount: number;
			sampleSpanMs: number;
			maxCompletedGapMs: number;
			currentGapMs: number;
	  };

export type FinalizerLoopDiagnostics = {
	parent: FinalizerLoopObservation;
	worker: FinalizerLoopObservation;
};

function unavailable(): FinalizerLoopObservation {
	return { state: "unavailable" };
}

function monotonicMs(): bigint {
	return process.hrtime.bigint() / 1_000_000n;
}

function words(buffer: unknown): BigInt64Array | undefined {
	if (!(buffer instanceof SharedArrayBuffer)) return;
	const view = new BigInt64Array(buffer);
	return view.length === WORDS ? view : undefined;
}

export function createFinalizerLoopObservationBuffer(): SharedArrayBuffer | undefined {
	try {
		return new SharedArrayBuffer(WORDS * 8);
	} catch {
		return undefined;
	}
}

/** One writer per new buffer. Every operation is best effort and never grants authority. */
export function startFinalizerLoopObservation(buffer: unknown): () => void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let view: BigInt64Array | undefined;
	let stopped = false;
	const invalidate = () => {
		try {
			if (view) Atomics.store(view, SEQUENCE, 1n);
		} catch {
			// Observation failure cannot affect application work or physical close.
		}
	};
	const write = (update: () => void) => {
		if (!view) return;
		const sequence = Atomics.load(view, SEQUENCE);
		if (sequence < 0n || sequence % 2n !== 0n || sequence > MAX_SAFE - 2n) return;
		Atomics.store(view, SEQUENCE, sequence + 1n);
		update();
		Atomics.store(view, SEQUENCE, sequence + 2n);
	};
	try {
		view = words(buffer);
		if (!view || Array.from(view).some((value) => value !== 0n)) return () => {};
		const start = monotonicMs();
		if (start <= 0n || start > MAX_SAFE) return () => {};
		write(() => {
			Atomics.store(view!, START, start);
			Atomics.store(view!, LAST_TICK, start);
		});
		timer = setInterval(() => {
			if (stopped) return;
			try {
				const now = monotonicMs();
				const last = Atomics.load(view!, LAST_TICK);
				const count = Atomics.load(view!, TICK_COUNT);
				if (now < last || now > MAX_SAFE || count < 0n || count >= MAX_SAFE) {
					invalidate();
					return;
				}
				write(() => {
					Atomics.store(view!, HEADER_WORDS + Number(count % BigInt(RETAINED_GAPS)), now - last);
					Atomics.store(view!, LAST_TICK, now);
					Atomics.store(view!, TICK_COUNT, count + 1n);
				});
			} catch {
				invalidate();
			}
		}, 250);
		timer.unref();
	} catch {
		invalidate();
		try {
			if (timer !== undefined) clearInterval(timer);
		} catch {
			// Even timer initialization failure must stay diagnostic-only.
		}
	}
	return () => {
		if (stopped) return;
		stopped = true;
		try {
			if (timer !== undefined) clearInterval(timer);
		} catch {
			// Never skip runtime close because diagnostic timer cleanup failed.
		}
		try {
			const now = monotonicMs();
			if (!view || now < Atomics.load(view, LAST_TICK) || now > MAX_SAFE) {
				invalidate();
				return;
			}
			write(() => Atomics.store(view!, STOP, now));
		} catch {
			invalidate();
		}
	};
}

function read(buffer: unknown, now: bigint): FinalizerLoopObservation {
	try {
		const view = words(buffer);
		if (!view || now < 0n || now > MAX_SAFE) return unavailable();
		for (let attempt = 0; attempt < 3; attempt++) {
			const sequence = Atomics.load(view, SEQUENCE);
			if (sequence < 0n || sequence > MAX_SAFE || sequence % 2n !== 0n) continue;
			const values = Array.from({ length: WORDS - 1 }, (_, index) => Atomics.load(view, index + 1));
			if (sequence !== Atomics.load(view, SEQUENCE)) continue;
			const [start, last, ticks, stop] = values as [bigint, bigint, bigint, bigint];
			if (
				values.some((value) => value < 0n || value > MAX_SAFE) ||
				start === 0n ||
				last < start ||
				(stop !== 0n && stop < last) ||
				now < last ||
				stop > now
			)
				return unavailable();
			const sampleCount = Number(ticks < BigInt(RETAINED_GAPS) ? ticks : BigInt(RETAINED_GAPS));
			const gaps = values.slice(HEADER_WORDS - 1);
			if (ticks < BigInt(RETAINED_GAPS) && gaps.slice(sampleCount).some((gap) => gap !== 0n))
				return unavailable();
			const retained = gaps.slice(0, sampleCount);
			const span = retained.reduce((sum, gap) => sum + gap, 0n);
			if (
				span > MAX_SAFE ||
				span > last - start ||
				(ticks <= BigInt(RETAINED_GAPS) && span !== last - start)
			)
				return unavailable();
			return {
				state: sampleCount === 0 ? "warming" : "sampled",
				sampleCount,
				sampleSpanMs: Number(span),
				maxCompletedGapMs: Number(retained.reduce((max, gap) => (gap > max ? gap : max), 0n)),
				currentGapMs: Number((stop === 0n ? now : stop) - last),
			};
		}
	} catch {
		// Absent, detached, malformed or torn storage is not a healthy measurement.
	}
	return unavailable();
}

export function readFinalizerLoopObservation(buffer: unknown): FinalizerLoopObservation {
	try {
		return read(buffer, monotonicMs());
	} catch {
		return unavailable();
	}
}

export function readFinalizerLoopDiagnostics(
	parentBuffer: unknown,
	workerBuffer: unknown,
): FinalizerLoopDiagnostics {
	try {
		const now = monotonicMs();
		return { parent: read(parentBuffer, now), worker: read(workerBuffer, now) };
	} catch {
		return { parent: unavailable(), worker: unavailable() };
	}
}

/** Read own data only. Unknown fields or accessors are never evaluated or exported. */
function data(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(descriptors).length !== keys.length ||
		keys.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key]!, "value"))
	)
		return;
	return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function sanitizeSnapshot(value: unknown): FinalizerLoopObservation {
	const state = Object.getOwnPropertyDescriptor(value ?? {}, "state")?.value;
	if (state === "unavailable") return unavailable();
	const fields = data(value, [
		"state",
		"sampleCount",
		"sampleSpanMs",
		"maxCompletedGapMs",
		"currentGapMs",
	]);
	if (
		!fields ||
		(fields.state !== "warming" && fields.state !== "sampled") ||
		![fields.sampleCount, fields.sampleSpanMs, fields.maxCompletedGapMs, fields.currentGapMs].every(
			(value) => Number.isSafeInteger(value) && (value as number) >= 0,
		) ||
		(fields.sampleCount as number) > RETAINED_GAPS ||
		(fields.maxCompletedGapMs as number) > (fields.sampleSpanMs as number) ||
		(fields.state === "warming"
			? fields.sampleCount !== 0 || fields.sampleSpanMs !== 0 || fields.maxCompletedGapMs !== 0
			: fields.sampleCount === 0)
	)
		return unavailable();
	return fields as FinalizerLoopObservation;
}

export function sanitizeFinalizerLoopDiagnostics(value: unknown): FinalizerLoopDiagnostics {
	try {
		const fields = data(value, ["parent", "worker"]);
		return fields
			? { parent: sanitizeSnapshot(fields.parent), worker: sanitizeSnapshot(fields.worker) }
			: { parent: unavailable(), worker: unavailable() };
	} catch {
		return { parent: unavailable(), worker: unavailable() };
	}
}

export function finalizerLoopDiagnosticsFrom(value: unknown): FinalizerLoopDiagnostics {
	try {
		if (typeof value !== "object" || value === null) return sanitizeFinalizerLoopDiagnostics(null);
		return sanitizeFinalizerLoopDiagnostics(
			Object.getOwnPropertyDescriptor(value, "loopObservation")?.value,
		);
	} catch {
		return sanitizeFinalizerLoopDiagnostics(null);
	}
}
