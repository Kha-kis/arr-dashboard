/** Owned Tautulli positive-observation publication tests. */

import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Encryptor } from "../../auth/encryption.js";
import type { PrismaClient, ServiceInstance } from "../../prisma.js";
import {
	refreshOwnedTautulliCache,
	type TautulliCacheRefreshResult,
} from "../tautulli-cache-refresher.js";
import type { TautulliClient } from "../tautulli-client.js";
import { decodeTautulliObservationMetadata } from "../tautulli-observation-metadata.js";

vi.mock("../../utils/delay.js", () => ({ delay: vi.fn(async () => {}) }));

const provider = vi.hoisted(() => ({
	client: undefined as TautulliClient | undefined,
	events: [] as string[],
	identityValues: [] as string[],
}));
const metadataControl = vi.hoisted(() => ({ encodeFailure: false }));

vi.mock("../tautulli-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../tautulli-client.js")>();
	return {
		...actual,
		TautulliClient: class {
			constructor(..._args: unknown[]) {
				provider.events.push("construct");
				if (!provider.client) throw new Error("Tautulli fixture is not configured");
				Object.assign(this, provider.client);
			}
		},
	};
});

vi.mock("../../services/service-identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../services/service-identity.js")>();
	return {
		...actual,
		readProviderIdentity: vi.fn(
			async (serviceInstance: { service: string; expectedIdentity: string | null }) => {
				provider.events.push("identity");
				return {
					service: serviceInstance.service,
					identityKind: "tautulli-pms-identifier",
					rawIdentity: provider.identityValues.shift() ?? serviceInstance.expectedIdentity,
					confirmationDigest: "digest",
					fingerprint: "fingerprint",
				};
			},
		),
	};
});

vi.mock("../tautulli-observation-metadata.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../tautulli-observation-metadata.js")>();
	return {
		...actual,
		encodeTautulliObservationMetadata: vi.fn((value: unknown) => {
			if (metadataControl.encodeFailure) throw new Error("metadata must not escape");
			return actual.encodeTautulliObservationMetadata(value);
		}),
	};
});

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

const instance = {
	id: "tautulli-synthetic",
	userId: "user-synthetic",
	service: "TAUTULLI",
	label: "synthetic-tautulli",
	baseUrl: "https://tautulli.invalid",
	enabled: true,
	encryptedApiKey: "encrypted-api-key",
	encryptionIv: "api-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	expectedIdentity: "pms-synthetic",
	identityStatus: "VERIFIED",
	connectionGeneration: 4,
	identityGeneration: 9,
} as unknown as ServiceInstance;

type State = {
	rows: unknown[];
	status: Record<string, unknown>;
	db: PrismaClient;
	tx: Record<string, any>;
};

function createState(): State {
	const rows: unknown[] = [];
	const status: Record<string, unknown> = {
		id: "status-synthetic",
		instanceId: instance.id,
		cacheType: "tautulli",
		lastRefreshedAt: new Date("2026-09-02T10:00:00.000Z"),
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 1,
		generationId: null,
		generationMetadata: "prior-metadata",
		lastAttemptAt: new Date("2026-09-02T10:00:00.000Z"),
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		connectionGeneration: 4,
		identityGeneration: 9,
	};

	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn(async () => ({ id: "cleanup-config" })),
			findUnique: vi.fn(async () => ({ runClaimToken: null })),
		},
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
				where.connectionGeneration === 4 && where.identityGeneration === 9
					? { id: instance.id }
					: null,
			),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		tautulliCache: {
			deleteMany: vi.fn(async () => {
				provider.events.push("delete");
				rows.splice(0, rows.length);
				return { count: 1 };
			}),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				provider.events.push(`create:${data.length}`);
				rows.push(...data);
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn(async () => structuredClone(status)),
			upsert: vi.fn(
				async ({
					create,
					update,
				}: {
					create?: Record<string, unknown>;
					update?: Record<string, unknown>;
				}) => {
					const data = update ?? create ?? {};
					provider.events.push(
						typeof data.lastAttemptResult === "string" &&
							data.lastAttemptResult.startsWith("in_progress:")
							? "begin"
							: "status",
					);
					Object.assign(status, data);
					return status;
				},
			),
			updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				provider.events.push(data.lastAttemptResult === "success" ? "finish-success" : "failure");
				Object.assign(status, data);
				return { count: 1 };
			}),
		},
	};
	const db = {
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
			const beforeRows = structuredClone(rows);
			const beforeStatus = structuredClone(status);
			try {
				return await callback(tx);
			} catch (error) {
				rows.splice(0, rows.length, ...beforeRows);
				for (const key of Object.keys(status)) delete status[key];
				Object.assign(status, beforeStatus);
				throw error;
			}
		}),
	} as unknown as PrismaClient;
	return { rows, status, db, tx };
}

