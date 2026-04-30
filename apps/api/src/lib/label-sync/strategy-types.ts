/**
 * Label Sync — strategy interfaces shared by source readers and dest writers.
 *
 * Each side of the rule plugs in via these interfaces:
 *   - `SourceReader` discovers items carrying the source tag/label and yields
 *     `MatchCandidate`s (a tmdbId-keyed shape that survives any source/dest
 *     pairing).
 *   - `DestWriter` consumes the candidates, resolves them to instance-specific
 *     item IDs, and applies the destination tag/label.
 *
 * The executor knows nothing service-specific — it picks reader + writer from
 * the registry and orchestrates the pipeline. New services slot in by adding
 * one reader + one writer and registering them.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient, ServiceInstance, ServiceType } from "../prisma.js";
import type { LabelSyncRuleInput } from "./execute-rule.js";

/**
 * One source item that successfully matched the rule's source tag. Keyed on
 * tmdbId so cross-service joins (arr → plex, plex → jellyfin, etc.) work
 * without translating ID spaces. `mediaType` rides per-candidate because
 * Plex/Jellyfin sources can yield a mix of movies + series in one run.
 */
export interface MatchCandidate {
	tmdbId: number;
	title: string;
	mediaType: "series" | "movie";
}

export interface SourceReadResult {
	matches: MatchCandidate[];
	/**
	 * True when the reader hit a hard failure that prevented it from yielding
	 * candidates from this source instance (e.g., source unreachable, tag list
	 * fetch failed). Counted toward `failures` in the run summary so partial
	 * results across multiple source instances aren't masked.
	 */
	failed: boolean;
}

export interface SourceReaderOpts {
	rule: LabelSyncRuleInput;
	sourceInstance: ServiceInstance;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

export interface SourceReader {
	/** Prisma `ServiceType` enum value used to resolve source instances. */
	prismaService: ServiceType;
	readTaggedItems(opts: SourceReaderOpts): Promise<SourceReadResult>;
}

export interface DestWriteResult {
	matchesFound: number;
	labelsApplied: number;
	failures: number;
}

export interface DestWriterOpts {
	rule: LabelSyncRuleInput;
	destInstance: ServiceInstance;
	candidates: MatchCandidate[];
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

export interface DestWriter {
	/** Prisma `ServiceType` enum value used to resolve the destination instance. */
	prismaService: ServiceType;
	applyLabels(opts: DestWriterOpts): Promise<DestWriteResult>;
}
