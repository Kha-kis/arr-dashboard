import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import {
	acknowledgeSyncReview,
	fetchSyncsNeedingReview,
} from "../../../../lib/api-client/trash-guides";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SyncReviewNeededPanel } from "../sync-review-needed-panel";

vi.mock("../../../../lib/api-client/trash-guides", () => ({
	acknowledgeSyncReview: vi.fn(),
	fetchSyncsNeedingReview: vi.fn(),
}));

const reviewNeededSync = {
	id: "sync-uncertain-1",
	templateId: "template-1",
	templateName: "Cinema template",
	instanceId: "instance-1",
	instanceName: "Radarr 4K",
	startedAt: "2026-08-15T12:34:00.000Z",
	errorLog: "Process stopped before a rollback ledger was saved.",
};

const secondReviewNeededSync = {
	...reviewNeededSync,
	id: "sync-uncertain-2",
	templateId: "template-2",
	templateName: "Second template",
	instanceId: "instance-2",
	instanceName: "Sonarr HD",
};

function renderPanel() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(<SyncReviewNeededPanel />, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				<ColorThemeProvider>
					<IncognitoProvider>{children}</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>
		),
	});
}

describe("SyncReviewNeededPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
	});

	it("shows backup-less uncertain syncs with their template, instance, and timestamp", async () => {
		vi.mocked(fetchSyncsNeedingReview).mockResolvedValue({ syncs: [reviewNeededSync] });

		renderPanel();

		expect(await screen.findByText("Manual review required")).toBeInTheDocument();
		expect(screen.getByText("Cinema template")).toBeInTheDocument();
		expect(screen.getByText(/Radarr 4K/)).toBeInTheDocument();
		expect(screen.getByText(/Aug 15, 2026/)).toBeInTheDocument();
		expect(
			screen.getByText(/does not roll back or change anything in your ARR instance/i),
		).toBeInTheDocument();
	});

	it("requires explicit confirmation before acknowledging a review", async () => {
		vi.mocked(fetchSyncsNeedingReview).mockResolvedValue({ syncs: [reviewNeededSync] });
		vi.mocked(acknowledgeSyncReview).mockResolvedValue({
			success: true,
			status: "FAILED",
			message: "Manual review acknowledged. No automatic rollback was performed.",
		});

		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: "Acknowledge review" }));

		expect(screen.getByText("Confirm manual review")).toBeInTheDocument();
		expect(acknowledgeSyncReview).not.toHaveBeenCalled();
	});

	it("does not hide a failed recovery-review lookup", async () => {
		vi.mocked(fetchSyncsNeedingReview).mockRejectedValue(new Error("Recovery API unavailable"));

		renderPanel();

		expect(await screen.findByText("Unable to load recovery reviews")).toBeInTheDocument();
		expect(screen.getByText("Recovery API unavailable")).toBeInTheDocument();
	});

	it.each([false, true])(
		"distinguishes same-name reviews and repeats the stable reference in confirmation (incognito=%s)",
		async (incognitoMode) => {
			localStorage.setItem("arr-dashboard-incognito-mode", String(incognitoMode));
			vi.mocked(fetchSyncsNeedingReview).mockResolvedValue({
				syncs: [
					reviewNeededSync,
					{
						...secondReviewNeededSync,
						templateName: reviewNeededSync.templateName,
						instanceName: reviewNeededSync.instanceName,
						startedAt: reviewNeededSync.startedAt,
					},
				],
			});

			renderPanel();

			expect(await screen.findByText("Review CERTAIN1 · Endpoint NSTANCE1")).toBeInTheDocument();
			expect(screen.getByText("Review CERTAIN2 · Endpoint NSTANCE2")).toBeInTheDocument();

			fireEvent.click(screen.getAllByRole("button", { name: "Acknowledge review" })[0]!);
			expect(screen.getAllByText("Review CERTAIN1 · Endpoint NSTANCE1")).toHaveLength(2);
		},
	);

	it("removes an acknowledged sync after refetching the review-needed query", async () => {
		vi.mocked(fetchSyncsNeedingReview)
			.mockResolvedValueOnce({ syncs: [reviewNeededSync] })
			.mockResolvedValueOnce({ syncs: [] });
		vi.mocked(acknowledgeSyncReview).mockResolvedValue({
			success: true,
			status: "FAILED",
			message: "Manual review acknowledged. No automatic rollback was performed.",
		});

		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: "Acknowledge review" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm review" }));

		await waitFor(() => {
			expect(acknowledgeSyncReview).toHaveBeenCalledWith("sync-uncertain-1", expect.anything());
			expect(fetchSyncsNeedingReview).toHaveBeenCalledTimes(2);
		});
		expect(screen.queryByText("Manual review required")).not.toBeInTheDocument();
	});

	it("keeps pending and failed acknowledgement state scoped to its review row", async () => {
		vi.mocked(fetchSyncsNeedingReview).mockResolvedValue({
			syncs: [reviewNeededSync, secondReviewNeededSync],
		});
		let rejectAcknowledgement!: (error: Error) => void;
		vi.mocked(acknowledgeSyncReview).mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectAcknowledgement = reject;
				}),
		);

		renderPanel();

		const acknowledgeButtons = await screen.findAllByRole("button", {
			name: "Acknowledge review",
		});
		fireEvent.click(acknowledgeButtons[0]!);
		fireEvent.click(screen.getByRole("button", { name: "Confirm review" }));

		await waitFor(() => expect(acknowledgeButtons[1]).toBeDisabled());
		rejectAcknowledgement(new Error("First review failed"));
		expect(await screen.findByText("First review failed")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getAllByRole("button", { name: "Acknowledge review" })[1]!);

		expect(screen.getByText("Confirm manual review")).toBeInTheDocument();
		expect(screen.queryByText("First review failed")).not.toBeInTheDocument();
	});
});
