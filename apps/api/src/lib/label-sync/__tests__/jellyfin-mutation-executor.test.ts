import { beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceFingerprint } from "../../evidence-fingerprint.js";

const fakes = vi.hoisted(() => ({
	admitted: true,
	readCatalog: vi.fn(),
	readLiveInventory: vi.fn(),
	readNativePage: vi.fn(),
	createClient: vi.fn(),
	readTarget: vi.fn(),
	addTargetTag: vi.fn(),
	claim: vi.fn(),
	markSending: vi.fn(),
	completePreSend: vi.fn(),
	completeSend: vi.fn(),
	acquireReconciliation: vi.fn(),
	completeReconciliation: vi.fn(),
}));

vi.mock("../../jellyfin/jellyfin-native-inventory.js", () => ({
	collectJellyfinNativeLibraryInventory: fakes.readLiveInventory,
}));

vi.mock("../mutation-admission.js", () => ({
	isLabelSyncMutationAdmitted: () => fakes.admitted,
}));
vi.mock("../../jellyfin/jellyfin-client.js", () => ({
	createJellyfinClient: fakes.createClient,
}));
vi.mock("../../provider-observation/inventory-connection-repository.js", () => ({
	readCompleteNativeLibrary: fakes.readCatalog,
}));
vi.mock("../../provider-observation/native-inventory.js", () => ({
	readNativeInventoryPage: fakes.readNativePage,
}));
vi.mock("../jellyfin-mutation-repository.js", () => ({
	createJellyfinMutationRepository: () => ({
		claimPhysicalTarget: fakes.claim,
		markSending: fakes.markSending,
		completePreSend: fakes.completePreSend,
		completeSend: fakes.completeSend,
		acquireReconciliation: fakes.acquireReconciliation,
		completeReconciliation: fakes.completeReconciliation,
	}),
}));

import {
	executeJellyfinMutations,
	reconcileJellyfinMutationAttempts,
} from "../jellyfin-mutation-executor.js";

