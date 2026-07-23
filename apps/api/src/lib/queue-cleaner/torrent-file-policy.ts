import {
	MAX_ALLOWED_FILE_EXTENSION_LENGTH,
	MAX_ALLOWED_FILE_EXTENSIONS,
	MAX_ALLOWED_FILE_EXTENSIONS_JSON_LENGTH,
} from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { createQuiClient, type QuiClient } from "../qui/client-factory.js";
import { listQuiInstances } from "../qui/instance-helpers.js";
import { normalizeDownloadId } from "./qui-gate.js";

const EXTENSION_PATTERN = /^[a-z0-9][a-z0-9_+-]*$/;
const POLICY_CONCURRENCY = 4;
const NO_EXTENSION = "(no extension)";
const INVALID_EXTENSION = "(invalid extension)";
const MAX_REPORTED_OFFENDING_EXTENSIONS = 10;

export type AllowedFileExtensionsParseResult =
	| { ok: true; extensions: string[]; serialized: string | null }
	| { ok: false; error: string };

export type TorrentFilePolicyResult =
	| { status: "not_applicable" }
	| { status: "compliant" }
	| { status: "violation"; offendingExtensions: string[]; reason: string }
	| { status: "deferred"; reason: string };

export interface TorrentFilePolicyInput {
	protocol?: unknown;
	downloadId?: unknown;
}

/**
 * Parse and canonicalize a JSON extension allowlist.
 *
 * Entries are exact, case-insensitive final extensions. A single optional
 * leading dot is accepted for operator convenience, then removed before
 * storage. Regex, glob, and path syntax is deliberately rejected.
 */
