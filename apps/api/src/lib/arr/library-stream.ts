/**
 * Streaming library fetcher for the ARR services.
 *
 * Background (issue #427):
 * The SDK's `client.series.getAll()` / `movie.getAll()` / `artist.getAll()` /
 * `author.getAll()` calls `response.json()` under the hood, which buffers the
 * ENTIRE response body in memory and then parses it into a JS array in one
 * allocation. For a 1.5M-track Lidarr library (~50k artist objects with
 * embedded statistics) this is a 200-500 MB heap spike before any of the
 * library-sync pop-drain logic (PR #443) can release memory.
 *
 * This helper bypasses the SDK for that one heavy fetch. It streams the
 * response body through @streamparser/json, yielding individual items as
 * they parse. Peak memory is bounded by:
 *   - The streaming parser's internal buffer (~tens of KB)
 *   - One in-flight HTTP chunk (~32 KB from undici)
 *   - The caller's current batch
 *
 * Everything else (cutoff-unmet, tag lookups, individual item operations)
 * keeps using the SDK — those endpoints are paginated or small enough that
 * the buffer-then-parse pattern is fine.
 */

import { JSONParser } from "@streamparser/json";
import type { FastifyBaseLogger } from "fastify";

import type { ServiceInstance } from "../../lib/prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { ArrClientFactory, ClientInstanceData } from "./client-factory.js";

/**
 * The bulk-list endpoint per ARR service. These are the same endpoints the
 * SDK's `getAll()` calls hit — we just consume them via a streaming parser
 * instead of `response.json()`.
 */
const BULK_LIST_PATH: Record<string, string> = {
	SONARR: "/api/v3/series",
	RADARR: "/api/v3/movie",
	LIDARR: "/api/v1/artist",
	READARR: "/api/v1/author",
};

// Allow plenty of headroom for huge libraries — Lidarr with 1.5M tracks can
// take a few minutes end-to-end. The streaming nature means we yield work to
// the caller continuously, so this is just an upper bound on total wall time.
const STREAM_TIMEOUT_MS = 10 * 60_000; // 10 minutes

export interface StreamLibraryOptions {
	/** Override the timeout (mostly for tests). */
	timeoutMs?: number;
}

/**
 * Stream items from the ARR service's bulk-list endpoint.
 *
 * @throws if the response is not OK (HTTP 4xx/5xx) or if the parser hits
 *         malformed JSON. Caller is responsible for transaction handling and
 *         partial-progress semantics.
 */
export async function* streamLibraryItems(
	factory: ArrClientFactory,
	instance: ClientInstanceData & Pick<ServiceInstance, "service" | "label">,
	log: FastifyBaseLogger,
	options?: StreamLibraryOptions,
): AsyncGenerator<Record<string, unknown>, void, undefined> {
	const path = BULK_LIST_PATH[instance.service];
	if (!path) {
		throw new Error(`streamLibraryItems: unsupported service ${instance.service}`);
	}

	const startedAt = Date.now();
	const response = await factory.rawRequest(instance, path, {
		method: "GET",
		timeout: options?.timeoutMs ?? STREAM_TIMEOUT_MS,
	});

	if (!response.ok) {
		// Surface the body for diagnostic logging — bounded to first 512 chars
		// so we never log entire error pages.
		const preview = (await response.text().catch(() => "")).slice(0, 512);
		throw new Error(
			`streamLibraryItems: HTTP ${response.status} ${response.statusText} from ${path} — ${preview}`,
		);
	}

	if (!response.body) {
		throw new Error(`streamLibraryItems: empty response body from ${path}`);
	}

	// `$.*` selects every direct child of the root. For the ARR bulk-list
	// endpoints (top-level JSON arrays), that means each array element.
	// `keepStack: false` lets the parser discard processed elements instead of
	// retaining them for ancestor queries — our memory win.
	const parser = new JSONParser({ paths: ["$.*"], keepStack: false });
	const queue: Array<Record<string, unknown>> = [];
	let parserError: Error | null = null;
	let itemCount = 0;

	parser.onValue = ({ value }) => {
		// Skip primitives. The endpoints return arrays-of-objects; a primitive
		// at the top level would be malformed input.
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			queue.push(value as Record<string, unknown>);
			itemCount++;
		}
	};
	parser.onError = (err) => {
		parserError = err;
	};

	const reader = response.body.getReader();
	try {
		while (true) {
			if (parserError) throw parserError;
			const { done, value } = await reader.read();
			if (done) break;
			parser.write(value);
			while (queue.length > 0) {
				const item = queue.shift();
				if (item) yield item;
			}
		}
		// Flush the parser — but only if it hasn't already auto-ended after a
		// complete top-level value. @streamparser/json with the default
		// `separator: undefined` auto-ends at `]`/`}`. Calling end() again on
		// an already-ended tokenizer throws "ended in the middle of a token".
		// We still call end() when not auto-ended so that a truncated stream
		// (network disconnect mid-JSON) surfaces a clear error.
		if (!parser.isEnded) {
			parser.end();
		}
		if (parserError) throw parserError;
		while (queue.length > 0) {
			const item = queue.shift();
			if (item) yield item;
		}

		log.debug(
			{
				instanceId: instance.id,
				service: instance.service,
				itemCount,
				durationMs: Date.now() - startedAt,
			},
			"Streamed library items from ARR endpoint",
		);
	} catch (err) {
		log.warn(
			{
				err,
				message: getErrorMessage(err),
				instanceId: instance.id,
				service: instance.service,
				itemsBeforeError: itemCount,
			},
			"Stream of ARR library items failed",
		);
		throw err;
	} finally {
		// Cancel reads if the consumer aborted (e.g., transaction failure
		// upstream). releaseLock() alone doesn't cancel the underlying body
		// stream; cancel() does — important so we don't leak an open
		// connection to the *arr instance.
		try {
			reader.releaseLock();
		} catch {
			// ignore — reader may already be released if done was hit
		}
		response.body.cancel().catch(() => {
			// Ignore — body may already be drained/closed.
		});
	}
}
