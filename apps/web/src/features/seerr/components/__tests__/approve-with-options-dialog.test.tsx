import type { SeerrRequest } from "@arr/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseSeerrRequestOptions = vi.fn();
const mockUseApproveSeerrRequest = vi.fn();

vi.mock("../../../../hooks/api/useSeerr", () => ({
	useSeerrRequestOptions: (...args: unknown[]) => mockUseSeerrRequestOptions(...args),
	useApproveSeerrRequest: () => mockUseApproveSeerrRequest(),
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

const defaultServer = {
	server: {
		id: 1,
		name: "Sonarr A",
		is4k: false,
		isDefault: true,
		activeProfileId: 10,
		activeDirectory: "/tv-a",
	},
	profiles: [{ id: 10, name: "HD-1080p" }],
	rootFolders: [{ id: 100, path: "/tv-a" }],
};

const alternateServer = {
	server: {
		id: 2,
		name: "Sonarr B",
		is4k: false,
		isDefault: false,
		activeProfileId: 20,
		activeDirectory: "/tv-b",
	},
	profiles: [{ id: 20, name: "WEB-1080p" }],
	rootFolders: [{ id: 200, path: "/tv-b" }],
};

const request = {
	id: 42,
	type: "tv",
	is4k: false,
	serverId: undefined,
	profileId: undefined,
	rootFolder: undefined,
} as SeerrRequest;

const defaultMutation = {
	mutate: vi.fn(),
	isPending: false,
};

function renderDialog() {
	return render(
		<ApproveWithOptionsDialog request={request} instanceId="seerr-1" open onOpenChange={vi.fn()} />,
	);
}

describe("ApproveWithOptionsDialog", () => {
	let mutate: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mutate = vi.fn();
		mockUseSeerrRequestOptions.mockReturnValue({
			data: { servers: [defaultServer, alternateServer] },
			isLoading: false,
			isError: false,
		});
		mockUseApproveSeerrRequest.mockReturnValue({ ...defaultMutation, mutate });
	});

	it("sends selected server defaults as overrides when changing a first-time route", () => {
		renderDialog();

		fireEvent.change(screen.getByLabelText("Server"), { target: { value: "2" } });
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));

		expect(mutate).toHaveBeenCalledWith(
			{
				instanceId: "seerr-1",
				requestId: 42,
				overrides: {
					serverId: 2,
					profileId: 20,
					rootFolder: "/tv-b",
				},
			},
			expect.any(Object),
		);
	});

	it("does not send overrides when approving the default first-time route", () => {
		renderDialog();

		fireEvent.click(screen.getByRole("button", { name: "Approve" }));

		expect(mutate).toHaveBeenCalledWith(
			{
				instanceId: "seerr-1",
				requestId: 42,
				overrides: undefined,
			},
			expect.any(Object),
		);
	});
});
