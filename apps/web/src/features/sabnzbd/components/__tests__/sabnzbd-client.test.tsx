import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	globalAction: vi.fn(),
	jobAction: vi.fn(),
}));

vi.mock("next/link", () => ({
	default: ({ href, children }: { href: string; children: React.ReactNode }) =>
		createElement("a", { href }, children),
}));
vi.mock("../../../../contexts/IncognitoContext", () => ({ useIncognitoMode: () => [false] }));
vi.mock("../../../../components/layout", () => ({
	PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
	GlassmorphicCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
	PremiumEmptyState: ({ title }: { title: string }) => <p>{title}</p>,
	PremiumPageHeader: ({ title, description }: { title: string; description: string }) => (
		<header>
			<h1>{title}</h1>
			<p>{description}</p>
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
	PRIORITY_OPTIONS: [
		{ value: "2", label: "Force" },
		{ value: "1", label: "High" },
		{ value: "0", label: "Normal" },
		{ value: "-1", label: "Low" },
	],
	priorityValue: () => "0",
	useSabOverview: () => ({
		data: {
			configured: true,
			instances: [
				{
					id: "sab-1",
					label: "Downloads",
					reachable: true,
					version: "5.1.3",
					paused: false,
					status: "Downloading",
					speed: "1 MB/s",
					kbPerSec: 1024,
					sizeLeft: "1 GB",
					timeLeft: "00:10",
					diskFree: "5 GB",
					diskTotal: "10 GB",
					queueCount: 1,
					pausedJobs: 0,
					failedRecent: 0,
					categories: ["tv"],
					queue: [
						{
							nzoId: "opaque-job",
							name: "Synthetic NZB",
							status: "Queued",
							size: "1 GB",
							sizeLeft: "1 GB",
							timeLeft: "00:10",
							percentage: "0",
							category: "tv",
							priority: "Normal",
							library: null,
						},
					],
					history: [],
					queueCoverage: "complete",
					historyCoverage: "complete",
					warnings: [],
					attention: [],
				},
			],
		},
		isLoading: false,
		isError: false,
		isFetching: false,
		refetch: vi.fn(),
	}),
	useSabGlobalAction: () => ({ mutateAsync: mocks.globalAction, isPending: false }),
	useSabJobAction: () => ({ mutateAsync: mocks.jobAction, isPending: false }),
	useSabCorrelation: (instanceId: string) => ({
		isFetching: false,
		isError: false,
		refetch: vi.fn(),
		data:
			instanceId === "sab-1"
				? {
						coverage: "complete",
						matches: {
							"opaque-job": { service: "sonarr", title: "Synthetic Series", instanceLabel: "TV" },
						},
					}
				: undefined,
	}),
}));

import { SabnzbdClient } from "../sabnzbd-client";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("SABnzbd operator page", () => {
	it("keeps global and per-job controls bound to the chosen instance and opaque job", async () => {
		mocks.globalAction.mockResolvedValue({
			outcome: "verified",
			message: "Queue pause confirmed.",
		});
		mocks.jobAction.mockResolvedValue({ outcome: "verified", message: "State change confirmed." });
		vi.stubGlobal(
			"confirm",
			vi.fn(() => true),
		);
		render(<SabnzbdClient />);

		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause queue" })));
		expect(mocks.globalAction).toHaveBeenCalledWith({ id: "sab-1", action: "pause" });
		expect(await screen.findByText("Queue pause confirmed.")).toBeInTheDocument();
		await act(async () =>
			fireEvent.change(screen.getByRole("combobox", { name: "Set priority" }), {
				target: { value: "1" },
			}),
		);
		expect(mocks.jobAction).toHaveBeenCalledWith({
			instanceId: "sab-1",
			nzoId: "opaque-job",
			action: "priority",
			priority: "1",
		});
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
		expect(window.confirm).toHaveBeenCalled();
		expect(mocks.jobAction).toHaveBeenLastCalledWith({
			instanceId: "sab-1",
			nzoId: "opaque-job",
			action: "delete",
			confirmed: true,
		});
	});

	it("only shows Sonarr/Radarr association after an explicit read-only match request", async () => {
		render(<SabnzbdClient />);
		expect(screen.queryByText(/Synthetic Series/)).not.toBeInTheDocument();
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "Match library items" })),
		);
		expect(screen.getByText(/Sonarr · TV · Synthetic Series/)).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("Only exact unique matches are shown");
	});
});
