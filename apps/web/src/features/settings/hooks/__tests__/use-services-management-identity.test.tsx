import type { ServiceInstanceSummary } from "@arr/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../lib/api-client/base";

const { inspectServiceIdentity, replaceMutate, updateMutate, verifyMutate } = vi.hoisted(() => ({
	inspectServiceIdentity: vi.fn(),
	replaceMutate: vi.fn(),
	updateMutate: vi.fn(),
	verifyMutate: vi.fn(),
}));
const mutation = (mutateAsync = vi.fn()) => ({ mutateAsync, isPending: false });

vi.mock("../../../../hooks/api/useServiceMutations", () => ({
	useCreateServiceMutation: () => mutation(),
	useDeleteServiceMutation: () => mutation(),
	useTestConnectionBeforeAdd: () => mutation(),
	useTestServiceConnection: () => mutation(),
	useUpdateServiceMutation: () => mutation(updateMutate),
	useReplaceServiceIdentityMutation: () => mutation(replaceMutate),
	useVerifyServiceIdentityMutation: () => mutation(verifyMutate),
}));
vi.mock("../../../../lib/api-client/services", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../lib/api-client/services")>()),
	inspectServiceIdentity,
}));

import { useServicesManagement } from "../use-services-management";

const service: ServiceInstanceSummary = {
	id: "plex-1",
	service: "plex",
	label: "Living Room",
	baseUrl: "http://plex.test",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-08-14T00:00:00.000Z",
	updatedAt: "2026-08-14T00:00:00.000Z",
	tags: [],
};
const candidate = {
	service: "PLEX" as const,
	identityKind: "plex-machine-identifier",
	fingerprint: "7a9c6d3e1f20",
	confirmationDigest: "a".repeat(64),
};

