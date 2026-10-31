import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualImportSubmissionFile } from "@arr/shared";
import { manualImportOperationStatusSchema } from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
import { releaseTerminalImportSources } from "../../lib/arr/import-operations/repository.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { registerManualImportRoutes } from "../manual-import.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
let app: FastifyInstance;
const encryptor = new Encryptor(Buffer.alloc(32, 9).toString("base64"));
const services = [
	{
		service: "sonarr",
		Client: SonarrClient,
		media: { seriesId: 12, episodeIds: [13] },
		candidate: { series: { id: 12 }, episodes: [{ id: 13 }, { id: 14 }] },
	},
	{
		service: "radarr",
		Client: RadarrClient,
		media: { movieId: 12 },
		candidate: { movie: { id: 12 } },
	},
	{
		service: "lidarr",
		Client: LidarrClient,
		media: { artistId: 12, albumId: 13 },
		candidate: { artist: { id: 12 }, album: { id: 13 }, albumReleaseId: 14, tracks: [{ id: 15 }] },
	},
	{
		service: "readarr",
		Client: ReadarrClient,
		media: { authorId: 12, bookId: 13 },
		candidate: { author: { id: 12 }, book: { id: 13 }, foreignEditionId: "edition-1" },
	},
] as const;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-manual-route-"));
	const databaseUrl = `file:${join(directory, "fixture.db")}`;
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: databaseUrl },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(databaseUrl);
}, 30_000);
beforeEach(async () => {
	await prisma.user.deleteMany();
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other", username: "synthetic-other" },
		],
	});
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("encryptor", encryptor);
	app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
	setupAuthInjection(app, { id: "owner" });
	registerTestErrorHandler(app);
	await app.register(registerManualImportRoutes);
	await app.ready();
});
afterEach(async () => {
	await app?.close();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function fixture(service: (typeof services)[number] = services[1]) {
	const encrypted = encryptor.encrypt("synthetic-api-key");
	await prisma.serviceInstance.create({
		data: {
			id: "instance",
			userId: "owner",
			service: service.service.toUpperCase() as "SONARR" | "RADARR" | "LIDARR" | "READARR",
			label: "Synthetic",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: encrypted.value,
			encryptionIv: encrypted.iv,
		},
	});
	const client = new service.Client({
		baseUrl: "https://fixture.invalid",
		apiKey: "synthetic-api-key",
	});
	const candidate = {
		id: 1,
		path: "/synthetic/file",
		downloadId: "source",
		quality: { quality: { id: 1 } },
		...service.candidate,
	};
	const reads = vi.fn().mockResolvedValue([candidate]);
	if (client instanceof SonarrClient || client instanceof RadarrClient)
		vi.spyOn(client.manualImport, "get").mockImplementation(reads);
	else vi.spyOn(client, "get").mockImplementation(reads);
	const posts = vi
		.spyOn(client, "post")
		.mockImplementation(
			async (_path, body) => ({ id: 51, name: "ManualImport", status: "queued", body }) as never,
		);
	const factory = vi.spyOn(app.arrClientFactory, "create").mockReturnValue(client);
	const body = {
		instanceId: "instance",
		service: service.service,
		importMode: "auto",
		idempotencyKey: "attempt-1",
		files: [{ path: candidate.path, downloadId: candidate.downloadId, ...service.media }],
	};
	const inject = createInjectAuthenticated(app);
	const submit = (payload: unknown = body) => inject("POST", "/manual-import", { body: payload });
	return { body, candidate, reads, posts, factory, submit, inject };
}

async function reviewFixture() {
	const f = await fixture(services[0]);
	const result = await f.submit({
		...f.body,
		files: [{ ...f.body.files[0]!, episodeIds: [13, 14] }],
	});
	if (result.statusCode !== 202) throw new Error("Expected a synthetic submitted attempt");
	const { operationId } = result.json<{ operationId: string }>();
	const operation = await prisma.arrImportOperation.findFirstOrThrow({
		where: { id: operationId, userId: "owner" },
		include: { files: true },
	});
	const ended = new Date();
	const cursor = {
		version: 2,
		commandFingerprint: operation.commandFingerprint,
		commandId: 51,
		commandEndedAt: ended.toISOString(),
		sourceIndex: 1,
		page: 1,
		pageSize: null,
		totalRecords: null,
		seenRecords: 0,
		witnesses: [],
		ambiguousFiles: [],
		retainedWitnesses: [
			{ fileFingerprint: operation.files[0]!.fileFingerprint, fileId: 31, episodeIds: [13] },
		],
		retainedAmbiguousFiles: [] as string[],
	};
	await prisma.arrImportOperation.updateMany({
		where: { id: operationId, userId: "owner" },
		data: {
			state: "failed",
			commandState: "failed",
			commandTerminal: true,
			lastCheckedAt: ended,
			reconcileCursor: cursor,
		},
	});
	await releaseTerminalImportSources(prisma, "owner", operationId);
	const url = `/manual-import/operations/${operationId}/remainder?instanceId=instance&service=sonarr&downloadId=source`;
	return { ...f, operationId, cursor, url };
}

describe("public Manual Import durable route", () => {
	it("submits only an explicit reviewed disjoint episode remainder under its retained new key", async () => {
		const f = await reviewFixture();
		const before = await prisma.arrImportOperation.findFirstOrThrow({
			where: { id: f.operationId, userId: "owner" },
			include: { files: true },
		});
		const review = await f.inject("GET", f.url);
		expect(review.statusCode).toBe(200);
		const payload = {
			...f.body,
			idempotencyKey: "remaining-intention",
			remainderOf: f.operationId,
			files: [{ ...f.body.files[0]!, episodeIds: [14] }],
		};
		const submitted = await f.submit(payload);
		expect(submitted.statusCode).toBe(202);
		expect(submitted.json()).toMatchObject({
			state: "pending",
			selectedFileCount: 1,
			verifiedFileCount: 0,
		});
		expect(f.posts).toHaveBeenCalledTimes(2);
		expect(f.posts.mock.calls[1]![1]).toMatchObject({
			files: [expect.objectContaining({ seriesId: 12, episodeIds: [14] })],
		});
		const again = await f.submit(payload);
		expect(again.json()).toEqual(submitted.json());
		expect(f.posts).toHaveBeenCalledTimes(2);
		expect((await f.submit({ ...payload, remainderOf: "another-original" })).statusCode).toBe(409);
		expect(f.posts).toHaveBeenCalledTimes(2);
		expect(
			await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: f.operationId, userId: "owner" },
				include: { files: true },
			}),
		).toEqual(before);
	});
	it("excludes a covered episode without falsely completing its compound file", async () => {
		const f = await reviewFixture();
		const before = await prisma.arrImportOperation.findFirstOrThrow({
			where: { id: f.operationId, userId: "owner" },
			include: { files: true },
		});
		const response = await f.inject("GET", f.url);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			operation: { selectedFileCount: 1, verifiedFileCount: 0, state: "failed" },
			sourceFileCount: 1,
			sourceVerifiedFileCount: 0,
			verifiedEpisodeCount: 1,
			unavailableFileCount: 0,
			candidates: [{ episodes: [{ id: 14 }] }],
		});
		expect(
			await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: f.operationId, userId: "owner" },
				include: { files: true },
			}),
		).toEqual(before);
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it.each([
		"missing",
		"duplicate",
		"remapped",
		"missing-episode",
		"wrong-source",
		"provisional",
		"ambiguous",
	])(
		"explains an unavailable %s original target rather than hiding or importing it",
		async (kind) => {
			const f = await reviewFixture();
			if (kind === "missing") f.reads.mockResolvedValue([]);
			if (kind === "duplicate") f.reads.mockResolvedValue([f.candidate, { ...f.candidate, id: 2 }]);
			if (kind === "remapped") f.reads.mockResolvedValue([{ ...f.candidate, series: { id: 99 } }]);
			if (kind === "missing-episode")
				f.reads.mockResolvedValue([{ ...f.candidate, episodes: [{ id: 13 }] }]);
			if (kind === "wrong-source")
				f.reads.mockResolvedValue([{ ...f.candidate, downloadId: "foreign-source" }]);
			if (kind === "provisional" || kind === "ambiguous") {
				await prisma.arrImportOperation.updateMany({
					where: { id: f.operationId, userId: "owner" },
					data: {
						reconcileCursor: {
							...f.cursor,
							sourceIndex: kind === "provisional" ? 0 : 1,
							witnesses:
								kind === "provisional"
									? [
											{
												fileFingerprint: f.cursor.retainedWitnesses[0]!.fileFingerprint,
												fileId: 31,
												episodeIds: [14],
											},
										]
									: [],
							retainedWitnesses: kind === "ambiguous" ? [] : f.cursor.retainedWitnesses,
							retainedAmbiguousFiles:
								kind === "ambiguous" ? [f.cursor.retainedWitnesses[0]!.fileFingerprint] : [],
						},
					},
				});
			}
			const response = await f.inject("GET", f.url);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				operation: { verifiedFileCount: 0 },
				sourceFileCount: 1,
				sourceVerifiedFileCount: 0,
				unavailableFileCount: 1,
				candidates: [],
			});
			expect(f.posts).toHaveBeenCalledOnce();
			expect(await prisma.arrImportOperation.count()).toBe(1);
		},
	);
	it.each([
		"pending",
		"connection",
		"invalid-cursor",
		"live-observer",
		"active-source",
		"future-check",
		"provider-error",
		"over-budget",
	])("rejects an unavailable %s review without submitting new work", async (kind) => {
		const f = await reviewFixture();
		if (kind === "connection")
			await prisma.serviceInstance.updateMany({
				where: { id: "instance", userId: "owner" },
				data: { baseUrl: "https://changed.invalid" },
			});
		if (
			kind === "pending" ||
			kind === "invalid-cursor" ||
			kind === "live-observer" ||
			kind === "future-check"
		) {
			await prisma.arrImportOperation.updateMany({
				where: { id: f.operationId, userId: "owner" },
				data:
					kind === "pending"
						? { state: "pending", commandState: "pending", commandTerminal: false }
						: kind === "invalid-cursor"
							? { reconcileCursor: { version: 99 } }
							: kind === "live-observer"
								? {
										reconcileToken: "synthetic-observer",
										reconcileExpiresAt: new Date(Date.now() + 30000),
									}
								: { lastCheckedAt: new Date(Date.now() + 60000) },
			});
		}
		if (kind === "active-source")
			await prisma.arrImportSourceClaim.updateMany({
				where: { userId: "owner" },
				data: { activeOperationId: "other-active-attempt" },
			});
		if (kind === "provider-error")
			f.reads.mockRejectedValue(new Error("synthetic-private-provider-error"));
		if (kind === "over-budget")
			f.reads.mockImplementation(async () => {
				vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16000);
				return [f.candidate];
			});
		const response = await f.inject("GET", f.url);
		expect(response.statusCode).toBe(503);
		expect(response.body).not.toContain("synthetic-private-provider-error");
		expect(f.posts).toHaveBeenCalledOnce();
		expect(f.reads).toHaveBeenCalledTimes(
			kind === "provider-error" || kind === "over-budget" ? 2 : 1,
		);
	});
	it.each(["owner", "alias", "source", "service"])(
		"cannot review a foreign %s binding",
		async (kind) => {
			const f = await reviewFixture();
			if (kind === "owner")
				await prisma.arrImportOperation.updateMany({
					where: { id: f.operationId, userId: "owner" },
					data: { userId: "other" },
				});
			const url =
				kind === "alias"
					? f.url.replace("instanceId=instance", "instanceId=alias")
					: kind === "source"
						? f.url.replace("downloadId=source", "downloadId=foreign")
						: kind === "service"
							? f.url.replace("service=sonarr", "service=radarr")
							: f.url;
			expect((await f.inject("GET", url)).statusCode).toBe(404);
			expect(f.reads).toHaveBeenCalledOnce();
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it.each(["proof", "connection", "claim"])(
		"rejects a review that changed during the provider read: %s",
		async (kind) => {
			const f = await reviewFixture();
			f.reads.mockImplementation(async () => {
				if (kind === "proof")
					await prisma.arrImportOperation.updateMany({
						where: { id: f.operationId, userId: "owner" },
						data: {
							revision: { increment: 1 },
							reconcileCursor: {
								...f.cursor,
								retainedWitnesses: [{ ...f.cursor.retainedWitnesses[0]!, episodeIds: [13, 14] }],
							},
						},
					});
				if (kind === "connection")
					await prisma.serviceInstance.updateMany({
						where: { id: "instance", userId: "owner" },
						data: { encryptedApiKey: "changed-synthetic-key" },
					});
				if (kind === "claim")
					await prisma.arrImportSourceClaim.updateMany({
						where: { userId: "owner" },
						data: { activeOperationId: "other-active-attempt" },
					});
				return [f.candidate];
			});
			expect((await f.inject("GET", f.url)).statusCode).toBe(503);
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it("preserves the original explicit Copy mode in review", async () => {
		const f = await fixture();
		const submitted = await f.submit({ ...f.body, importMode: "copy" });
		const { operationId } = submitted.json<{ operationId: string }>();
		await prisma.arrImportOperation.updateMany({
			where: { id: operationId, userId: "owner" },
			data: {
				state: "failed",
				commandState: "failed",
				commandTerminal: true,
				lastCheckedAt: new Date(),
			},
		});
		await releaseTerminalImportSources(prisma, "owner", operationId);
		const response = await f.inject(
			"GET",
			`/manual-import/operations/${operationId}/remainder?instanceId=instance&service=radarr&downloadId=source`,
		);
		expect(response.statusCode).toBe(200);
		expect(response.json().importMode).toBe("copy");
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it.each(services.filter((service) => service.service !== "sonarr"))(
		"does not offer a retained positive $service file with a missing full-file marker",
		async (service) => {
			const f = await fixture(service);
			const submitted = await f.submit();
			const { operationId } = submitted.json<{ operationId: string }>();
			const operation = await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: operationId, userId: "owner" },
				include: { files: true },
			});
			const checkedAt = new Date();
			await prisma.arrImportOperation.updateMany({
				where: { id: operationId, userId: "owner" },
				data: {
					state: "failed",
					commandState: "failed",
					commandTerminal: true,
					lastCheckedAt: checkedAt,
					reconcileCursor: {
						version: 2,
						commandFingerprint: operation.commandFingerprint,
						commandId: 51,
						commandEndedAt: checkedAt.toISOString(),
						sourceIndex: 1,
						page: 1,
						pageSize: null,
						totalRecords: null,
						seenRecords: 0,
						witnesses: [],
						ambiguousFiles: [],
						retainedWitnesses: [
							{ fileFingerprint: operation.files[0]!.fileFingerprint, fileId: 31, episodeIds: [] },
						],
						retainedAmbiguousFiles: [],
					},
				},
			});
			await releaseTerminalImportSources(prisma, "owner", operationId);
			const response = await f.inject(
				"GET",
				"/manual-import/operations/" +
					operationId +
					"/remainder?instanceId=instance&service=" +
					service.service +
					"&downloadId=source",
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				operation: { verifiedFileCount: 0 },
				sourceVerifiedFileCount: 0,
				unavailableFileCount: 1,
				candidates: [],
			});
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it.each(services)(
		"excludes the actually verified $service file while offering its remaining peer",
		async (service) => {
			const f = await fixture(service);
			const candidate = {
				...f.candidate,
				id: 2,
				path: "/synthetic/remaining",
				...(service.service === "sonarr" ? { episodes: [{ id: 14 }] } : {}),
			};
			f.reads.mockResolvedValue([f.candidate, candidate]);
			const remaining = {
				...f.body.files[0]!,
				path: candidate.path,
				...(service.service === "sonarr" ? { episodeIds: [14] } : {}),
			};
			const submitted = await f.submit({ ...f.body, files: [...f.body.files, remaining] });
			expect(submitted.statusCode).toBe(202);
			const { operationId } = submitted.json<{ operationId: string }>();
			const operation = await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: operationId, userId: "owner" },
				include: { files: true },
			});
			const selected = operation.files.find(
				(file) =>
					(file.identityJson as { pathHash: string }).pathHash ===
					createHash("sha256").update("/synthetic/file").digest("hex"),
			)!;
			const checkedAt = new Date();
			await prisma.arrImportFileProof.updateMany({
				where: { id: selected.id, operation: { userId: "owner" } },
				data: { verifiedAt: checkedAt },
			});
			await prisma.arrImportOperation.updateMany({
				where: { id: operationId, userId: "owner" },
				data: {
					state: "partial",
					commandState: "failed",
					commandTerminal: true,
					lastCheckedAt: checkedAt,
					verifiedFileCount: 1,
				},
			});
			await releaseTerminalImportSources(prisma, "owner", operationId);
			const response = await f.inject(
				"GET",
				"/manual-import/operations/" +
					operationId +
					"/remainder?instanceId=instance&service=" +
					service.service +
					"&downloadId=source",
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				operation: { selectedFileCount: 2, verifiedFileCount: 1 },
				sourceFileCount: 2,
				sourceVerifiedFileCount: 1,
				verifiedEpisodeCount: service.service === "sonarr" ? 1 : 0,
				unavailableFileCount: 0,
				candidates: [{ path: "/synthetic/remaining" }],
			});
			expect(response.json().candidates).toHaveLength(1);
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it.each(services)(
		"reviews fresh remaining $service candidates without any write",
		async (service) => {
			const f = await fixture(service);
			const submitted = await f.submit();
			expect(submitted.statusCode).toBe(202);
			const { operationId } = submitted.json<{ operationId: string }>();
			await prisma.arrImportOperation.updateMany({
				where: { id: operationId, userId: "owner" },
				data: {
					state: "failed",
					commandState: "failed",
					commandTerminal: true,
					lastCheckedAt: new Date(),
				},
			});
			await releaseTerminalImportSources(prisma, "owner", operationId);
			const before = await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: operationId, userId: "owner" },
				include: { files: true },
			});
			const response = await f.inject(
				"GET",
				`/manual-import/operations/${operationId}/remainder?instanceId=instance&service=${service.service}&downloadId=source`,
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				operation: { operationId, state: "failed", verifiedFileCount: 0 },
				importMode: "move",
				sourceFileCount: 1,
				sourceVerifiedFileCount: 0,
				verifiedEpisodeCount: 0,
				unavailableFileCount: 0,
				candidates: [{ service: service.service, path: "/synthetic/file" }],
			});
			if (service.service === "sonarr")
				expect(response.json().candidates[0].episodes).toEqual([{ id: 13 }]);
			expect(f.posts).toHaveBeenCalledOnce();
			expect(f.reads).toHaveBeenCalledTimes(2);
			expect(
				await prisma.arrImportOperation.findFirstOrThrow({
					where: { id: operationId, userId: "owner" },
					include: { files: true },
				}),
			).toEqual(before);
			expect(await prisma.arrImportOperation.count()).toBe(1);
			expect(
				await prisma.arrImportSourceClaim.count({
					where: { userId: "owner", activeOperationId: { not: null } },
				}),
			).toBe(0);
		},
	);
	it.each(services)(
		"$service returns actual pending progress and repeats never replay",
		async (service) => {
			const f = await fixture(service);
			const first = await f.submit();
			expect(first.statusCode).toBe(202);
			const status = manualImportOperationStatusSchema.parse(first.json());
			expect(status).toMatchObject({
				state: "pending",
				selectedFileCount: 1,
				verifiedFileCount: 0,
				canConsiderNewAttempt: false,
			});
			const retry = await f.submit();
			expect(retry.statusCode).toBe(202);
			expect(retry.json()).toEqual(status);
			expect(f.posts).toHaveBeenCalledTimes(1);
			expect(f.reads).toHaveBeenCalledTimes(1);
			expect(f.posts.mock.calls[0]?.[1]).toMatchObject({
				files: [{ ...service.media, quality: f.candidate.quality }],
			});
			const operation = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: "owner" },
				include: { files: true },
			});
			expect(operation.files).toHaveLength(1);
			expect(
				await prisma.arrImportSourceClaim.count({
					where: { userId: "owner", activeOperationId: operation.id },
				}),
			).toBe(1);
			expect(first.body).not.toMatch(
				/synthetic\/file|synthetic-api-key|fixture.invalid|encryptedSources|downloadId/,
			);
		},
	);
	it("binds an explicit key to the immutable selection and mode", async () => {
		const f = await fixture();
		await f.submit();
		for (const change of [
			{ importMode: "copy" },
			{ files: [{ ...f.body.files[0], movieId: 99 }] },
		]) {
			expect((await f.submit({ ...f.body, ...change })).statusCode).toBe(409);
		}
		expect(f.posts).toHaveBeenCalledTimes(1);
		expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(1);
	});
	it("gives keyless compatibility retries stable identity", async () => {
		const f = await fixture();
		const { idempotencyKey: _key, ...body } = f.body;
		const first = await f.submit(body);
		const retry = await f.submit(body);
		expect(first.statusCode).toBe(202);
		expect(retry.json()).toEqual(first.json());
		expect(f.posts).toHaveBeenCalledTimes(1);
	});
	it("keeps compatibility identity when file order or equivalent move mode changes", async () => {
		const f = await fixture();
		const secondFile = { ...f.body.files[0]!, path: "/synthetic/second", movieId: 14 };
		f.reads.mockResolvedValue([
			f.candidate,
			{ ...f.candidate, path: secondFile.path, movie: { id: 14 } },
		]);
		const { idempotencyKey: _key, ...body } = f.body;
		const first = await f.submit({ ...body, files: [...body.files, secondFile] });
		const retry = await f.submit({
			...body,
			importMode: "move",
			files: [secondFile, ...body.files],
		});
		expect(first.statusCode).toBe(202);
		expect(retry.json()).toEqual(first.json());
		expect(first.json()).toMatchObject({ selectedFileCount: 2, verifiedFileCount: 0 });
		expect(f.posts).toHaveBeenCalledTimes(1);
	});
	it("re-fetches every selected source and never forwards browser quality as command authority", async () => {
		const f = await fixture();
		f.reads.mockImplementation(async (query: { downloadId: string }) => [
			{
				...f.candidate,
				path: query.downloadId === "source" ? f.candidate.path : "/synthetic/second",
				downloadId: query.downloadId,
			},
		]);
		const response = await f.submit({
			...f.body,
			files: [
				{ ...f.body.files[0], quality: { quality: { id: 999 } } },
				{ ...f.body.files[0], path: "/synthetic/second", downloadId: "second-source" },
			],
		});
		expect(response.statusCode).toBe(202);
		expect(response.json()).toMatchObject({ selectedFileCount: 2, verifiedFileCount: 0 });
		expect(f.reads.mock.calls.map(([query]) => query.downloadId)).toEqual([
			"source",
			"second-source",
		]);
		expect(f.posts.mock.calls[0]?.[1]).toMatchObject({
			files: [
				{ downloadId: "source", quality: { quality: { id: 1 } } },
				{ downloadId: "second-source", quality: { quality: { id: 1 } } },
			],
		});
		expect(await prisma.arrImportSourceClaim.count({ where: { userId: "owner" } })).toBe(2);
	});
	it("holds overlapping concurrent submissions until actual provider settlement", async () => {
		const f = await fixture();
		let announce!: () => void;
		let settle!: () => void;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const settlement = new Promise<void>((resolve) => {
			settle = resolve;
		});
		f.posts.mockImplementation(async (_path, body) => {
			announce();
			await settlement;
			return { id: 51, name: "ManualImport", status: "queued", body } as never;
		});
		const work = f.submit();
		await started;
		try {
			const overlap = await f.submit();
			// The persisted attempt can already be observed while its acknowledgement is unsettled.
			expect(overlap.statusCode).toBe(202);
			expect(overlap.json()).toMatchObject({
				state: "submitting",
				selectedFileCount: 1,
				verifiedFileCount: 0,
			});
			expect((await f.submit({ ...f.body, idempotencyKey: "another-attempt" })).statusCode).toBe(
				409,
			);
			expect(f.posts).toHaveBeenCalledTimes(1);
		} finally {
			settle();
			await work;
		}
		expect((await f.submit()).json()).toMatchObject({ state: "pending" });
		expect(f.posts).toHaveBeenCalledTimes(1);
	});
	it.each(["failed", "completed", "transport-unknown"])(
		"does not call %s command evidence file completion",
		async (outcome) => {
			const f = await fixture();
			f.posts.mockImplementation(async (_path, body) => {
				if (outcome === "transport-unknown") throw new Error("synthetic-private-provider-error");
				return {
					id: 51,
					name: "ManualImport",
					status: outcome,
					result: outcome === "completed" ? "successful" : "unsuccessful",
					body,
				} as never;
			});
			const response = await f.submit();
			expect(response.statusCode).toBe(202);
			expect(manualImportOperationStatusSchema.parse(response.json())).toMatchObject({
				state: outcome === "failed" ? "failed" : "unknown",
				selectedFileCount: 1,
				verifiedFileCount: 0,
			});
			expect((await f.submit()).json()).toEqual(response.json());
			expect(f.posts).toHaveBeenCalledTimes(1);
			expect(response.body).not.toContain("synthetic-private-provider-error");
		},
	);
	it.each(["disabled", "changed-media", "foreign-source"])(
		"refuses %s current targets without durable or upstream writes",
		async (reason) => {
			const f = await fixture();
			if (reason === "disabled")
				await prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { enabled: false },
				});
			else
				f.reads.mockResolvedValue([
					{
						...f.candidate,
						...(reason === "changed-media" ? { movie: { id: 99 } } : { downloadId: "foreign" }),
					},
				]);
			expect((await f.submit()).statusCode).toBe(409);
			expect(f.posts).not.toHaveBeenCalled();
			expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(0);
		},
	);
	it("returns foreign connection as not found without provider access", async () => {
		const f = await fixture();
		await prisma.serviceInstance.update({ where: { id: "instance" }, data: { userId: "other" } });
		expect((await f.submit()).statusCode).toBe(404);
		expect(f.factory).not.toHaveBeenCalled();
	});
	it.each(["", " attempt", "attempt ", "x".repeat(129)])(
		"refuses malformed explicit key (%j) before provider access",
		async (idempotencyKey) => {
			const f = await fixture();
			expect((await f.submit({ ...f.body, idempotencyKey })).statusCode).toBe(400);
			expect(f.factory).not.toHaveBeenCalled();
		},
	);
	it("rejects oversized selections with split guidance before provider reads", async () => {
		const f = await fixture();
		const files: ManualImportSubmissionFile[] = Array.from({ length: 1001 }, (_, index) => ({
			path: `/synthetic/${index}`,
			downloadId: "source",
			movieId: 12,
		}));
		const response = await f.submit({ ...f.body, files });
		expect(response.statusCode).toBe(413);
		expect(response.body).toMatch(/smaller|Split/);
		expect(f.factory).not.toHaveBeenCalled();
	});
	it("serves cached owned progress without constructing any provider client", async () => {
		const f = await fixture();
		const response = await f.submit();
		const status = manualImportOperationStatusSchema.parse(response.json());
		f.factory.mockClear();
		f.reads.mockClear();
		f.posts.mockClear();
		const observed = await f.inject("GET", `/manual-import/operations/${status.operationId}`);
		expect(observed.statusCode).toBe(200);
		expect(observed.json()).toEqual(status);
		expect(f.factory).not.toHaveBeenCalled();
		expect(f.reads).not.toHaveBeenCalled();
		expect(f.posts).not.toHaveBeenCalled();
		await prisma.arrImportOperation.updateMany({
			where: { id: status.operationId, userId: "owner" },
			data: { userId: "other" },
		});
		expect(
			(await f.inject("GET", `/manual-import/operations/${status.operationId}`)).statusCode,
		).toBe(404);
	});
	it("reports inconsistent cached proof counts as unavailable, never zero or completed", async () => {
		const f = await fixture();
		const response = await f.submit();
		const status = manualImportOperationStatusSchema.parse(response.json());
		await prisma.arrImportOperation.updateMany({
			where: { id: status.operationId, userId: "owner" },
			data: { verifiedFileCount: 1 },
		});
		f.factory.mockClear();
		const observed = await f.inject("GET", `/manual-import/operations/${status.operationId}`);
		expect(observed.statusCode).toBe(503);
		expect(observed.body).not.toMatch(/verifiedFileCount|synthetic\/file|source/);
		expect(f.factory).not.toHaveBeenCalled();
	});
	it("keeps cached historical progress readable after its connection is removed", async () => {
		const f = await fixture();
		const response = await f.submit();
		const status = manualImportOperationStatusSchema.parse(response.json());
		// Fixture-only FK exercise, not the public deletion path or cleanup permission.
		await prisma.serviceInstance.deleteMany({ where: { id: "instance", userId: "owner" } });
		f.factory.mockClear();
		const observed = await f.inject("GET", `/manual-import/operations/${status.operationId}`);
		expect(observed.statusCode).toBe(200);
		expect(observed.json()).toEqual(status);
		expect(f.factory).not.toHaveBeenCalled();
	});
	it.each(["removed", "retargeted"])(
		"a same-key retry observes history after its connection is %s without provider access",
		async (change) => {
			const f = await fixture();
			const response = await f.submit();
			if (change === "removed")
				await prisma.serviceInstance.deleteMany({ where: { id: "instance", userId: "owner" } });
			else
				await prisma.serviceInstance.updateMany({
					where: { id: "instance", userId: "owner" },
					data: { service: "SONARR" },
				});
			f.factory.mockClear();
			const retry = await f.submit();
			expect(retry.statusCode).toBe(202);
			expect(retry.json()).toEqual(response.json());
			expect(f.factory).not.toHaveBeenCalled();
			expect(f.posts).toHaveBeenCalledTimes(1);
		},
	);
	it("returns a generic not-found category for absent operation IDs", async () => {
		const f = await fixture();
		const response = await f.inject("GET", "/manual-import/operations/missing-operation");
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "Import operation not found" });
		expect(f.factory).not.toHaveBeenCalled();
	});
	it("recovers a lost acknowledgement by the owned attempt key without provider access", async () => {
		const f = await fixture();
		const response = await f.submit();
		f.factory.mockClear();
		f.reads.mockClear();
		f.posts.mockClear();
		const observed = await f.inject("GET", "/manual-import/operations?idempotencyKey=attempt-1");
		expect(observed.statusCode).toBe(200);
		expect(observed.json()).toEqual(response.json());
		expect(f.factory).not.toHaveBeenCalled();
		expect(f.reads).not.toHaveBeenCalled();
		expect(f.posts).not.toHaveBeenCalled();
		await prisma.arrImportOperation.updateMany({
			where: { userId: "owner", idempotencyKey: "attempt-1" },
			data: { userId: "other" },
		});
		expect(
			(await f.inject("GET", "/manual-import/operations?idempotencyKey=attempt-1")).statusCode,
		).toBe(404);
	});
	it.each([
		"",
		"?idempotencyKey=",
		"?idempotencyKey=bad%20key",
		`?idempotencyKey=${"a".repeat(129)}`,
	])("rejects missing or malformed cached lookup keys: %s", async (query) => {
		const f = await fixture();
		const observed = await f.inject("GET", `/manual-import/operations${query}`);
		expect(observed.statusCode).toBe(400);
		expect(f.factory).not.toHaveBeenCalled();
		expect(f.reads).not.toHaveBeenCalled();
		expect(f.posts).not.toHaveBeenCalled();
	});
	it("does not fabricate cached counts during attempt-key recovery", async () => {
		const f = await fixture();
		await f.submit();
		await prisma.arrImportOperation.updateMany({
			where: { userId: "owner", idempotencyKey: "attempt-1" },
			data: { verifiedFileCount: 1 },
		});
		f.factory.mockClear();
		const observed = await f.inject("GET", "/manual-import/operations?idempotencyKey=attempt-1");
		expect(observed.statusCode).toBe(503);
		expect(observed.body).not.toMatch(/verifiedFileCount|synthetic\/file|source/);
		expect(f.factory).not.toHaveBeenCalled();
	});
});
