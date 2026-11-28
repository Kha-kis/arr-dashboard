import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
	subscribeProtectedUnauthorized,
} from "../../auth-session-signal";
import { UnauthorizedError } from "../base";
import { performManualSearch } from "../search";

const row = {
	id: "release",
	title: "Synthetic",
	indexer: "Indexer",
	indexerId: 7,
	protocol: "torrent",
	instanceId: "p-1",
	instanceName: "Prowlarr",
};
const coverage = {
	receivedCount: 2,
	acceptedCount: 1,
	rejectedCount: 1,
	metadataIncompleteCount: 0,
};
const envelope = {
	instances: [
		{ instanceId: "p-1", instanceName: "Prowlarr", success: true, data: [row], coverage },
	],
	aggregated: [row],
	totalCount: 1,
	failedInstanceCount: 0,
	coverage,
};
let body: unknown;
let status: number;
beforeEach(() => {
	body = envelope;
	status = 200;
	vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
		expect(path).toBe("/api/search/query");
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("include");
		expect(JSON.parse(String(init.body))).toEqual({
			query: "synthetic",
			type: "all",
			filters: [{ instanceId: "p-1", indexerIds: [7] }],
		});
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	});
});
afterEach(() => vi.unstubAllGlobals());
const search = () =>
	performManualSearch({
		query: "synthetic",
		type: "all",
		filters: [{ instanceId: "p-1", indexerIds: [7] }],
	});

describe("manual Search unknown response admission", () => {
	it("retains usable rows and validated coverage without arbitrary provider extras", async () => {
		body = { ...envelope, privateDiagnostic: "PRIVATE_PROVIDER_DETAIL" };
		const result = await search();
		expect(result.coverage).toEqual({
			receivedCount: 2,
			acceptedCount: 1,
			rejectedCount: 1,
			metadataIncompleteCount: 0,
		});
		expect(result.totalCount).toBe(1);
		expect(result).not.toHaveProperty("privateDiagnostic");
	});
	it("retains legacy usability without manufacturing complete coverage", async () => {
		body = {
			instances: [{ instanceId: "p-1", instanceName: "Prowlarr", success: true, data: [row] }],
			aggregated: [row],
			totalCount: 1,
			failedInstanceCount: 0,
		};
		expect(await search()).toMatchObject({ aggregated: [row], totalCount: 1 });
		expect(await search()).not.toHaveProperty("coverage");
	});
	it.each([
		{ ...envelope, totalCount: 2 },
		{ ...envelope, aggregated: [] },
		{ ...envelope, coverage: { ...coverage, receivedCount: 9 } },
		{ ...envelope, coverage: { ...coverage, metadataIncompleteCount: 1 } },
		{ ...envelope, instances: [] },
		{ ...envelope, aggregated: [{ ...row, indexerId: -1 }] },
		{
			...envelope,
			aggregated: [{ ...row, id: " " }],
			instances: [{ ...envelope.instances[0], data: [{ ...row, id: " " }] }],
		},
		{
			...envelope,
			aggregated: [{ ...row, guid: " " }],
			instances: [{ ...envelope.instances[0], data: [{ ...row, guid: " " }] }],
		},
		null,
		"PRIVATE_PROVIDER_BODY",
	])("fails generically on malformed or incoherent responses %#", async (malformed) => {
		body = malformed;
		await expect(search()).rejects.toThrow(
			"Unable to verify search results. Check Prowlarr and retry.",
		);
	});
	it("preserves base unauthorized status and signal rather than treating auth as malformed coverage", async () => {
		status = 401;
		body = { message: "PRIVATE_PROVIDER_DETAIL" };
		acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
		let notifiedRevision = 0;
		const unsubscribe = subscribeProtectedUnauthorized(() => {
			notifiedRevision = getPendingUnauthorizedRevision();
		});
		try {
			await expect(search()).rejects.toBeInstanceOf(UnauthorizedError);
			expect(notifiedRevision).toBeGreaterThan(0);
			expect(getPendingUnauthorizedRevision()).toBe(notifiedRevision);
		} finally {
			unsubscribe();
			acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
		}
	});
});
