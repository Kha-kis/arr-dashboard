import { describe, expect, it } from "vitest";
import { expireApprovalsForProviderReplacement } from "../service-identity-lifecycle.js";

function approvalStore(rows: Array<Record<string, unknown>>) {
	return {
		libraryCleanupApproval: {
			findMany: async () => rows,
			updateMany: async ({
				where,
				data,
			}: {
				where: { id: string; status: string };
				data: Record<string, unknown>;
			}) => {
				const approval = rows.find((row) => row.id === where.id && row.status === where.status);
				if (!approval) return { count: 0 };
				Object.assign(approval, data);
				return { count: 1 };
			},
		},
	};
}

describe("expireApprovalsForProviderReplacement", () => {
	it("expires untagged approvals and only provenance that references the exact replaced generations", async () => {
		const rows = [
			{ id: "untagged", status: "pending", safetySnapshot: null },
			{
				id: "matching",
				status: "approved",
				safetySnapshot: JSON.stringify({
					providerEvidence: [
						{ instanceId: "provider-1", connectionGeneration: 4, identityGeneration: 7 },
					],
				}),
			},
			{
				id: "different-connection",
				status: "pending",
				safetySnapshot: JSON.stringify({
					providerEvidence: [
						{ instanceId: "provider-1", connectionGeneration: 5, identityGeneration: 7 },
					],
				}),
			},
		];

		await expireApprovalsForProviderReplacement(
			approvalStore(rows) as never,
			"user-1",
			"provider-1",
			4,
			7,
		);

		expect(rows).toMatchObject([
			{ id: "untagged", status: "expired" },
			{ id: "matching", status: "expired" },
			{ id: "different-connection", status: "pending" },
		]);
	});
});
