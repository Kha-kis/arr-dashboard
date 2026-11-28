import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ historyAction: vi.fn(), refetch: vi.fn() }));

vi.mock("next/link", () => ({
	default: ({ href, children }: { href: string; children: React.ReactNode }) =>
		createElement("a", { href }, children),
}));
vi.mock("../../../../contexts/IncognitoContext", () => ({ useIncognitoMode: () => [false] }));
vi.mock("../../../../components/layout", () => ({
	PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
	GlassmorphicCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
	PremiumEmptyState: ({ title }: { title: string }) => <p>{title}</p>,
	PremiumPageHeader: ({ title }: { title: string }) => (
		<header>
			<h1>{title}</h1>
		</header>
	),
}));
vi.mock("../../../../components/ui", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
}));
vi.mock("../../../../lib/incognito", () => ({
	getLinuxInstanceName: () => "instance",
	getLinuxIsoName: () => "download",
}));
vi.mock("../../lib/sabnzbd-model", () => ({
	useSabOverview: () => ({
		data: {
			configured: true,
			instances: [{ id: "sab-1", label: "Downloads" }],
		},
		isLoading: false,
		isError: false,
		refetch: mocks.refetch,
	}),
	useSabHistory: () => ({
		data: {
			items: [
				{
					nzoId: "opaque-failed-job",
					name: "Synthetic failed job",
					status: "Failed",
					category: "tv",
					completedAt: "",
					failMessage: "SABnzbd marked this job as failed.",
				},
			],
			start: 0,
			limit: 20,
			total: 1,
			coverage: "complete",
		},
		isLoading: false,
		isError: false,
		isFetching: false,
		refetch: mocks.refetch,
	}),
	useSabHistoryAction: () => ({ mutateAsync: mocks.historyAction, isPending: false }),
}));

import { SabnzbdActivityClient } from "../sabnzbd-activity-client";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("SABnzbd activity operator page", () => {
	it("requires explicit confirmation and targets the selected opaque history item", async () => {
		mocks.historyAction.mockResolvedValue({
			outcome: "verified",
			message: "History action confirmed.",
		});
		vi.stubGlobal(
			"confirm",
			vi.fn(() => true),
		);
		render(<SabnzbdActivityClient />);

		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "Retry failed item" })),
		);
		expect(window.confirm).toHaveBeenCalled();
		expect(mocks.historyAction).toHaveBeenCalledWith({
			instanceId: "sab-1",
			nzoId: "opaque-failed-job",
			action: "retry",
		});
		expect(await screen.findByText("History action confirmed.")).toBeInTheDocument();
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "Remove from history" })),
		);
		expect(mocks.historyAction).toHaveBeenLastCalledWith({
			instanceId: "sab-1",
			nzoId: "opaque-failed-job",
			action: "remove",
		});
		expect(await screen.findByRole("status")).toHaveTextContent("History action confirmed.");
	});
});
