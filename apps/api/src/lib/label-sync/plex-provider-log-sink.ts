import type { FastifyBaseLogger } from "fastify";

const discard = (): void => {};

const sink = {
	child: () => sink,
	trace: discard,
	debug: discard,
	info: discard,
	warn: discard,
	error: discard,
	fatal: discard,
} as unknown as FastifyBaseLogger;

/**
 * Drops nested Plex provider diagnostics only while a label-sync strategy is
 * running. It keeps no bindings or arguments, and child loggers are the same
 * stateless sink.
 */
export const plexProviderLogSink = Object.freeze(sink);
