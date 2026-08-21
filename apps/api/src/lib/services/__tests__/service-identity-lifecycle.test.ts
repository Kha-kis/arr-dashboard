import { describe, expect, it } from "vitest";
import {
	createSanitizedProviderEvidence,
	serializeExecutableSafetyPlan,
} from "../../library-cleanup/shared-plex-safety.js";
import {
	createProviderReplacementAuthority,
	expireApprovalsForProviderReplacement,
	verifiedIdentityData,
} from "../service-identity-lifecycle.js";

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

describe("verifiedIdentityData", () => {
	const observation = {
		service: "PLEX" as const,
		identityKind: "plex-machine-identifier" as const,
		rawIdentity: "plex-machine-a",
		confirmationDigest: "digest",
		fingerprint: "fingerprint",
	};

	it("restores a temporarily mismatched enrolled identity without advancing its generation", () => {
		const now = new Date("2026-08-20T12:00:00.000Z");

		const restored = verifiedIdentityData(
			{
				service: "PLEX",
				expectedIdentity: "plex-machine-a",
				identityStatus: "MISMATCH",
				identityGeneration: 7,
			},
			observation,
			now,
		);

		expect(restored).toMatchObject({
			expectedIdentity: "plex-machine-a",
			identityStatus: "VERIFIED",
			identityGeneration: 7,
			identityVerifiedAt: now,
		});
	});

	it("advances the generation for a different observed identity after mismatch", () => {
		const replacement = verifiedIdentityData(
			{
				service: "PLEX",
				expectedIdentity: "plex-machine-b",
				identityStatus: "MISMATCH",
				identityGeneration: 7,
			},
			observation,
		);

		expect(replacement.identityGeneration).toBe(8);
	});

	it.each([
		["Tautulli after mismatch", "TAUTULLI", "tautulli-pms-identifier", "MISMATCH"],
		["Tautulli after unverified", "TAUTULLI", "tautulli-pms-identifier", "UNVERIFIED"],
		["Jellyfin after mismatch", "JELLYFIN", "jellyfin-server-id", "MISMATCH"],
		["Jellyfin after unverified", "JELLYFIN", "jellyfin-server-id", "UNVERIFIED"],
		["Emby after mismatch", "EMBY", "emby-server-id", "MISMATCH"],
		["Emby after unverified", "EMBY", "emby-server-id", "UNVERIFIED"],
	] as const)(
		"advances the %s generation when the same identity is verified",
		(_label, service, identityKind, identityStatus) => {
			const verified = verifiedIdentityData(
				{
					service,
					expectedIdentity: "same-enrolled-identity",
					identityStatus,
					identityGeneration: 7,
				},
				{
					service,
					identityKind,
					rawIdentity: "same-enrolled-identity",
					confirmationDigest: "digest",
					fingerprint: "fingerprint",
				},
			);

			expect(verified.identityGeneration).toBe(8);
		},
	);

	it.each([
		["Plex", "PLEX", "plex-machine-identifier"],
		["Tautulli", "TAUTULLI", "tautulli-pms-identifier"],
		["Jellyfin", "JELLYFIN", "jellyfin-server-id"],
		["Emby", "EMBY", "emby-server-id"],
	] as const)(
		"preserves the %s generation for an already-verified same identity",
		(_label, service, identityKind) => {
			const verified = verifiedIdentityData(
				{
					service,
					expectedIdentity: "same-enrolled-identity",
					identityStatus: "VERIFIED",
					identityGeneration: 7,
				},
				{
					service,
					identityKind,
					rawIdentity: "same-enrolled-identity",
					confirmationDigest: "digest",
					fingerprint: "fingerprint",
				},
			);

			expect(verified.identityGeneration).toBe(7);
		},
	);
});

