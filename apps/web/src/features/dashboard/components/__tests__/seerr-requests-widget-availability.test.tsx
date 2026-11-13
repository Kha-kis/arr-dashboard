import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { NetworkError } from "../../../../lib/api-client/base";

const mocks = vi.hoisted(() => ({
	requests: vi.fn(),
	push: vi.fn(),
	count: vi.fn(),
	attention: vi.fn(),
	retry: vi.fn(),
	approve: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("../../../../hooks/api/useSeerr", () => ({
	useSeerrRequestCount: () => mocks.count(),
	useSeerrRequests: () => mocks.requests(),
	useSeerrAttention: () => mocks.attention(),
	useRetrySeerrRequest: () => ({ mutate: mocks.retry }),
	useApproveSeerrRequest: () => ({ mutate: mocks.approve }),
}));

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import { SeerrRequestsWidget } from "../seerr-requests-widget";

const request = {
	id: 1,
	status: 1,
	createdAt: "2024-01-01",
	updatedAt: "2024-01-01",
	type: "movie",
	media: { id: 1, tmdbId: 123, title: "Synthetic Item", status: 1, mediaType: "movie" },
	requestedBy: { id: 1, displayName: "Synthetic User" },
	seasons: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.count.mockReturnValue({
		data: {
			total: 2,
			pending: 0,
			processing: 0,
			approved: 0,
			declined: 0,
			movie: 0,
			tv: 0,
			available: 0,
		},
		isError: false,
	});
	mocks.requests.mockReturnValue({ data: undefined });
	mocks.attention.mockReturnValue({ data: undefined, isError: true });
});

function renderWidget() {
	return render(
		<IncognitoProvider>
			<SeerrRequestsWidget instanceId="seerr-1" />
		</IncognitoProvider>,
	);
}

describe("SeerrRequestsWidget attention availability", () => {
	it("shows an unavailable state when the attention read fails separately from counts", () => {
		renderWidget();
		expect(screen.getByText("Attention status unavailable")).toBeInTheDocument();
		expect(screen.queryByText(/Needs Attention/)).not.toBeInTheDocument();
	});

	it("warns on an unknown quick-approve outcome", () => {
		mocks.count.mockReturnValue({
			data: {
				total: 2,
				pending: 1,
				processing: 0,
				approved: 0,
				declined: 0,
				movie: 0,
				tv: 0,
				available: 0,
			},
			isError: false,
		});
		mocks.requests.mockReturnValue({ data: { results: [request] } });
		renderWidget();
		fireEvent.click(screen.getByRole("button", { name: /Approve request for Synthetic Item/ }));
		const callback = mocks.approve.mock.calls[0]?.[1];
		act(() => callback.onError(new NetworkError()));
		expect(toast.warning).toHaveBeenCalledWith("Outcome unknown. Check Seerr before retrying.");
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("warns on an unknown retry outcome", () => {
		mocks.attention.mockReturnValue({
			data: { items: [{ request, reason: "failed", ageMs: 1000 }], total: 1 },
			isError: false,
		});
		renderWidget();
		fireEvent.click(screen.getByRole("button", { name: /Retry request for Synthetic Item/ }));
		const callback = mocks.retry.mock.calls[0]?.[1];
		act(() => callback.onError(new NetworkError()));
		expect(toast.warning).toHaveBeenCalledWith("Outcome unknown. Check Seerr before retrying.");
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("SeerrRequestsWidget keyboard navigation", () => {
	it("navigates with Enter when the widget link itself has focus", () => {
		renderWidget();
		const widget = screen.getByRole("link");
		widget.focus();
		fireEvent.keyDown(widget, { key: "Enter" });
		expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/requests");
	});

	it("keeps keyboard Retry in the widget", () => {
		mocks.attention.mockReturnValue({
			data: { items: [{ request, reason: "failed", ageMs: 1000 }], total: 1 },
			isError: false,
		});
		renderWidget();

		const retry = screen.getByRole("button", { name: /Retry request for Synthetic Item/ });
		retry.focus();
		fireEvent.keyDown(retry, { key: "Enter" });
		fireEvent.click(retry);
		expect(mocks.push).not.toHaveBeenCalled();
		expect(mocks.retry).toHaveBeenCalledTimes(1);
	});

	it("keeps keyboard Approve in the widget", () => {
		const count = mocks.count();
		mocks.count.mockReturnValue({ ...count, data: { ...count.data, pending: 1 } });
		mocks.requests.mockReturnValue({ data: { results: [request] } });
		renderWidget();

		const approve = screen.getByRole("button", { name: /Approve request for Synthetic Item/ });
		approve.focus();
		fireEvent.keyDown(approve, { key: "Enter" });
		fireEvent.click(approve);
		expect(mocks.push).not.toHaveBeenCalled();
		expect(mocks.approve).toHaveBeenCalledTimes(1);
	});
});
