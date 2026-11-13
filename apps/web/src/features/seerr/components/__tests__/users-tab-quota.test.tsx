import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { UsersTab } from "../users-tab";

const { mockUseSeerrUserQuota } = vi.hoisted(() => ({ mockUseSeerrUserQuota: vi.fn() }));

vi.mock("../../../../hooks/api/useSeerr", () => ({
	useSeerrUsers: () => ({
		data: {
			results: [{ id: 1, displayName: "Test User", requestCount: 3, userType: 1 }],
			pageInfo: { results: 1 },
		},
	}),
	useSeerrUserQuota: mockUseSeerrUserQuota,
	useUpdateSeerrUser: () => ({ isPending: false, mutate: vi.fn() }),
}));

const finiteQuota = { used: 3, remaining: 7, restricted: false, limit: 10, days: 7 };
const exhaustedQuota = { used: 5, remaining: 0, restricted: true, limit: 5, days: 7 };
const unlimitedQuota = { used: 1, restricted: false, limit: 0, days: 7 };

function renderUsers() {
	return render(
		<IncognitoProvider>
			<ColorThemeProvider>
				<UsersTab instanceId="test-instance" />
			</ColorThemeProvider>
		</IncognitoProvider>,
	);
}

describe("Users tab quota", () => {
	beforeEach(() => {
		mockUseSeerrUserQuota.mockReset();
	});

	it("shows finite usage and identifies an unlimited media type in the row and dialog", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: { movie: finiteQuota, tv: unlimitedQuota },
		});
		renderUsers();

		expect(screen.getByText("3/10")).toBeInTheDocument();
		expect(screen.getByText("Unlimited")).toBeInTheDocument();

		fireEvent.click(screen.getByTitle("Manage user quotas"));
		const dialog = within(await screen.findByRole("dialog"));
		expect(dialog.getByText("3 of 10 used")).toBeInTheDocument();
		expect(dialog.getByText("Unlimited")).toBeInTheDocument();
	});

	it("shows exhausted quota alongside finite usage", () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: { movie: finiteQuota, tv: exhaustedQuota },
		});
		renderUsers();

		expect(screen.getByText("3/10")).toBeInTheDocument();
		expect(screen.getByText("5/5")).toBeInTheDocument();
		expect(screen.getByText("Exhausted")).toBeInTheDocument();
	});

	it("shows quota as unavailable when a refresh fails", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: { movie: unlimitedQuota, tv: unlimitedQuota },
			isError: true,
		});
		renderUsers();

		expect(screen.getByText("Quota unavailable")).toBeInTheDocument();
		expect(screen.queryByText("Unlimited")).toBeNull();

		fireEvent.click(screen.getByTitle("Manage user quotas"));
		const dialog = within(await screen.findByRole("dialog"));
		expect(dialog.getByText("Quota unavailable")).toBeInTheDocument();
		expect(dialog.queryByText("Unlimited")).toBeNull();
	});
});