const rule = {
	id: "rule-1",
	userId: "user-1",
	enabled: true,
	sourceService: "plex",
	sourceInstanceId: "source-1",
	sourceTagName: "source",
	destService: "jellyfin",
	destInstanceId: "dest-1",
	destTagName: "destination",
};
const authority = {
	id: "dest-1",
	userId: "user-1",
	service: "JELLYFIN",
	enabled: true,
	expectedIdentity: "server-1",
	identityStatus: "VERIFIED",
	connectionGeneration: 3,
	identityGeneration: 4,
	encryptedApiKey: "cipher",
	encryptionIv: "iv",
	baseUrl: "http://jellyfin.invalid",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
};
const catalog = {
	generationId: "generation-1",
	freshness: "current" as const,
	complete: true,
	itemCount: 1,
	rows: [
		{
			nativeId: "item-1",
			mediaType: "movie" as const,
			libraryIds: ["library-1"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "opaque",
			externalIds: { tmdb: [42] },
		},
	],
	instanceId: "dest-1",
};
const snapshot = (tags: string[]) => ({
	serverId: "server-1",
	itemId: "item-1",
	mediaType: "movie" as const,
	tmdbId: 42,
	tags,
	ancestorIds: ["library-1"],
});
const ruleFingerprint = evidenceFingerprint({
	id: rule.id,
	userId: rule.userId,
	sourceService: rule.sourceService,
	sourceInstanceId: rule.sourceInstanceId,
	sourceTagName: rule.sourceTagName,
	destService: rule.destService,
	destInstanceId: rule.destInstanceId,
	destTagName: rule.destTagName,
});
const prisma = {
	serviceInstance: { findFirst: vi.fn() },
	labelSyncMutationAttempt: { findMany: vi.fn() },
	labelSyncRule: { findFirst: vi.fn() },
};
const encryptor = {} as never;
const log = {} as never;

beforeEach(() => {
	vi.resetAllMocks();
	fakes.admitted = true;
	fakes.readCatalog.mockResolvedValue(catalog);
	fakes.readLiveInventory.mockResolvedValue({
		complete: true,
		snapshots: [{ rows: catalog.rows }],
	});
	fakes.readNativePage.mockResolvedValue({
		status: "available",
		generationId: "generation-1",
		freshness: "current",
		complete: true,
	});
	fakes.createClient.mockReturnValue({
		readMutationTarget: fakes.readTarget,
		addMutationTargetTag: fakes.addTargetTag,
	});
	fakes.readTarget
		.mockResolvedValueOnce(snapshot([]))
		.mockResolvedValueOnce(snapshot([]))
		.mockResolvedValueOnce(snapshot(["destination"]));
	fakes.addTargetTag.mockResolvedValue("sent");
	fakes.claim.mockResolvedValue({
		kind: "acquired",
		id: "attempt-1",
		claimToken: "token-1",
		activeOperationKey: "key-1",
	});
	fakes.markSending.mockResolvedValue({ kind: "applied", status: "sending", sendAttemptCount: 1 });
	fakes.completePreSend.mockResolvedValue({ kind: "applied", status: "noop" });
	fakes.completeSend.mockResolvedValue({ kind: "applied", status: "verified" });
	fakes.completeReconciliation.mockResolvedValue({ kind: "applied", status: "verified" });
	prisma.serviceInstance.findFirst.mockResolvedValue(authority);
	prisma.labelSyncRule.findFirst.mockResolvedValue(rule);
});

describe("executeJellyfinMutations", () => {
	it("claims, revalidates, sends one full DTO update, then verifies the readback", async () => {
		const result = await executeJellyfinMutations({
			rule,
			destInstance: authority as never,
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "opaque" }],
			prisma: prisma as never,
			encryptor,
			log,
		});

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 1, failures: 0 });
		expect(fakes.claim).toHaveBeenCalledWith(
			expect.objectContaining({ targetItemId: "item-1", libraryId: "library-1" }),
			"server-1",
		);
		expect(fakes.markSending).toHaveBeenCalledTimes(1);
		expect(fakes.addTargetTag).toHaveBeenCalledWith(
			expect.objectContaining({ itemId: "item-1" }),
			"destination",
		);
		expect(fakes.readTarget).toHaveBeenCalledTimes(3);
		expect(fakes.completeSend).toHaveBeenCalledWith(
			expect.objectContaining({ status: "verified" }),
		);
	});

	it("fails closed on a live target identity change without sending", async () => {
		fakes.readTarget.mockReset();
		fakes.readTarget.mockResolvedValue(snapshot([]));
		fakes.createClient.mockReturnValue({
			readMutationTarget: vi.fn().mockResolvedValue({ ...snapshot([]), tmdbId: 99 }),
			addMutationTargetTag: fakes.addTargetTag,
		});
		const result = await executeJellyfinMutations({
			rule,
			destInstance: authority as never,
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "opaque" }],
			prisma: prisma as never,
			encryptor,
			log,
		});
		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(fakes.addTargetTag).not.toHaveBeenCalled();
		expect(fakes.completePreSend).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "blocked",
				reasonCode: "target_changed",
			}),
		);
	});

	it("does not contact Jellyfin when admission is closed", async () => {
		fakes.admitted = false;
		const result = await executeJellyfinMutations({
			rule,
			destInstance: authority as never,
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "opaque" }],
			prisma: prisma as never,
			encryptor,
			log,
		});
		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 1 });
		expect(fakes.readCatalog).not.toHaveBeenCalled();
		expect(fakes.createClient).not.toHaveBeenCalled();
	});

	it("keeps a send unknown when an immediate readback does not yet show the tag", async () => {
		fakes.readTarget.mockReset();
		fakes.readTarget.mockResolvedValueOnce(snapshot([])).mockResolvedValueOnce(snapshot([]));
		const result = await executeJellyfinMutations({
			rule,
			destInstance: authority as never,
			candidates: [{ tmdbId: 42, mediaType: "movie", title: "opaque" }],
			prisma: prisma as never,
			encryptor,
			log,
		});
		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(fakes.addTargetTag).toHaveBeenCalledTimes(1);
		expect(fakes.completeSend).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown" }));
	});
});

describe("reconcileJellyfinMutationAttempts", () => {
	it.each([
		["present and committed", true, "applied", 1],
		["absent after an uncertain send", false, "applied", 0],
		["present but the ledger transition was superseded", true, "superseded", 0],
	] as const)("reconciles %s without resending", async (_case, present, transition, verified) => {
		prisma.labelSyncMutationAttempt.findMany.mockResolvedValue([
			{
				id: "attempt-1",
				userId: "user-1",
				ruleId: "rule-1",
				destinationInstanceId: "dest-1",
				activeOperationKey: "key-1",
				mediaType: "movie",
				tmdbId: 42,
				connectionGeneration: 3,
				identityGeneration: 4,
				targetItemId: "item-1",
				libraryId: "library-1",
				ruleFingerprint,
				destinationTag: "destination",
			},
		]);
		prisma.labelSyncRule.findFirst.mockResolvedValue(rule);
		fakes.acquireReconciliation.mockResolvedValue({
			kind: "acquired",
			id: "attempt-1",
			claimToken: "reconcile-token",
			reconcileAttemptCount: 1,
			snapshot: {
				id: "attempt-1",
				userId: "user-1",
				ruleId: "rule-1",
				destinationInstanceId: "dest-1",
				activeOperationKey: "key-1",
				mediaType: "movie",
				tmdbId: 42,
				connectionGeneration: 3,
				identityGeneration: 4,
				targetItemId: "item-1",
				libraryId: "library-1",
				ruleFingerprint,
				destinationTag: "destination",
			},
		});
		fakes.readTarget.mockReset();
		fakes.readTarget.mockResolvedValue(snapshot(present ? ["destination"] : []));
		fakes.completeReconciliation.mockResolvedValue({ kind: transition });
		const result = await reconcileJellyfinMutationAttempts({
			prisma: prisma as never,
			encryptor,
			log,
		});
		expect(result).toEqual({ examined: 1, verified, failed: 0, unknown: 1 - verified });
		expect(fakes.addTargetTag).not.toHaveBeenCalled();
		expect(fakes.completeReconciliation).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: present
					? { status: "verified", reasonCode: "applied" }
					: { status: "unknown", reasonCode: "reconciliation_unavailable" },
			}),
		);
	});
});

