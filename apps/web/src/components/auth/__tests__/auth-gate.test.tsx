import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_UNAUTHORIZED_EVENT } from "../../../lib/api-client/base";
import { authKeys } from "../../../lib/query-keys";
import { AuthGate } from "../auth-gate";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
	usePathname: () => "/dashboard",
	useRouter: () => router,
}));

vi.mock("../../../hooks/api/useAuth", () => ({
	useSetupRequired: () => ({ data: { required: false } }),
	useCurrentUser: () => ({
		data: { id: "user-1", username: "operator" },
		isLoading: false,
		isFetching: false,
	}),
}));

describe("AuthGate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("clears cached identity and redirects when any protected API request reports 401", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(authKeys.currentUser, { id: "user-1", username: "operator" });
		render(
			<QueryClientProvider client={queryClient}>
				<AuthGate>
					<div>Protected content</div>
				</AuthGate>
			</QueryClientProvider>,
		);

		expect(screen.getByText("Protected content")).toBeInTheDocument();
		act(() => window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT)));

		expect(queryClient.getQueryData(authKeys.currentUser)).toBeNull();
		expect(router.replace).toHaveBeenCalledWith("/login?redirectTo=%2Fdashboard");
	});
});