function encryptor(events = provider.events): Pick<Encryptor, "decrypt"> {
	return {
		decrypt: vi.fn(() => {
			events.push("decrypt");
			return "decrypted-api-key";
		}),
	};
}

function historyClient(rows: unknown[]): TautulliClient {
	return {
		getLibraries: vi.fn(async () => {
			provider.events.push("collect");
			return [{ section_id: "movies", section_type: "movie", section_name: "Movies" }];
		}),
		getHistory: vi.fn(async ({ start, length }: { start: number; length: number }) => ({
			data: rows.slice(start, start + length),
			recordsFiltered: rows.length,
			recordsTotal: rows.length,
		})),
		getMetadata: vi.fn(async (ratingKey: string) => ({
			guids: [`tmdb://${1000 + Number(ratingKey.replace("rk-", ""))}`],
		})),
	} as unknown as TautulliClient;
}

function positiveRows(count: number): unknown[] {
	const date = Math.floor(Date.now() / 1000);
	return Array.from({ length: count }, (_, index) => ({
		row_id: count - index,
		rating_key: `rk-${index}`,
		parent_rating_key: "",
		grandparent_rating_key: "",
		media_type: "movie",
		user: "synthetic-user",
		date,
		play_count: 1,
		group_count: 1,
	}));
}