describe("useServicesManagement identity conflicts", () => {
	it("confirms an unavailable Tautulli provider before retrying direct identity replacement", async () => {
		const tautulli = {
			...service,
			id: "tautulli-1",
			service: "tautulli" as const,
			identity: { ...service.identity, status: "mismatch" as const },
		};
		inspectServiceIdentity.mockResolvedValue({
			candidate,
			connectionGeneration: 4,
			identityGeneration: 2,
		});
		replaceMutate
			.mockRejectedValueOnce(
				new ApiError("analytics confirmation required", 409, {
					code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
					selected: "tautulli",
					alternativeEnabled: false,
				}),
			)
			.mockResolvedValueOnce({
				...tautulli,
				identity: { ...tautulli.identity, status: "verified" as const },
			});
		const { result } = renderHook(() => useServicesManagement());

		await act(async () => {
			await result.current.inspectIdentity(tautulli);
		});
		await act(async () => {
			await result.current.confirmIdentity();
		});

		await waitFor(() =>
			expect(result.current.analyticsUnavailableConfirmation?.selected).toBe("tautulli"),
		);
		await act(async () => {
			await result.current.analyticsUnavailableConfirmation?.onConfirm();
		});

		expect(replaceMutate).toHaveBeenLastCalledWith({
			id: "tautulli-1",
			payload: expect.not.objectContaining({ confirmAnalyticsUnavailableFor: expect.anything() }),
			confirmAnalyticsUnavailableFor: "tautulli",
			confirmationDigest: candidate.confirmationDigest,
			expectedConnectionGeneration: 4,
			expectedIdentityGeneration: 2,
		});
		expect(result.current.identityFlow).toBeNull();
	});

	it("retains analytics confirmation when an enabled Tautulli update proceeds to identity replacement", async () => {
		const tautulli = { ...service, id: "tautulli-1", service: "tautulli" as const };
		const stagedForm = {
			label: "Replacement Tautulli",
			baseUrl: "http://replacement-tautulli.test",
			externalUrl: "",
			apiKey: "replacement-api-key",
			service: "tautulli" as const,
			enabled: true,
			isDefault: false,
			tags: "",
			storageGroupId: "",
			httpAuthEnabled: false,
			httpAuthUsername: "",
			httpAuthPassword: "",
			hasLocalFilesystemAccess: false,
			pathPrefix: "",
		};
		updateMutate
			.mockRejectedValueOnce(
				new ApiError("analytics confirmation required", 409, {
					code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
					selected: "tautulli",
					alternativeEnabled: false,
				}),
			)
			.mockRejectedValueOnce(
				new ApiError("replacement required", 409, {
					details: {
						code: "IDENTITY_REPLACEMENT_REQUIRED",
						candidate,
						connectionGeneration: 4,
						identityGeneration: 2,
					},
				}),
			);
		replaceMutate.mockResolvedValue({
			...tautulli,
			identity: { ...tautulli.identity, status: "verified" },
		});
		const { result } = renderHook(() => useServicesManagement());

		await act(async () => {
			await result.current.handleSubmit(stagedForm, tautulli, vi.fn());
		});
		await act(async () => {
			await result.current.analyticsUnavailableConfirmation?.onConfirm();
		});

		await waitFor(() => expect(result.current.identityFlow?.mode).toBe("replace"));
		await act(async () => {
			await result.current.confirmIdentity();
		});
		expect(replaceMutate).toHaveBeenCalledWith({
			id: "tautulli-1",
			payload: expect.not.objectContaining({ confirmAnalyticsUnavailableFor: expect.anything() }),
			confirmAnalyticsUnavailableFor: "tautulli",
			confirmationDigest: candidate.confirmationDigest,
			expectedConnectionGeneration: 4,
			expectedIdentityGeneration: 2,
		});
	});

	it("turns a verify replacement conflict into an explicit replacement flow", async () => {
		inspectServiceIdentity.mockResolvedValue({
			candidate,
			connectionGeneration: 4,
			identityGeneration: 2,
		});
		verifyMutate.mockRejectedValue(
			new ApiError("replacement required", 409, {
				details: {
					code: "IDENTITY_REPLACEMENT_REQUIRED",
					candidate,
					connectionGeneration: 4,
					identityGeneration: 2,
				},
			}),
		);
		const { result } = renderHook(() => useServicesManagement());

		await act(async () => {
			await result.current.inspectIdentity(service);
		});
		await act(async () => {
			await result.current.confirmIdentity();
		});

		await waitFor(() => expect(result.current.identityFlow?.mode).toBe("replace"));
		expect(result.current.identityFlow?.requiresReinspection).toBe(false);
	});

	it("blocks a stale confirmation until a fresh inspection replaces its candidate", async () => {
		inspectServiceIdentity.mockResolvedValueOnce({
			candidate,
			connectionGeneration: 4,
			identityGeneration: 2,
		});
		verifyMutate.mockRejectedValueOnce(
			new ApiError("stale", 409, {
				details: {
					code: "IDENTITY_GENERATION_STALE",
					connectionGeneration: 5,
					identityGeneration: 2,
				},
			}),
		);
		const { result } = renderHook(() => useServicesManagement());

		await act(async () => {
			await result.current.inspectIdentity(service);
		});
		await act(async () => {
			await result.current.confirmIdentity();
		});
		await waitFor(() => expect(result.current.identityFlow?.requiresReinspection).toBe(true));

		const freshCandidate = {
			...candidate,
			fingerprint: "111111111111",
			confirmationDigest: "b".repeat(64),
		};
		inspectServiceIdentity.mockResolvedValueOnce({
			candidate: freshCandidate,
			connectionGeneration: 5,
			identityGeneration: 2,
		});
		await act(async () => {
			await result.current.inspectIdentity(service);
		});
		expect(result.current.identityFlow).toMatchObject({
			candidate: freshCandidate,
			requiresReinspection: false,
		});
	});

	it.each(["IDENTITY_CANDIDATE_CHANGED", "IDENTITY_GENERATION_STALE"] as const)(
		"reinspects a %s replacement using its staged connection",
		async (code) => {
			const stagedConnection = {
				label: "Replacement Plex",
				baseUrl: "http://replacement-plex.test",
				externalUrl: null,
				apiKey: "replacement-api-key",
				httpAuth: undefined,
				service: "plex" as const,
				enabled: true,
				isDefault: false,
				tags: [],
				storageGroupId: null,
			};
			const stagedForm = {
				label: "Replacement Plex",
				baseUrl: "http://replacement-plex.test",
				externalUrl: "",
				apiKey: "replacement-api-key",
				service: "plex" as const,
				enabled: true,
				isDefault: false,
				tags: "",
				storageGroupId: "",
				httpAuthEnabled: false,
				httpAuthUsername: "",
				httpAuthPassword: "",
				hasLocalFilesystemAccess: false,
				pathPrefix: "",
			};
			updateMutate.mockRejectedValueOnce(
				new ApiError("replacement required", 409, {
					details: {
						code: "IDENTITY_REPLACEMENT_REQUIRED",
						candidate,
						connectionGeneration: 4,
						identityGeneration: 2,
					},
				}),
			);
			replaceMutate.mockRejectedValueOnce(
				new ApiError("stale replacement", 409, {
					details: {
						code,
						connectionGeneration: 5,
						identityGeneration: 2,
					},
				}),
			);
			inspectServiceIdentity.mockResolvedValueOnce({
				candidate,
				connectionGeneration: 5,
				identityGeneration: 2,
			});
			const { result } = renderHook(() => useServicesManagement());

			await act(async () => {
				await result.current.handleSubmit(stagedForm, service, vi.fn());
			});
			await act(async () => {
				await result.current.confirmIdentity();
			});
			await waitFor(() => expect(result.current.identityFlow?.requiresReinspection).toBe(true));

			await act(async () => {
				await result.current.inspectIdentity(service);
			});

			expect(inspectServiceIdentity).toHaveBeenLastCalledWith(service.id, stagedConnection);
		},
	);
});
