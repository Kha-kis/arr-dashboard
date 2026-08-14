import type { SeerrRequest, SeerrServerWithDetails } from "@arr/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { getLinuxSavePath, getLinuxServerName } from "../../../../lib/incognito";

const mockUseApproveSeerrRequest = vi.fn();
const mockUseSeerrRequestOptions = vi.fn();

vi.mock("../../../../hooks/api/useSeerr", () => ({
	useApproveSeerrRequest: () => mockUseApproveSeerrRequest(),
	useSeerrRequestOptions: (...args: unknown[]) => mockUseSeerrRequestOptions(...args),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#3b82f6",
			to: "#8b5cf6",
			glow: "rgba(59,130,246,0.3)",
			fromLight: "#3b82f610",
			fromMedium: "#3b82f620",
			fromMuted: "#3b82f630",
		},
	}),
}));

import { ApproveWithOptionsDialog } from "../approve-with-options-dialog";

const request: SeerrRequest = {
	id: 706,
	status: 1,
	type: "tv",
	media: {
		id: 706,
		tmdbId: 706,
		status: 1,
		createdAt: "2026-08-14T00:00:00.000Z",
		updatedAt: "2026-08-14T00:00:00.000Z",
	},
	createdAt: "2026-08-14T00:00:00.000Z",
	updatedAt: "2026-08-14T00:00:00.000Z",
	requestedBy: {
		id: 1,
		displayName: "Requester",
		createdAt: "2026-08-14T00:00:00.000Z",
		updatedAt: "2026-08-14T00:00:00.000Z",
		permissions: 0,
		requestCount: 1,
		userType: 1,
	},
	is4k: false,
};

const sonarrServers: SeerrServerWithDetails[] = [
	{
		server: {
			id: 1,
			name: "Sonarr A",
			is4k: false,
			isDefault: true,
			activeProfileId: 10,
			activeDirectory: "/tv-a",
			activeTags: [],
		},
		profiles: [{ id: 10, name: "HD" }],
		rootFolders: [{ id: 10, path: "/tv-a" }],
		tags: [],
	},
	{
		server: {
			id: 2,
			name: "Sonarr B",
			is4k: false,
			isDefault: false,
			activeProfileId: 20,
			activeDirectory: "/tv-b",
			activeTags: [],
		},
		profiles: [{ id: 20, name: "UHD" }],
		rootFolders: [{ id: 20, path: "/tv-b" }],
		tags: [],
	},
];

const mutation = {
	mutate: vi.fn(),
	isPending: false,
};

function renderDialog(children: ReactNode) {
	return render(children, { wrapper: IncognitoProvider });
}

describe("ApproveWithOptionsDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		mockUseApproveSeerrRequest.mockReturnValue(mutation);
		mockUseSeerrRequestOptions.mockReturnValue({
			data: { servers: sonarrServers },
			isLoading: false,
			isError: false,
		});
	});

	it("submits Sonarr B's server, profile, and root folder after selecting it", async () => {
		renderDialog(
			<ApproveWithOptionsDialog
				request={request}
				instanceId="seerr-1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Server"), { target: { value: "2" } });
		await waitFor(() => expect(screen.getByLabelText("Server")).toHaveValue("2"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));

		expect(mutation.mutate).toHaveBeenCalledWith(
			{
				instanceId: "seerr-1",
				requestId: 706,
				overrides: { serverId: 2, profileId: 20, rootFolder: "/tv-b" },
			},
			expect.any(Object),
		);
	});

	it("submits no overrides when approving the unchanged original Sonarr route", () => {
		renderDialog(
			<ApproveWithOptionsDialog
				request={request}
				instanceId="seerr-1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Approve" }));

		expect(mutation.mutate).toHaveBeenCalledWith(
			{ instanceId: "seerr-1", requestId: 706, overrides: undefined },
			expect.any(Object),
		);
	});

	it("masks Sonarr server names and root folders in incognito mode", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");

		renderDialog(
			<ApproveWithOptionsDialog
				request={request}
				instanceId="seerr-1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("option", {
					name: `${getLinuxServerName("Sonarr A")} (default)`,
				}),
			).toBeInTheDocument();
		});
		expect(
			screen.getByRole("option", { name: getLinuxServerName("Sonarr B") }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", {
				name: `${getLinuxSavePath("/tv-a")} (server default)`,
			}),
		).toBeInTheDocument();
		expect(screen.queryByText("Sonarr A (default)")).not.toBeInTheDocument();
		expect(screen.queryByText("/tv-a (server default)")).not.toBeInTheDocument();
	});
});
