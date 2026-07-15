import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	refetchDiscovery: vi.fn(),
	testConnection: vi.fn(),
	createService: vi.fn(),
	push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));

vi.mock("../../../../hooks/api/useSetupDiscovery", () => ({
	useSetupDiscovery: () => ({
		refetch: mocks.refetchDiscovery,
		isFetching: false,
		isLoading: false,
		isError: false,
		error: null,
		data: {
			candidates: [
				{
					service: "jellyfin",
					name: "Living Room Jellyfin",
					baseUrl: "http://192.168.1.25:8096",
					serverId: "server-1",
					protocol: "jellyfin-udp",
				},
			],
			scannedProtocols: ["jellyfin-udp"],
			durationMs: 1200,
		},
	}),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [], isLoading: false }),
}));

vi.mock("../../../../hooks/api/useServiceMutations", () => ({
	useTestConnectionBeforeAdd: () => ({
		mutateAsync: mocks.testConnection,
		isPending: false,
	}),
	useCreateServiceMutation: () => ({
		mutateAsync: mocks.createService,
		isPending: false,
	}),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "blue", to: "purple", glow: "blue" },
	}),
}));

vi.mock("../../../../lib/incognito", () => ({
	useIncognitoMode: () => [false, vi.fn()],
	getLinuxServerName: () => "linux-server",
	getLinuxUrl: () => "http://localhost",
}));

import { ServiceOnboarding } from "../service-onboarding";

describe("ServiceOnboarding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.testConnection.mockResolvedValue({ success: true, version: "10.9.0" });
		mocks.createService.mockResolvedValue({ id: "service-1" });
	});

	it("loads discovery automatically and pre-fills a candidate", () => {
		render(<ServiceOnboarding />);

		expect(screen.getByText("Living Room Jellyfin")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
		expect(mocks.refetchDiscovery).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Configure" }));

		expect(screen.getByLabelText("Label")).toHaveValue("Living Room Jellyfin");
		expect(screen.getByLabelText("Base URL")).toHaveValue("http://192.168.1.25:8096");
	});

	it("tests the connection before persisting a service", async () => {
		render(<ServiceOnboarding />);
		fireEvent.click(screen.getByRole("button", { name: "Configure" }));
		fireEvent.change(screen.getByLabelText("API key"), { target: { value: "valid-api-key" } });
		fireEvent.click(screen.getByRole("button", { name: "Test and add" }));

		await waitFor(() => expect(mocks.createService).toHaveBeenCalledOnce());
		expect(mocks.testConnection).toHaveBeenCalledWith({
			service: "jellyfin",
			label: "Living Room Jellyfin",
			baseUrl: "http://192.168.1.25:8096",
			apiKey: "valid-api-key",
		});
		expect(mocks.testConnection.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.createService.mock.invocationCallOrder[0]!,
		);
	});

	it("does not persist a service when verification fails", async () => {
		mocks.testConnection.mockResolvedValue({
			success: false,
			error: "Unauthorized",
			details: "Check the API key",
		});
		render(<ServiceOnboarding />);
		fireEvent.click(screen.getByRole("button", { name: "Configure" }));
		fireEvent.change(screen.getByLabelText("API key"), { target: { value: "invalid-key" } });
		fireEvent.click(screen.getByRole("button", { name: "Test and add" }));

		expect(await screen.findByText("Check the API key")).toBeInTheDocument();
		expect(mocks.createService).not.toHaveBeenCalled();
	});

	it("continues to the Console walkthrough without requiring a service", () => {
		render(<ServiceOnboarding />);
		fireEvent.click(screen.getByRole("button", { name: "Continue without services" }));
		expect(mocks.push).toHaveBeenCalledWith("/setup?stage=starters");
	});
});