export function parseAllowedFileExtensions(
	value: string | null | undefined,
): AllowedFileExtensionsParseResult {
	if (value == null || value.trim() === "") {
		return { ok: true, extensions: [], serialized: null };
	}
	if (value.length > MAX_ALLOWED_FILE_EXTENSIONS_JSON_LENGTH) {
		return {
			ok: false,
			error: `Allowed file extensions exceed ${MAX_ALLOWED_FILE_EXTENSIONS_JSON_LENGTH} characters`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return { ok: false, error: "Allowed file extensions must be a valid JSON array" };
	}

	if (!Array.isArray(parsed)) {
		return { ok: false, error: "Allowed file extensions must be a JSON array" };
	}
	if (parsed.length > MAX_ALLOWED_FILE_EXTENSIONS) {
		return {
			ok: false,
			error: `Too many allowed file extensions (max ${MAX_ALLOWED_FILE_EXTENSIONS})`,
		};
	}

	const normalized = new Set<string>();
	for (const entry of parsed) {
		if (typeof entry !== "string") {
			return { ok: false, error: "Every allowed file extension must be a string" };
		}

		const trimmed = entry.trim().toLowerCase();
		const extension = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
		if (
			extension.length === 0 ||
			extension.length > MAX_ALLOWED_FILE_EXTENSION_LENGTH ||
			!EXTENSION_PATTERN.test(extension)
		) {
			return {
				ok: false,
				error:
					`Invalid file extension. Use 1-${MAX_ALLOWED_FILE_EXTENSION_LENGTH} ` +
					"letters, numbers, underscores, plus signs, or hyphens, with an optional leading dot",
			};
		}
		normalized.add(extension);
	}

	const extensions = [...normalized].sort();
	return {
		ok: true,
		extensions,
		serialized: extensions.length > 0 ? JSON.stringify(extensions) : null,
	};
}

/**
 * Return the final extension used by the policy. Dotfiles, extensionless
 * names, and names ending in a dot are intentionally treated as having no
 * extension and therefore cannot be allowlisted accidentally.
 */
export function getFinalFileExtension(name: string): string {
	const basename = name.replaceAll("\\", "/").split("/").at(-1) ?? "";
	const lastDot = basename.lastIndexOf(".");
	if (lastDot <= 0 || lastDot === basename.length - 1) {
		return NO_EXTENSION;
	}
	const extension = basename.slice(lastDot + 1).toLowerCase();
	if (extension.length > MAX_ALLOWED_FILE_EXTENSION_LENGTH || !EXTENSION_PATTERN.test(extension)) {
		return INVALID_EXTENSION;
	}
	return extension;
}

export function inspectTorrentFileNames(
	names: readonly string[],
	allowedExtensions: ReadonlySet<string>,
): TorrentFilePolicyResult {
	if (names.length === 0) {
		return {
			status: "deferred",
			reason: "File allowlist check deferred because qui returned no torrent file metadata",
		};
	}

	const offending = new Set<string>();
	let hasAdditionalOffendingExtensions = false;
	for (const name of names) {
		const extension = getFinalFileExtension(name);
		if (allowedExtensions.has(extension) || offending.has(extension)) continue;
		if (offending.size < MAX_REPORTED_OFFENDING_EXTENSIONS) {
			offending.add(extension);
		} else {
			hasAdditionalOffendingExtensions = true;
		}
	}
	const offendingExtensions = [...offending].sort();

	if (offendingExtensions.length === 0) {
		return { status: "compliant" };
	}

	const display = offendingExtensions
		.map((extension) =>
			extension === NO_EXTENSION || extension === INVALID_EXTENSION ? extension : `.${extension}`,
		)
		.join(", ");
	const displaySuffix = hasAdditionalOffendingExtensions ? ", and additional types" : "";
	return {
		status: "violation",
		offendingExtensions,
		reason: `Torrent contains file types outside the allowlist: ${display}${displaySuffix}`,
	};
}

export interface TorrentFilePolicyEvaluator {
	evaluateMany(inputs: readonly TorrentFilePolicyInput[]): Promise<TorrentFilePolicyResult[]>;
}

/**
 * Build a run-scoped evaluator. It only uses enabled, user-owned qui
 * instances, caches duplicate hashes, limits upstream concurrency, and fails
 * closed by returning "deferred" whenever a trustworthy manifest is
 * unavailable.
 */
export function createTorrentFilePolicyEvaluator(
	app: FastifyInstance,
	userId: string,
	allowedExtensions: readonly string[],
): TorrentFilePolicyEvaluator {
	const allowed = new Set(allowedExtensions);
	type ClientEntry = {
		instanceId: string;
		client: QuiClient;
		searchUnavailable: boolean;
	};
	let clientsPromise: Promise<ClientEntry[]> | undefined;
	const resultByHash = new Map<string, Promise<TorrentFilePolicyResult>>();
	let manifestErrorLogCount = 0;

	const getClients = async (): Promise<ClientEntry[]> => {
		if (!clientsPromise) {
			clientsPromise = listQuiInstances(app, userId).then((instances) => {
				const clients: ClientEntry[] = [];
				for (const instance of instances) {
					try {
						clients.push({
							instanceId: instance.id,
							client: createQuiClient(app, instance),
							searchUnavailable: false,
						});
					} catch (error) {
						app.log.warn(
							{ err: error, quiInstanceId: instance.id },
							"Queue cleaner could not initialize qui for file policy",
						);
					}
				}
				return clients;
			});
		}
		return clientsPromise;
	};

	const evaluateHash = async (hash: string): Promise<TorrentFilePolicyResult> => {
		let clients: ClientEntry[];
		try {
			clients = await getClients();
		} catch (error) {
			app.log.warn({ err: error }, "Queue cleaner could not list qui instances for file policy");
			return {
				status: "deferred",
				reason: "File allowlist check deferred because configured qui instances are unavailable",
			};
		}

		if (clients.length === 0) {
			return {
				status: "deferred",
				reason: "File allowlist check deferred because no enabled qui instance is configured",
			};
		}

		let foundTorrent = false;
		let attemptedSearch = false;
		for (const entry of clients) {
			if (entry.searchUnavailable) continue;
			attemptedSearch = true;

			let torrent: Awaited<ReturnType<QuiClient["getTorrentByHash"]>>;
			try {
				torrent = await entry.client.getTorrentByHash(hash);
			} catch (error) {
				const shouldLog = !entry.searchUnavailable;
				entry.searchUnavailable = true;
				if (shouldLog) {
					app.log.warn(
						{ err: error, quiInstanceId: entry.instanceId },
						"Queue cleaner disabled an unavailable qui search for the remainder of this run",
					);
				}
				continue;
			}

			if (!torrent) continue;
			foundTorrent = true;
			if (torrent.instanceId == null) {
				app.log.warn(
					{ quiInstanceId: entry.instanceId },
					"Queue cleaner file policy received a torrent without a qBittorrent instance id",
				);
				continue;
			}

			try {
				const files = await entry.client.getTorrentFiles(torrent.instanceId, hash, {
					refresh: true,
				});
				if (files.length === 0) continue;
				return inspectTorrentFileNames(
					files.map((file) => file.name),
					allowed,
				);
			} catch (error) {
				if (manifestErrorLogCount < 10) {
					app.log.warn(
						{ err: error, quiInstanceId: entry.instanceId },
						"Queue cleaner could not inspect a torrent manifest for file policy",
					);
				} else if (manifestErrorLogCount === 10) {
					app.log.warn("Queue cleaner suppressed additional torrent manifest errors for this run");
				}
				manifestErrorLogCount++;
			}
		}

		return {
			status: "deferred",
			reason: foundTorrent
				? "File allowlist check deferred because qui returned no torrent file metadata"
				: attemptedSearch
					? "File allowlist check deferred because the torrent was not found in configured qui instances"
					: "File allowlist check deferred because configured qui instances are unavailable",
		};
	};

	const evaluateOne = (input: TorrentFilePolicyInput): Promise<TorrentFilePolicyResult> => {
		const protocol =
			typeof input.protocol === "string" ? input.protocol.trim().toLowerCase() : undefined;
		if (protocol !== undefined && protocol !== "torrent") {
			return Promise.resolve({ status: "not_applicable" });
		}

		const hash = normalizeDownloadId(input.downloadId);
		if (!hash) {
			if (protocol === undefined) {
				return Promise.resolve({ status: "not_applicable" });
			}
			return Promise.resolve({
				status: "deferred",
				reason: "File allowlist check deferred because the torrent hash is unavailable",
			});
		}

		let result = resultByHash.get(hash);
		if (!result) {
			result = evaluateHash(hash);
			resultByHash.set(hash, result);
		}
		return result;
	};

	return {
		async evaluateMany(inputs) {
			const results = new Array<TorrentFilePolicyResult>(inputs.length);
			let nextIndex = 0;

			const worker = async () => {
				while (nextIndex < inputs.length) {
					const index = nextIndex++;
					results[index] = await evaluateOne(inputs[index]!);
				}
			};

			await Promise.all(
				Array.from({ length: Math.min(POLICY_CONCURRENCY, inputs.length) }, () => worker()),
			);
			return results;
		},
	};
}
