import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelSyncRuleInput } from "../execute-rule.js";
import type { DestWriterOpts, SourceReaderOpts } from "../strategy-types.js";

const mocks = vi.hoisted(() => ({
	loadInstanceSelectedEvidence: vi.fn(),
	updateMetadataTags: vi.fn(),
	createPlexClient: vi.fn(),
}));

vi.mock("../../plex/plex-evidence-repository.js", () => ({
	loadInstanceSelectedEvidence: mocks.loadInstanceSelectedEvidence,
	loadInstanceSelectedMutationEvidence: mocks.loadInstanceSelectedEvidence,
}));

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

	it("uses only a persisted exact rating key and never falls back to a thumbnail path", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{
					tmdbId: 42,
					mediaType: "movie",
					title: "Exact target",
					ratingKey: null,
					thumb: "/library/metadata/unsafe-fallback/thumb/1",
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

	it("does not infer a complete duplicate-edition set from one persisted rating key", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{ tmdbId: 42, mediaType: "movie", title: "Observed copy", ratingKey: "rating-a" },
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
		expect(mocks.updateMetadataTags).toHaveBeenCalledWith("rating-a", "label", "add", "Family");
	});

	it("does not mutate when exact destination evidence changes before the write", async () => {
		mocks.loadInstanceSelectedEvidence
			.mockResolvedValueOnce(
				authoritativeEvidence([
					{ tmdbId: 42, mediaType: "movie", title: "Target", ratingKey: "rating-a" },
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

	it("does not send a current rating key to a destination connection that was repointed", async () => {
		mocks.loadInstanceSelectedEvidence.mockResolvedValue(
			authoritativeEvidence([
				{ tmdbId: 42, mediaType: "movie", title: "Target", ratingKey: "rating-a" },
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
});