async function refresh(
	state: State,
	client: TautulliClient,
	ownedEncryptor: Pick<Encryptor, "decrypt"> = encryptor(),
): Promise<TautulliCacheRefreshResult> {
	provider.client = client;
	return await refreshOwnedTautulliCache({
		prisma: state.db,
		encryptor: ownedEncryptor,
		instance,
		log,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	provider.client = undefined;
	provider.events = [];
	provider.identityValues = [];
	metadataControl.encodeFailure = false;
});

describe("refreshOwnedTautulliCache", () => {
	it("owns the attempt before decrypting, collects a bounded positive window, and commits exact metadata", async () => {
		const state = createState();
		const result = await refresh(state, historyClient(positiveRows(205)));

		expect(result.kind).toBe("positive-observation");
		expect(result.complete).toBe(false);
		expect(result.upserted).toBe(205);
		expect(result.errors).toBe(0);
		if (result.kind !== "positive-observation") throw new Error("expected publication");
		expect(result.receipt.evidence).toBe("positive-only");
		expect(result.receipt.publishedCanonicalEntities).toBe(205);
		expect(state.rows).toHaveLength(205);
		expect(state.tx.tautulliCache.createMany).toHaveBeenCalledTimes(3);
		expect(
			state.tx.tautulliCache.createMany.mock.calls.map(
				([arg]: [{ data: unknown[] }]) => arg.data.length,
			),
		).toEqual([100, 100, 5]);
		expect(state.status.generationId).toBeNull();
		expect(state.status.itemCount).toBe(205);
		expect(state.status.connectionGeneration).toBe(4);
		expect(state.status.identityGeneration).toBe(9);
		const metadata = decodeTautulliObservationMetadata(state.status.generationMetadata);
		expect(metadata.ok).toBe(true);
		if (metadata.ok) {
			expect(metadata.metadata).toMatchObject({
				version: 1,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 205,
			});
		}
		expect(provider.events.indexOf("begin")).toBeLessThan(provider.events.indexOf("decrypt"));
		expect(provider.events.indexOf("decrypt")).toBeLessThan(provider.events.indexOf("collect"));
		expect(provider.events.indexOf("collect")).toBeLessThan(provider.events.indexOf("delete"));
		expect(provider.events.indexOf("delete")).toBeLessThan(
			provider.events.indexOf("finish-success"),
		);
	});

	it("publishes a valid empty positive observation without claiming absence or completion", async () => {
		const state = createState();
		state.rows.push({ tmdbId: 9 });

		const result = await refresh(state, historyClient([]));

		expect(result).toMatchObject({
			kind: "positive-observation",
			complete: false,
			upserted: 0,
			errors: 0,
		});
		if (result.kind !== "positive-observation") throw new Error("expected publication");
		expect(result.receipt.publishedCanonicalEntities).toBe(0);
		expect(state.rows).toEqual([]);
		expect(state.status.itemCount).toBe(0);
		expect(state.status.generationId).toBeNull();
	});

	it("returns unpublished superseded without decrypting or contacting the provider", async () => {
		const state = createState();
		state.status.connectionGeneration = 99;
		const decrypt = vi.fn(() => "must-not-run");
		const client = historyClient(positiveRows(1));

		const result = await refresh(state, client, { decrypt });

		expect(result).toEqual({
			kind: "unpublished",
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: ["publication-superseded"],
			superseded: true,
		});
		expect(decrypt).not.toHaveBeenCalled();
		expect(client.getLibraries).not.toHaveBeenCalled();
		expect(state.tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
	});

	it("records a bounded credential failure after beginning and preserves prior publication", async () => {
		const state = createState();
		const priorRows = [{ tmdbId: 123, watchedByUsers: '["prior"]' }];
		state.rows.push(...priorRows);
		const priorMetadata = state.status.generationMetadata;
		const priorObservedAt = state.status.lastRefreshedAt;
		const secret = "credential-secret-must-not-escape";
		const decrypt = vi.fn(() => {
			throw new Error(secret);
		});

		const result = await refresh(state, historyClient(positiveRows(1)), { decrypt });

		expect(result).toEqual({
			kind: "unpublished",
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["provider-unavailable"],
		});
		expect(state.rows).toEqual(priorRows);
		expect(state.status.generationMetadata).toBe(priorMetadata);
		expect(state.status.lastRefreshedAt).toBe(priorObservedAt);
		expect(JSON.stringify(result)).not.toContain(secret);
		const logCalls = Object.values(
			log as unknown as Record<string, { mock?: { calls: unknown[][] } }>,
		).flatMap((method) => method.mock?.calls ?? []);
		expect(JSON.stringify(logCalls)).not.toContain(secret);
	});

	it("maps provider rejection and malformed rows to bounded reasons without partial publication", async () => {
		const state = createState();
		const priorRows = [{ tmdbId: 321 }];
		state.rows.push(...priorRows);
		const unavailableClient = historyClient(positiveRows(1));
		vi.mocked(unavailableClient.getLibraries).mockRejectedValueOnce(new Error("upstream secret"));

		await expect(refresh(state, unavailableClient)).resolves.toMatchObject({
			kind: "unpublished",
			errors: 1,
			errorMessages: ["provider-unavailable"],
		});
		expect(state.rows).toEqual(priorRows);

		const malformedClient = historyClient([
			{
				row_id: 1,
				rating_key: "rk-1",
				media_type: "movie",
				user: "one",
				date: Math.floor(Date.now() / 1000),
			},
			{
				row_id: 1,
				rating_key: "rk-1",
				media_type: "movie",
				user: "two",
				date: Math.floor(Date.now() / 1000),
			},
		]);
		await expect(refresh(state, malformedClient)).resolves.toMatchObject({
			kind: "unpublished",
			errors: 1,
			errorMessages: ["rows-inconsistent"],
		});
		expect(state.rows).toEqual(priorRows);
	});

	it("encodes metadata before replacing rows and preserves the prior publication when encoding fails", async () => {
		const state = createState();
		const priorRows = [{ tmdbId: 456 }];
		state.rows.push(...priorRows);
		const priorMetadata = state.status.generationMetadata;
		metadataControl.encodeFailure = true;

		const result = await refresh(state, historyClient(positiveRows(1)));

		expect(result).toMatchObject({
			kind: "unpublished",
			errors: 1,
			errorMessages: ["provider-unavailable"],
		});
		expect(state.tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
		expect(state.rows).toEqual(priorRows);
		expect(state.status.generationMetadata).toBe(priorMetadata);
	});

	it("rolls back row replacement when a transaction write fails", async () => {
		const state = createState();
		const priorRows = [{ tmdbId: 789 }];
		state.rows.push(...priorRows);
		state.tx.tautulliCache.deleteMany.mockRejectedValueOnce(new Error("database secret"));

		const result = await refresh(state, historyClient(positiveRows(1)));

		expect(result).toMatchObject({
			kind: "unpublished",
			errors: 1,
			errorMessages: ["provider-unavailable"],
		});
		expect(state.rows).toEqual(priorRows);
	});

	it("rolls back rows when the exact success CAS loses to a newer attempt", async () => {
		const state = createState();
		const priorRows = [{ tmdbId: 987 }];
		state.rows.push(...priorRows);
		state.tx.cacheRefreshStatus.updateMany.mockResolvedValueOnce({ count: 0 });

		const result = await refresh(state, historyClient(positiveRows(1)));

		expect(result).toEqual({
			kind: "unpublished",
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: ["publication-superseded"],
			superseded: true,
		});
		expect(state.rows).toEqual(priorRows);
		expect(state.status.generationMetadata).toBe("prior-metadata");
	});
});