describe("expireApprovalsForProviderReplacement", () => {
	it("expires only v2 approvals whose provider evidence matches the replaced authority", async () => {
		const snapshot = (
			sources: Array<{
				service: "PLEX" | "JELLYFIN" | "EMBY" | "TAUTULLI";
				instanceFingerprint?: string;
				identityKind: string;
				identityFingerprint: string;
				connectionGeneration: number;
				identityGeneration: number;
			}>,
		) =>
			serializeExecutableSafetyPlan(
				{
					kind: "verified_arr_target",
					target: {
						serviceFingerprint: "a".repeat(64),
						externalId: 42,
						mediaPath: { value: "/movies/Example", windows: false },
					},
				},
				createSanitizedProviderEvidence(
					sources.map((source) => source.service.toLowerCase()),
					sources.map((source, index) => ({
						...source,
						cacheType: source.service === "TAUTULLI" ? "tautulli" : "plex",
						completedAt: "2026-08-15T04:00:00.000Z",
						itemCount: 1,
						verifiedAt: "2026-08-15T03:00:00.000Z",
						statusFingerprint: `${index + 3}`.repeat(64),
						rowFingerprint: `${index + 5}`.repeat(64),
					})),
				),
			);
		const authority = createProviderReplacementAuthority({
			id: "provider-1",
			service: "PLEX",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			expectedIdentity: "provider-identity",
			connectionGeneration: 4,
			identityGeneration: 7,
		});
		if (!authority) throw new Error("Expected provider replacement authority");
		const matchingSource = {
			service: "PLEX" as const,
			instanceFingerprint: authority.instanceFingerprint,
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityFingerprint: authority.identityFingerprint,
			connectionGeneration: 4,
			identityGeneration: 7,
		};
		const rows = [
			{ id: "untagged", status: "pending", safetySnapshot: null },
			{ id: "matching", status: "approved", safetySnapshot: snapshot([matchingSource]) },
			{
				id: "unrelated-provider",
				status: "pending",
				safetySnapshot: snapshot([
					{
						...matchingSource,
						service: "TAUTULLI",
						identityKind: "TAUTULLI_PMS_IDENTIFIER",
					},
				]),
			},
			{
				id: "different-identity",
				status: "pending",
				safetySnapshot: snapshot([{ ...matchingSource, identityFingerprint: "c".repeat(64) }]),
			},
			{
				id: "different-identity-kind",
				status: "pending",
				safetySnapshot: snapshot([{ ...matchingSource, identityKind: "JELLYFIN_SERVER_ID" }]),
			},
			{
				id: "same-provider-other-instance",
				status: "pending",
				safetySnapshot: snapshot([
					{
						...matchingSource,
						instanceFingerprint: "e".repeat(64),
					},
				]),
			},
			{
				id: "different-generation",
				status: "pending",
				safetySnapshot: snapshot([{ ...matchingSource, connectionGeneration: 5 }]),
			},
			{ id: "arr-only", status: "pending", safetySnapshot: snapshot([]) },
			{
				id: "legacy-v2-same-provider",
				status: "pending",
				safetySnapshot: snapshot([
					(({ instanceFingerprint: _instanceFingerprint, ...source }) => source)(matchingSource),
				]),
			},
			{ id: "legacy", status: "pending", safetySnapshot: JSON.stringify({ providerEvidence: [] }) },
			{ id: "malformed", status: "pending", safetySnapshot: "not-json" },
		];

		await expireApprovalsForProviderReplacement(approvalStore(rows) as never, "user-1", authority);

		expect(rows).toMatchObject([
			{ id: "untagged", status: "expired" },
			{ id: "matching", status: "expired" },
			{ id: "unrelated-provider", status: "pending" },
			{ id: "different-identity", status: "pending" },
			{ id: "different-identity-kind", status: "pending" },
			{ id: "same-provider-other-instance", status: "pending" },
			{ id: "different-generation", status: "pending" },
			{ id: "arr-only", status: "pending" },
			{ id: "legacy-v2-same-provider", status: "expired" },
			{ id: "legacy", status: "expired" },
			{ id: "malformed", status: "expired" },
		]);
	});
});