const execute = () =>
	executeJellyfinMutations({
		rule,
		destInstance: authority as never,
		candidates: [{ tmdbId: 42, mediaType: "movie", title: "opaque" }],
		prisma: prisma as never,
		encryptor,
		log,
	});

describe("Jellyfin mutation failure boundaries", () => {
	it.each(["unknown", "already-active", "target-busy"])(
		"never sends when the durable claim is %s",
		async (kind) => {
			fakes.claim.mockResolvedValue({ kind });
			expect((await execute()).labelsApplied).toBe(0);
			expect(fakes.readTarget).not.toHaveBeenCalled();
			expect(fakes.addTargetTag).not.toHaveBeenCalled();
		},
	);
	it("blocks a rule edited between the first read and claim", async () => {
		prisma.labelSyncRule.findFirst
			.mockResolvedValueOnce(rule)
			.mockResolvedValueOnce({ ...rule, destTagName: "changed" });
		expect((await execute()).failures).toBe(1);
		expect(fakes.completePreSend).toHaveBeenCalledWith(
			expect.objectContaining({ reasonCode: "rule_changed" }),
		);
		expect(fakes.addTargetTag).not.toHaveBeenCalled();
	});
	it("blocks an ambiguous native match without claiming", async () => {
		fakes.readCatalog.mockResolvedValue({
			...catalog,
			itemCount: 2,
			rows: [...catalog.rows, { ...catalog.rows[0], nativeId: "duplicate" }],
		});
		expect((await execute()).failures).toBe(1);
		expect(fakes.claim).not.toHaveBeenCalled();
		expect(fakes.addTargetTag).not.toHaveBeenCalled();
	});
	it("blocks publication changes before the final live read", async () => {
		fakes.readNativePage.mockResolvedValue({ status: "unavailable", reason: "generation-changed" });
		expect((await execute()).failures).toBe(1);
		expect(fakes.readTarget).toHaveBeenCalledTimes(1);
		expect(fakes.addTargetTag).not.toHaveBeenCalled();
	});
	it("does not send after losing the sending CAS", async () => {
		fakes.markSending.mockResolvedValue({ kind: "superseded" });
		expect((await execute()).labelsApplied).toBe(0);
		expect(fakes.addTargetTag).not.toHaveBeenCalled();
	});
	it("never reports a verified write if persistence lost the CAS", async () => {
		fakes.completeSend.mockResolvedValue({ kind: "superseded" });
		expect(await execute()).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(fakes.addTargetTag).toHaveBeenCalledTimes(1);
	});
	it("reports failure when no-op evidence could not be committed", async () => {
		fakes.readTarget.mockReset().mockResolvedValue(snapshot(["destination"]));
		fakes.completePreSend.mockResolvedValue({ kind: "superseded" });
		expect((await execute()).failures).toBe(1);
		expect(fakes.addTargetTag).not.toHaveBeenCalled();
	});
	it("preserves an uncertain POST for reconciliation without retrying", async () => {
		fakes.addTargetTag.mockRejectedValue(new Error("timed out"));
		expect((await execute()).failures).toBe(1);
		expect(fakes.addTargetTag).toHaveBeenCalledTimes(1);
		expect(fakes.completeSend).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown" }));
	});
});

it("blocks a duplicate introduced upstream after the cached publication", async () => {
	fakes.readLiveInventory.mockResolvedValue({
		complete: true,
		snapshots: [{ rows: [...catalog.rows, { ...catalog.rows[0], nativeId: "new-duplicate" }] }],
	});
	expect(await execute()).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
	expect(fakes.addTargetTag).not.toHaveBeenCalled();
	expect(fakes.markSending).not.toHaveBeenCalled();
	expect(fakes.completePreSend).toHaveBeenCalledWith(
		expect.objectContaining({ status: "blocked", reasonCode: "target_changed" }),
	);
});
it("blocks an incomplete live uniqueness scan", async () => {
	fakes.readLiveInventory.mockResolvedValue({ complete: false, reason: "coverage-incomplete" });
	expect((await execute()).failures).toBe(1);
	expect(fakes.addTargetTag).not.toHaveBeenCalled();
});
