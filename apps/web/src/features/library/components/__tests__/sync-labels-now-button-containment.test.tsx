import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runLabelSyncForItem } = vi.hoisted(() => ({
	runLabelSyncForItem: vi.fn(),
}));

vi.mock("../../../../lib/api-client/label-sync", () => ({
	runLabelSyncForItem,
}));

import { SyncLabelsNowButton } from "../sync-labels-now-button";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("SyncLabelsNowButton containment feedback", () => {
	beforeEach(() => {
		runLabelSyncForItem.mockReset();
	});

	it("renders failed feedback when a contained destination stops before write attempts", async () => {
		runLabelSyncForItem.mockResolvedValue({
			rulesFired: 1,
			labelsApplied: 0,
			failures: 0,
			outcomes: [
				{
					ruleId: "contained-rule",
					ruleName: "Contained destination",
					status: "failed",
					message:
						"Jellyfin and Emby label destinations are temporarily unavailable because the provider cannot yet be re-authorized safely at execution time.",
					labelsApplied: 0,
				},
			],
		});

		render(
			<SyncLabelsNowButton
				instanceId="sonarr-1"
				arrItemId={836}
				itemType="series"
				service="sonarr"
			/>,
			{ wrapper },
		);
		fireEvent.click(screen.getByRole("button", { name: "Sync labels for this item now" }));

		const feedback = await screen.findByRole("status");
		expect(feedback).toHaveTextContent("Fired 1 rule, all failed.");
		expect(feedback).toHaveClass("text-rose-400");
		expect(screen.queryByText(/nothing to apply/i)).not.toBeInTheDocument();
	});

	it("renders mixed feedback when one contained rule fails and one supported rule is a no-op", async () => {
		runLabelSyncForItem.mockResolvedValue({
			rulesFired: 2,
			labelsApplied: 0,
			failures: 0,
			outcomes: [
				{
					ruleId: "contained-rule",
					ruleName: "Contained destination",
					status: "failed",
					message: "Destination mutation authority unavailable.",
					labelsApplied: 0,
				},
				{
					ruleId: "supported-rule",
					ruleName: "Supported destination",
					status: "success",
					message: "Nothing to apply.",
					labelsApplied: 0,
				},
			],
		});

		render(
			<SyncLabelsNowButton
				instanceId="sonarr-1"
				arrItemId={836}
				itemType="series"
				service="sonarr"
			/>,
			{ wrapper },
		);
		fireEvent.click(screen.getByRole("button", { name: "Sync labels for this item now" }));

		const feedback = await screen.findByRole("status");
		expect(feedback).toHaveTextContent("1 of 2 rules failed.");
		expect(feedback).toHaveClass("text-amber-400");
		expect(feedback).not.toHaveTextContent("all failed");
		expect(screen.queryByText(/nothing to apply/i)).not.toBeInTheDocument();
	});

	it("reports both a contained rule and supported-destination item failures", async () => {
		runLabelSyncForItem.mockResolvedValue({
			rulesFired: 2,
			labelsApplied: 1,
			failures: 1,
			outcomes: [
				{
					ruleId: "contained-rule",
					ruleName: "Contained destination",
					status: "failed",
					message: "Destination mutation authority unavailable.",
					labelsApplied: 0,
				},
				{
					ruleId: "partial-rule",
					ruleName: "Partially applied destination",
					status: "partial",
					message: "Applied 1 label, 1 failure.",
					labelsApplied: 1,
				},
			],
		});

		render(
			<SyncLabelsNowButton
				instanceId="sonarr-1"
				arrItemId={836}
				itemType="series"
				service="sonarr"
			/>,
			{ wrapper },
		);
		fireEvent.click(screen.getByRole("button", { name: "Sync labels for this item now" }));

		const feedback = await screen.findByRole("status");
		expect(feedback).toHaveTextContent(
			"Applied 1 label; 1 of 2 rules failed; 1 item attempt failed.",
		);
		expect(feedback).toHaveClass("text-amber-400");
	});
});
