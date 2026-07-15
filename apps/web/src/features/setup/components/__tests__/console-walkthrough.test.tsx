import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	incognito: false,
	services: [
		{
			id: "service-1",
			service: "jellyfin",
			label: "Living Room Jellyfin",
			baseUrl: "http://192.168.1.25:8096",
			enabled: true,
			isDefault: true,
		},
	],
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: mocks.services, isLoading: false }),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "blue", to: "purple", glow: "blue" },
	}),
}));

vi.mock("../../../../lib/incognito", () => ({
	useIncognitoMode: () => [mocks.incognito, vi.fn()],
	getLinuxServerName: () => "linux-server",
}));

import { ConsoleWalkthrough } from "../console-walkthrough";

describe("ConsoleWalkthrough", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.incognito = false;
	});

	it("reviews connected services and walks through both Console surfaces", () => {
		render(<ConsoleWalkthrough />);

		expect(screen.getByText("Living Room Jellyfin")).toBeInTheDocument();
		expect(screen.getByText("Orientation 1 of 3")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(screen.getByText("Domain health")).toBeInTheDocument();
		expect(screen.getByText("Needs Attention")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(screen.getByText("One rule view, explicit lifecycle")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Open Operator Console" }));
		expect(mocks.push).toHaveBeenCalledWith("/console");
	});

	it("supports returning to services and masks instance labels in incognito mode", () => {
		mocks.incognito = true;
		render(<ConsoleWalkthrough />);

		expect(screen.queryByText("Living Room Jellyfin")).not.toBeInTheDocument();
		expect(screen.getByText("linux-server")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back to TRaSH profile" }));
		expect(mocks.push).toHaveBeenCalledWith("/setup?stage=trash");
	});

	it("allows the walkthrough to be skipped", () => {
		render(<ConsoleWalkthrough />);
		fireEvent.click(screen.getByRole("button", { name: "Skip walkthrough" }));
		expect(mocks.push).toHaveBeenCalledWith("/console");
	});
});
