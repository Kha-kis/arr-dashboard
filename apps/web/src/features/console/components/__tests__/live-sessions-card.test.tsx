import type { ServiceInstanceSummary, TracearrLiveSessionsResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const mockUseServicesQuery = vi.fn();
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => mockUseServicesQuery(),
}));

const mockUseTracearrLiveSessions = vi.fn();
vi.mock("../../../../hooks/api/useTracearr", () => ({
	useTracearrLiveSessions: () => mockUseTracearrLiveSessions(),
}));

import { LiveSessionsCard } from "../live-sessions-card";

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

function service(overrides: Partial<ServiceInstanceSummary> = {}): ServiceInstanceSummary {
	return {
		id: "trr-1",
		label: "Dev Tracearr",
		baseUrl: "http://tracearr.test",
		service: "tracearr",
		enabled: true,
		isDefault: false,
		tags: [],
		hasApiKey: true,
		...overrides,
	} as ServiceInstanceSummary;
}

function sessions(
	overrides: Partial<TracearrLiveSessionsResponse> = {},
): TracearrLiveSessionsResponse {
	return {
		configured: true,
		instances: [{ id: "trr-1", label: "Dev Tracearr", reachable: true }],
		summary: {
			total: 0,
			transcodes: 0,
			directStreams: 0,
			directPlays: 0,
			totalBitrate: "—",
		},
		...overrides,
	};
}

beforeEach(() => {
	mockUseServicesQuery.mockReset();
	mockUseTracearrLiveSessions.mockReset();
	mockUseTracearrLiveSessions.mockReturnValue({ isLoading: false });
});

describe("<LiveSessionsCard />", () => {
	it("renders nothing when no Tracearr instance is enabled (service gating)", () => {
		mockUseServicesQuery.mockReturnValue({ data: [] });
		const { container } = render(<LiveSessionsCard />, { wrapper: createWrapper() });
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when the only Tracearr instance is disabled", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service({ enabled: false })] });
		const { container } = render(<LiveSessionsCard />, { wrapper: createWrapper() });
		expect(container).toBeEmptyDOMElement();
	});

	it("shows an honest unreachable state, not a fake zero", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: sessions({
				instances: [{ id: "trr-1", label: "Dev Tracearr", reachable: false }],
				summary: null,
			}),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		expect(screen.getByTestId("live-sessions-unreachable")).toBeInTheDocument();
		expect(screen.queryByTestId("live-sessions-summary")).not.toBeInTheDocument();
	});

	it("renders the active-stream count with transcode/direct breakdown", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: sessions({
				summary: {
					total: 3,
					transcodes: 1,
					directStreams: 1,
					directPlays: 1,
					totalBitrate: "42.0 Mbps",
				},
			}),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		const card = screen.getByTestId("live-sessions-summary");
		expect(card).toHaveTextContent("3");
		expect(card).toHaveTextContent(/active streams/i);
		expect(card).toHaveTextContent(/Transcoding/i);
		// direct = directStreams + directPlays = 2
		expect(card).toHaveTextContent("2");
		expect(card).toHaveTextContent("42.0 Mbps");
	});

	it("discloses a partial aggregate when an instance is unreachable", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: sessions({
				instances: [
					{ id: "trr-1", label: "A", reachable: true },
					{ id: "trr-2", label: "B", reachable: false },
				],
				summary: { total: 1, transcodes: 0, directStreams: 1, directPlays: 0, totalBitrate: null },
			}),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		expect(screen.getByTestId("live-sessions-partial")).toHaveTextContent(/unreachable/i);
	});
});
