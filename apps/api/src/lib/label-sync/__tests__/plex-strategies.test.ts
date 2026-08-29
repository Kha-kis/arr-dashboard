import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelSyncRuleInput } from "../execute-rule.js";
import type { DestWriterOpts, SourceReaderOpts } from "../strategy-types.js";

const mocks = vi.hoisted(() => ({
	loadInstanceSelectedEvidence: vi.fn(),
	updateMetadataTags: vi.fn(),
	createPlexClient: vi.fn(),
}));

vi.mock("../../plex/plex-authority-service.js", () => ({
	PlexAuthorityService: class {
		private readonly prisma: {
			serviceInstance?: { findFirst: (input: unknown) => Promise<Record<string, unknown> | null> };
		};
		private lastEvidence?: ReturnType<typeof authoritativeEvidence>;

		constructor(input: { prisma: PlexAuthorityServiceTestPrisma }) {
			this.prisma = input.prisma;
		}

		async readInstanceSelected(input: Record<string, unknown>) {
			const evidence = await mocks.loadInstanceSelectedEvidence(this.prisma, input);
			this.lastEvidence = evidence;
			return evidence;
		}

		async mutateMetadataTag(input: {
			target: { tmdbId: number; mediaType: string };
			expectedRatingKey: string;
			type: string;
			action: string;
			name: string;
		}) {
			const evidence = await mocks.loadInstanceSelectedEvidence(this.prisma, {
				selection: { kind: "targets", targets: [input.target] },
				domains: ["membership"],
			});
			if (
				!evidence.available ||
				evidence.evidence.publicationLevel !== "authoritative" ||
				evidence.evidence.completeness !== "complete" ||
				evidence.evidence.reasonCodes.length > 0
			) {
				return { ok: false, reasonCode: "plex_content_digest_changed" };
			}
			const matching = evidence.rows.filter(
				(row: {
					tmdbId: number;
					mediaType: string;
					ratingKey: string | null;
					thumb: string | null;
				}) =>
					row.tmdbId === input.target.tmdbId &&
					row.mediaType === input.target.mediaType &&
					row.ratingKey === input.expectedRatingKey &&
					row.thumb?.match(/\/library\/metadata\/(\d+)/)?.[1] === input.expectedRatingKey,
			);
			if (new Set(matching.map((row: { ratingKey: string }) => row.ratingKey)).size !== 1) {
				return { ok: false, reasonCode: "plex_content_digest_changed" };
			}
			const current = await this.prisma.serviceInstance?.findFirst({});
			if (
				!current ||
				current.connectionGeneration !== this.lastEvidence?.connectionGeneration ||
				current.identityGeneration !== this.lastEvidence?.identityGeneration
			) {
				return { ok: false, reasonCode: "connection_generation_mismatch" };
			}
			await mocks.updateMetadataTags(input.expectedRatingKey, input.type, input.action, input.name);
			return { ok: true };
		}
	},
}));

type PlexAuthorityServiceTestPrisma = {
	serviceInstance?: { findFirst: (input: unknown) => Promise<Record<string, unknown> | null> };
};

vi.mock("../../plex/plex-client.js", () => ({
	createPlexClient: mocks.createPlexClient,
}));

import { plexDestWriter } from "../dest-writers/plex-writer.js";
import { plexSourceReader } from "../source-readers/plex-reader.js";

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

const rule = {
	id: "rule-1",
	userId: "user-1",
	sourceService: "plex",
	destService: "plex",
	sourceInstanceId: "plex-source",
	destInstanceId: "plex-dest",
	sourceTagName: "Kids",
	destTagName: "Family",
} as LabelSyncRuleInput;

const instance = {
	id: "plex-source",
	userId: "user-1",
	service: "PLEX",
	label: "Plex",
} as SourceReaderOpts["sourceInstance"];

function unavailableEvidence() {
	return {
		available: false,
		evidence: {
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: ["missing_metadata"],
		},
	};
}

function authoritativeEvidence(rows: unknown[]) {
	return {
		available: true,
		connectionGeneration: 4,
		identityGeneration: 9,
		evidence: {
			publicationLevel: "authoritative",
			completeness: "complete",
			reasonCodes: [],
		},
		rows,
	};
}

