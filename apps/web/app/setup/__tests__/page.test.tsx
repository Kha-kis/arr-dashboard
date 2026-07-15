import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	replace: vi.fn(),
	stage: "console",
	setupRequired: { data: { required: false }, isLoading: false },
	currentUser: {
		data: { id: "user-1", username: "admin" } as { id: string; username: string } | undefined,
		isLoading: false,
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: mocks.replace }),
	useSearchParams: () => new URLSearchParams({ stage: mocks.stage }),
}));

vi.mock("../../../src/hooks/api/useAuth", () => ({
	useSetupRequired: () => mocks.setupRequired,
	useCurrentUser: () => mocks.currentUser,
}));

vi.mock("../../../src/features/setup/components/setup-client", () => ({
	SetupClient: ({ stage }: { stage: string }) => <div>Setup stage: {stage}</div>,
}));

vi.mock("../../../src/components/ui", () => ({
	Skeleton: () => <div>Loading setup</div>,
}));

import SetupPage from "../page";

describe("SetupPage authenticated stages", () => {
	beforeEach(() => {
		mocks.replace.mockReset();
		mocks.stage = "console";
		mocks.setupRequired = { data: { required: false }, isLoading: false };
		mocks.currentUser = {
			data: { id: "user-1", username: "admin" },
			isLoading: false,
		};
	});

	it("renders the requested Console orientation for an authenticated user", () => {
		render(<SetupPage />);

		expect(screen.getByText("Setup stage: console")).toBeInTheDocument();
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("renders the starter configuration stage for an authenticated user", () => {
		mocks.stage = "starters";
		render(<SetupPage />);

		expect(screen.getByText("Setup stage: starters")).toBeInTheDocument();
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("renders the TRaSH profile stage for an authenticated user", () => {
		mocks.stage = "trash";
		render(<SetupPage />);

		expect(screen.getByText("Setup stage: trash")).toBeInTheDocument();
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("preserves the Console stage when redirecting an expired session to login", async () => {
		mocks.currentUser = { data: undefined, isLoading: false };

		render(<SetupPage />);

		await waitFor(() => {
			expect(mocks.replace).toHaveBeenCalledWith("/login?redirectTo=%2Fsetup%3Fstage%3Dconsole");
		});
	});
});
