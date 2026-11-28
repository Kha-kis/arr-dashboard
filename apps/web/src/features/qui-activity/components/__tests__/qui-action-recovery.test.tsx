import type { QuiActionLogEntry } from "@arr/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const state = vi.hoisted(() => ({
	entries: [] as QuiActionLogEntry[],
	mutate: vi.fn(),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [{ service: "qui", enabled: true }], isLoading: false }),
}));

vi.mock("../../../../hooks/api/useQui", () => ({
	useQuiActivityFeed: () => ({
		data: { pages: [{ events: [], entries: [], nextCursor: null }] },
		isLoading: false,
		isError: false,
	}),
	useQuiActionLog: () => ({
		data: { pages: [{ entries: state.entries, nextCursor: null }] },
		isLoading: false,
		isError: false,
		isFetching: false,
		hasNextPage: false,
		refetch: vi.fn(),
	}),
	useQuiActionReconciliation: () => ({
		mutate: state.mutate,
		isPending: false,
		isError: false,
	}),
}));

import { QuiActivityClient } from "../qui-activity-client";

const HASH = "a".repeat(40);

function entry(
	status: QuiActionLogEntry["status"],
	requestedAt = "2026-01-01T00:00:00.000Z",
	operation: QuiActionLogEntry["action"] = "pause",
	payload: unknown = null,
) {
	return {
		id: "action-1",
		serviceInstanceId: "qui-test",
		serviceInstanceLabel: "Test qUI",
		qbitInstanceId: 7,
		torrentHash: HASH,
		action: operation,
		status,
		error: null,
		payload,
		requestedAt,
		completedAt: null,
	};
}

function renderActions() {
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<QuiActivityClient />
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "My Actions" }));
}

afterEach(() => {
	state.entries = [];
	state.mutate.mockReset();
	vi.restoreAllMocks();
});

describe("qUI action recovery UI", () => {
	it("shows a held outcome and requires confirmation for one exact hash", () => {
		state.entries = [entry("uncertain")];
		vi.spyOn(window, "confirm").mockReturnValue(true);
		renderActions();
		expect(screen.getByText(/Outcome not confirmed/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Show full info hash for verification" }));
		expect(screen.getByText(HASH)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Verified not applied" }));
		expect(state.mutate).toHaveBeenCalledWith({
			actionLogId: "action-1",
			decision: "not_applied",
		});
	});

	it("does not offer resolution while an action is freshly pending", () => {
		state.entries = [entry("pending", new Date().toISOString())];
		renderActions();
		expect(screen.getByText(/Outcome not confirmed/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Verified applied" })).not.toBeInTheDocument();
	});

	it("also waits before resolving a freshly uncertain action", () => {
		state.entries = [entry("uncertain", new Date().toISOString())];
		renderActions();
		expect(screen.getByText(/Outcome not confirmed/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Verified applied" })).not.toBeInTheDocument();
	});

	it("labels drawer operations and renders only their safe audit count", () => {
		state.entries = [
			entry("success", "2026-01-01T00:00:00.000Z", "addTrackers", { trackerCount: 2 }),
		];
		renderActions();
		expect(screen.getAllByText(/Add trackers/).length).toBeGreaterThan(1);
		expect(screen.getByText(/2 trackers/)).toBeInTheDocument();
		expect(screen.getByText(/Exact names and announce URLs are not retained/)).toBeInTheDocument();
		expect(screen.queryByText(/private|announce\.example/i)).not.toBeInTheDocument();
	});
});
