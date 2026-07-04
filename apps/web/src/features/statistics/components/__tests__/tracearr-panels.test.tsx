import type {
	TracearrHistoryBundle,
	TracearrUsersBundle,
	TracearrViolationsBundle,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";

const mockHistory = vi.fn();
const mockUsers = vi.fn();
const mockViolations = vi.fn();
vi.mock("../../../../hooks/api/useTracearr", () => ({
	useTracearrHistory: () => mockHistory(),
	useTracearrUsers: () => mockUsers(),
	useTracearrViolations: () => mockViolations(),
}));

import {
	TracearrHistoryPanel,
	TracearrUsersPanel,
	TracearrViolationsPanel,
} from "../tracearr-panels";

function createWrapper() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}

function historyBundle(): TracearrHistoryBundle {
	return {
		instanceId: "trr-1",
		instanceLabel: "Dev Tracearr",
		history: {
			data: [
				{
					id: "h1",
					instanceId: "trr-1",
					mediaTitle: "Blade Runner 2049",
					username: "alice",
					serverName: "Johns Home Plex",
					startedAt: "2026-07-01T00:00:00.000Z",
					mediaType: "movie",
				} as never,
			],
			meta: { total: 1, page: 1, pageSize: 25 },
		},
	};
}

function usersBundle(): TracearrUsersBundle {
	return {
		instanceId: "trr-1",
		instanceLabel: "Dev Tracearr",
		users: {
			data: [
				{ id: "u1", username: "bob", role: "member", trustScore: 82, totalViolations: 1 } as never,
			],
			meta: { total: 1, page: 1, pageSize: 25 },
		},
	};
}

function violationsBundle(): TracearrViolationsBundle {
	return {
		instanceId: "trr-1",
		instanceLabel: "Dev Tracearr",
		violations: {
			data: [
				{
					id: "v1",
					severity: "high",
					acknowledged: false,
					rule: { name: "Concurrent locations" },
					user: { username: "carol" },
					createdAt: "2026-07-01T00:00:00.000Z",
				} as never,
			],
			meta: { total: 1, page: 1, pageSize: 25 },
		},
	};
}

beforeEach(() => {
	mockHistory.mockReset();
	mockUsers.mockReset();
	mockViolations.mockReset();
	mockHistory.mockReturnValue({ data: historyBundle(), isFetching: false });
	mockUsers.mockReturnValue({ data: usersBundle(), isFetching: false });
	mockViolations.mockReturnValue({ data: violationsBundle(), isFetching: false });
	localStorage.removeItem(INCOGNITO_STORAGE_KEY);
});

describe("<TracearrHistoryPanel />", () => {
	it("renders history rows with title, user, and server", () => {
		render(<TracearrHistoryPanel />, { wrapper: createWrapper() });
		const rows = screen.getByTestId("tracearr-history-rows");
		expect(rows).toHaveTextContent("Blade Runner 2049");
		expect(rows).toHaveTextContent("alice");
		expect(rows).toHaveTextContent("Johns Home Plex");
	});

	it("masks title, user, and server in incognito", async () => {
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		render(<TracearrHistoryPanel />, { wrapper: createWrapper() });
		await waitFor(() => expect(screen.queryByText("Blade Runner 2049")).not.toBeInTheDocument());
		expect(screen.queryByText("alice")).not.toBeInTheDocument();
		expect(screen.queryByText(/Johns Home Plex/)).not.toBeInTheDocument();
		expect(screen.getByTestId("tracearr-history-rows")).toBeInTheDocument();
	});

	it("derives the pager from the server's pageSize, not a client constant", () => {
		// Server clamps to pageSize 10 with 30 total → 3 pages. A client that
		// assumed pageSize 25 would compute 2 pages and hide the tail.
		mockHistory.mockReturnValue({
			data: {
				instanceId: "trr-1",
				instanceLabel: "X",
				history: {
					data: [historyBundle().history.data[0]],
					meta: { total: 30, page: 1, pageSize: 10 },
				},
			},
			isFetching: false,
		});
		render(<TracearrHistoryPanel />, { wrapper: createWrapper() });
		expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
	});

	it("shows an honest empty state when there is no history", () => {
		mockHistory.mockReturnValue({
			data: {
				instanceId: "trr-1",
				instanceLabel: "X",
				history: { data: [], meta: { total: 0, page: 1, pageSize: 25 } },
			},
			isFetching: false,
		});
		render(<TracearrHistoryPanel />, { wrapper: createWrapper() });
		expect(screen.queryByTestId("tracearr-history-rows")).not.toBeInTheDocument();
		expect(screen.getByText(/No watch history recorded yet/i)).toBeInTheDocument();
	});
});

describe("<TracearrUsersPanel />", () => {
	it("renders users with role, trust score, and violation count", () => {
		render(<TracearrUsersPanel />, { wrapper: createWrapper() });
		const rows = screen.getByTestId("tracearr-users-rows");
		expect(rows).toHaveTextContent("bob");
		expect(rows).toHaveTextContent("82"); // trust score
		expect(rows).toHaveTextContent(/1 violation/i);
	});

	it("masks the username in incognito", async () => {
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		render(<TracearrUsersPanel />, { wrapper: createWrapper() });
		await waitFor(() => expect(screen.queryByText("bob")).not.toBeInTheDocument());
		expect(screen.getByTestId("tracearr-users-rows")).toBeInTheDocument();
	});
});

describe("<TracearrViolationsPanel />", () => {
	it("renders violations with severity, rule, and user", () => {
		render(<TracearrViolationsPanel />, { wrapper: createWrapper() });
		const rows = screen.getByTestId("tracearr-violations-rows");
		expect(rows).toHaveTextContent(/high/i);
		expect(rows).toHaveTextContent("Concurrent locations");
		expect(rows).toHaveTextContent("carol");
	});

	it("masks the violating user in incognito", async () => {
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		render(<TracearrViolationsPanel />, { wrapper: createWrapper() });
		await waitFor(() => expect(screen.queryByText("carol")).not.toBeInTheDocument());
		expect(screen.getByTestId("tracearr-violations-rows")).toBeInTheDocument();
	});
});