function failedLatestAttemptEvidence(rows: unknown[]) {
	return {
		...authoritativeEvidence(rows),
		evidence: {
			publicationLevel: "authoritative",
			completeness: "complete",
			reasonCodes: ["latest_attempt_failed"],
		},
	};
}

function inProgressLatestAttemptEvidence(rows: unknown[]) {
	return {
		...authoritativeEvidence(rows),
		evidence: {
			publicationLevel: "authoritative",
			completeness: "complete",
			reasonCodes: ["latest_attempt_in_progress"],
		},
	};
}

function positiveOnlyEvidence(rows: unknown[]) {
	return {
		...authoritativeEvidence(rows),
		evidence: {
			availability: "current",
			authority: "positive-only",
			publicationLevel: "positive-only",
			completeness: "partial",
			reasonCodes: ["latest_attempt_partial"],
		},
	};
}

function destinationPrisma(): DestWriterOpts["prisma"] {
	return {
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue({
				...instance,
				id: "plex-dest",
				connectionGeneration: 4,
				identityGeneration: 9,
			}),
		},
	} as unknown as DestWriterOpts["prisma"];
}

describe("Plex label-sync evidence boundary", () => {
	beforeEach(() => {
		mocks.loadInstanceSelectedEvidence.mockReset();
		mocks.updateMetadataTags.mockReset().mockResolvedValue(undefined);
		mocks.createPlexClient.mockReset().mockReturnValue({
			updateMetadataTags: mocks.updateMetadataTags,
		});
	});

	it("fails the source read instead of treating unavailable evidence as no labels", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(unavailableEvidence());

		const result = await plexSourceReader.readTaggedItems({
			rule,
			sourceInstance: instance,
			prisma: {} as SourceReaderOpts["prisma"],
			arrClientFactory: {} as SourceReaderOpts["arrClientFactory"],
			encryptor: {} as SourceReaderOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matches: [], failed: true });
		expect(mocks.loadInstanceSelectedEvidence).toHaveBeenCalledWith(expect.anything(), {
			userId: "user-1",
			instanceId: "plex-source",
			selection: { kind: "label-membership", label: "Kids" },
			domains: ["membership", "display"],
		});
	});

	it("returns only observed tagged rows from authoritative evidence", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{ tmdbId: 42, mediaType: "movie", title: "Tagged", labels: '["Kids"]' },
				{ tmdbId: 43, mediaType: "movie", title: "Not tagged", labels: '["Other"]' },
			]),
		);

		const result = await plexSourceReader.readTaggedItems({
			rule,
			sourceInstance: instance,
			prisma: {} as SourceReaderOpts["prisma"],
			arrClientFactory: {} as SourceReaderOpts["arrClientFactory"],
			encryptor: {} as SourceReaderOpts["encryptor"],
			log,
		});

		expect(result).toEqual({
			matches: [{ tmdbId: 42, mediaType: "movie", title: "Tagged" }],
			failed: false,
		});
	});

	it("does not treat V4 observed rows as an exact label-sync source", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			positiveOnlyEvidence([
				{ tmdbId: 42, mediaType: "movie", title: "Tagged", labels: '["Kids"]' },
			]),
		);

		const result = await plexSourceReader.readTaggedItems({
			rule,
			sourceInstance: instance,
			prisma: {} as SourceReaderOpts["prisma"],
			arrClientFactory: {} as SourceReaderOpts["arrClientFactory"],
			encryptor: {} as SourceReaderOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matches: [], failed: true });
	});

	it("marks last-known source membership degraded after the latest attempt failed", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			failedLatestAttemptEvidence([
				{ tmdbId: 42, mediaType: "movie", title: "Tagged", labels: '["Kids"]' },
			]),
		);

		const result = await plexSourceReader.readTaggedItems({
			rule,
			sourceInstance: instance,
			prisma: {} as SourceReaderOpts["prisma"],
			arrClientFactory: {} as SourceReaderOpts["arrClientFactory"],
			encryptor: {} as SourceReaderOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matches: [], failed: true });
	});

	it("does not initialize or mutate the destination when evidence is unavailable", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(unavailableEvidence());

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 1 });
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("does not authorize a Plex label write after the latest attempt failed", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			failedLatestAttemptEvidence([
				{ tmdbId: 42, mediaType: "movie", title: "Target", ratingKey: "rating-a" },
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 1 });
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("does not authorize a Plex label write while the latest attempt is in progress", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			inProgressLatestAttemptEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Target",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 1 });
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("does not authorize a Plex label write from V4 positive-only rows", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			positiveOnlyEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Target",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 1 });
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("writes when the legacy thumbnail key and explicit key agree", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Exact target",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 1, failures: 0 });
		expect(mocks.updateMetadataTags).toHaveBeenCalledOnce();
		expect(mocks.updateMetadataTags).toHaveBeenCalledWith("123", "label", "add", "Family");
	});

	it("rejects an explicit key when the legacy thumbnail is null", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Exact target",
					ratingKey: "123",
					thumb: null,
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it.each([
		"/metadata/123",
		"/library/metadata/not-a-number",
		"https://images.invalid/poster.jpg",
		"",
	])("rejects an explicit key when the legacy thumbnail is malformed: %j", async (thumb) => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Exact target",
					ratingKey: "123",
					thumb,
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("rejects a row when the legacy thumbnail key and explicit key disagree", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Exact target",
					ratingKey: "456",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("requires an explicit key and never falls back to a valid legacy thumbnail key", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Exact target",
					ratingKey: null,
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("ignores a non-requested media type that shares the requested TMDB ID", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Movie",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
				{
					tmdbId: 42,
					mediaType: "series",
					title: "Series",
					ratingKey: "456",
					thumb: "/library/metadata/456/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 1, failures: 0 });
		expect(mocks.updateMetadataTags).toHaveBeenCalledOnce();
		expect(mocks.updateMetadataTags).toHaveBeenCalledWith("123", "label", "add", "Family");
	});

	it("fails closed when movie and series candidates share a TMDB ID", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Movie",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
				{
					tmdbId: 42,
					mediaType: "series",
					title: "Series",
					ratingKey: "456",
					thumb: "/library/metadata/456/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [
				{ tmdbId: 42, mediaType: "movie", title: "Movie" },
				{ tmdbId: 42, mediaType: "series", title: "Series" },
			],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 2 });
		expect(mocks.loadInstanceSelectedEvidence).not.toHaveBeenCalled();
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("counts a mixed ambiguous batch once when later destination authority is unavailable", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(unavailableEvidence());

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [
				{ tmdbId: 42, mediaType: "movie", title: "Movie collision" },
				{ tmdbId: 42, mediaType: "series", title: "Series collision" },
				{ tmdbId: 99, mediaType: "movie", title: "Unambiguous movie" },
			],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 3 });
		expect(result.failures).toBeLessThanOrEqual(3);
		expect(mocks.loadInstanceSelectedEvidence).toHaveBeenCalledOnce();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("preserves mixed-batch accounting when one unambiguous target writes", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 99,
					mediaType: "movie",
					title: "Unambiguous movie",
					ratingKey: "999",
					thumb: "/library/metadata/999/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [
				{ tmdbId: 42, mediaType: "movie", title: "Movie collision" },
				{ tmdbId: 42, mediaType: "series", title: "Series collision" },
				{ tmdbId: 99, mediaType: "movie", title: "Unambiguous movie" },
			],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 1, failures: 2 });
		expect(result.failures).toBeLessThanOrEqual(3);
		expect(mocks.updateMetadataTags).toHaveBeenCalledOnce();
		expect(mocks.updateMetadataTags).toHaveBeenCalledWith("999", "label", "add", "Family");
	});

	it("counts every unambiguous candidate once when destination authority is unavailable", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(unavailableEvidence());

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [
				{ tmdbId: 10, mediaType: "movie", title: "Movie ten" },
				{ tmdbId: 11, mediaType: "series", title: "Series eleven" },
			],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 2 });
		expect(mocks.loadInstanceSelectedEvidence).toHaveBeenCalledOnce();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("does not infer a complete duplicate-edition set from one persisted rating key", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Observed copy",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 1, failures: 0 });
		expect(mocks.updateMetadataTags).toHaveBeenCalledOnce();
		expect(mocks.updateMetadataTags).toHaveBeenCalledWith("123", "label", "add", "Family");
	});

	it("deduplicates repeated observations of one parity-safe cached key", async () => {
		const row = {
			tmdbId: 42,
			mediaType: "movie",
			title: "Observed copy",
			ratingKey: "123",
			thumb: "/library/metadata/123/thumb/1",
		};
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(authoritativeEvidence([row, { ...row }]));

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 2, labelsApplied: 1, failures: 0 });
		expect(mocks.updateMetadataTags).toHaveBeenCalledOnce();
	});

	it("does not mutate when exact destination evidence changes before the write", async () => {
		mocks.loadInstanceSelectedEvidence
			.mockResolvedValueOnce(
				authoritativeEvidence([
					{
						tmdbId: 42,
						mediaType: "movie",
						title: "Target",
						ratingKey: "123",
						thumb: "/library/metadata/123/thumb/1",
					},
				]),
			)
			.mockResolvedValueOnce(unavailableEvidence());

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("does not mutate when cached key agreement changes before the write", async () => {
		mocks.loadInstanceSelectedEvidence
			.mockResolvedValueOnce(
				authoritativeEvidence([
					{
						tmdbId: 42,
						mediaType: "movie",
						title: "Target",
						ratingKey: "123",
						thumb: "/library/metadata/123/thumb/1",
					},
				]),
			)
			.mockResolvedValueOnce(
				authoritativeEvidence([
					{
						tmdbId: 42,
						mediaType: "movie",
						title: "Target",
						ratingKey: "123",
						thumb: "/library/metadata/456/thumb/1",
					},
				]),
			);

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("does not send a current rating key to a destination connection that was repointed", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Target",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);
		const oldDestination = {
			...instance,
			id: "plex-dest",
			baseUrl: "https://old-plex.invalid",
			connectionGeneration: 3,
			identityGeneration: 8,
		} as DestWriterOpts["destInstance"];
		const prisma = {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					...oldDestination,
					baseUrl: "https://new-plex.invalid",
					connectionGeneration: 5,
					identityGeneration: 10,
				}),
			},
		} as unknown as DestWriterOpts["prisma"];

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: oldDestination,
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma,
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it.each([
		{ connectionGeneration: 5, identityGeneration: 9, changed: "connection" },
		{ connectionGeneration: 4, identityGeneration: 10, changed: "identity" },
	])("does not mutate when the current $changed generation changes", async (generations) => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Target",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);
		const prisma = {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					...instance,
					id: "plex-dest",
					connectionGeneration: generations.connectionGeneration,
					identityGeneration: generations.identityGeneration,
				}),
			},
		} as unknown as DestWriterOpts["prisma"];

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma,
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("does not mutate when the destination is no longer owned and enabled", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Target",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(null) },
		} as unknown as DestWriterOpts["prisma"];

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma,
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("returns a clean no-match result without initializing the client", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(authoritativeEvidence([]));

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 0 });
		expect(mocks.createPlexClient).not.toHaveBeenCalled();
		expect(mocks.updateMetadataTags).not.toHaveBeenCalled();
	});

	it("counts an upstream label failure without recording success", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Target",
					ratingKey: "123",
					thumb: "/library/metadata/123/thumb/1",
				},
			]),
		);
		mocks.updateMetadataTags.mockRejectedValueOnce(new Error("upstream rejected write"));

		const result = await plexDestWriter.applyLabels({
			rule,
			destInstance: { ...instance, id: "plex-dest" } as DestWriterOpts["destInstance"],
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "Target" }],
			prisma: destinationPrisma(),
			arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
			encryptor: {} as DestWriterOpts["encryptor"],
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.updateMetadataTags).toHaveBeenCalledOnce();
	});
});
