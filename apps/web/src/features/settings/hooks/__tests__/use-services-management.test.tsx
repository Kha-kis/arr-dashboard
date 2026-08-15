import type { ServiceInstanceSummary } from "@arr/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../lib/api-client/base";
import { toast } from "sonner";

const mocks = vi.hoisted(() => ({
	deleteMutateAsync: vi.fn(),
	updateMutateAsync: vi.fn(),
}));

vi.mock("../../../../hooks/api/useServiceMutations", () => ({
	useCreateServiceMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteServiceMutation: () => ({ mutateAsync: mocks.deleteMutateAsync, isPending: false }),
	useTestConnectionBeforeAdd: () => ({ mutateAsync: vi.fn() }),
	useTestServiceConnection: () => ({ mutateAsync: vi.fn() }),
	useUpdateServiceMutation: () => ({ mutateAsync: mocks.updateMutateAsync, isPending: false }),
	useReplaceServiceIdentityMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useVerifyServiceIdentityMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { useServicesManagement } from "../use-services-management";

const tracearrService = {
	id: "tracearr-1",
	service: "tracearr",
	label: "private Tracearr instance",
	baseUrl: "https://private.example.test",
	enabled: true,
	isDefault: false,
} as ServiceInstanceSummary;

describe("useServicesManagement analytics lifecycle confirmation", () => {
	beforeEach(() => {
		mocks.deleteMutateAsync.mockReset();
		mocks.updateMutateAsync.mockReset();
	});

	it("retries the exact blocked deletion once only after provider-family confirmation", async () => {
		mocks.deleteMutateAsync
			.mockRejectedValueOnce(
				new ApiError("Confirmation required", 409, {
					code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
					selected: "tracearr",
					alternativeEnabled: true,
				}),
			)
			.mockResolvedValueOnce(undefined);
		const { result } = renderHook(() => useServicesManagement());

		await act(async () => {
			await result.current.handleDeleteService(tracearrService, null, vi.fn());
		});
		await waitFor(() => expect(result.current.analyticsUnavailableConfirmation).not.toBeNull());
		expect(result.current.analyticsUnavailableConfirmation).toMatchObject({
			selected: "tracearr",
			alternativeEnabled: true,
		});

		await act(async () => {
			await result.current.analyticsUnavailableConfirmation?.onConfirm();
		});
		expect(mocks.deleteMutateAsync).toHaveBeenNthCalledWith(1, "tracearr-1");
		expect(mocks.deleteMutateAsync).toHaveBeenNthCalledWith(2, {
			id: "tracearr-1",
			confirmAnalyticsUnavailableFor: "tracearr",
		});
		expect(result.current.analyticsUnavailableConfirmation).toBeNull();
	});

	it("retries the exact enabled-state update once only after provider-family confirmation", async () => {
		mocks.updateMutateAsync
			.mockRejectedValueOnce(
				new ApiError("Confirmation required", 409, {
					code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
					selected: "tracearr",
					alternativeEnabled: false,
				}),
			)
			.mockResolvedValueOnce({ ...tracearrService, enabled: false });
		const { result } = renderHook(() => useServicesManagement());

		await act(async () => {
			await result.current.toggleEnabled(tracearrService);
		});
		await waitFor(() => expect(result.current.analyticsUnavailableConfirmation).not.toBeNull());

		await act(async () => {
			await result.current.analyticsUnavailableConfirmation?.onConfirm();
		});
		expect(mocks.updateMutateAsync).toHaveBeenNthCalledWith(1, {
			id: "tracearr-1",
			payload: { enabled: false },
		});
		expect(mocks.updateMutateAsync).toHaveBeenNthCalledWith(2, {
			id: "tracearr-1",
			payload: { enabled: false, confirmAnalyticsUnavailableFor: "tracearr" },
		});
	});

	it("keeps malformed lifecycle conflicts on the existing generic error path", async () => {
		mocks.deleteMutateAsync.mockRejectedValueOnce(
			new ApiError("Unexpected conflict", 409, {
				code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
				selected: "tracearr",
				alternativeEnabled: "yes",
			}),
		);
		const { result } = renderHook(() => useServicesManagement());

		await act(async () => {
			await result.current.handleDeleteService(tracearrService, null, vi.fn());
		});
		expect(result.current.analyticsUnavailableConfirmation).toBeNull();
		expect(toast.error).toHaveBeenCalledWith("Unexpected conflict");
	});
});
