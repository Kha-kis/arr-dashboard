import type { ServiceInstanceSummary } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

vi.mock("../../../../components/layout", () => ({
	DomainStatusBadge: () => <span>Configured</span>,
	deriveServiceInstanceStatus: () => "configured",
	ServiceBadge: ({ service }: { service: string }) => <span>{service}</span>,
}));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#111", to: "#222", fromLight: "#333", fromMuted: "#444" },
	}),
}));
vi.mock("../../../../lib/theme-gradients", () => ({
	getServiceGradient: () => ({ from: "#111", to: "#222" }),
	SEMANTIC_COLORS: {
		success: { bg: "#111", border: "#111", text: "#fff" },
		error: { bg: "#111", border: "#111", text: "#fff" },
	},
}));

import { ServiceInstanceCard } from "../service-instance-card";

const service: ServiceInstanceSummary = {
	id: "plex-1",
	service: "plex",
	label: "Living Room",
	baseUrl: "http://plex.test",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "verified",
		kind: "plex-machine-identifier",
		fingerprint: "7a9c6d3e1f20",
		verifiedAt: "2026-08-14T01:00:00.000Z",
		lastCheckedAt: "2026-08-14T02:00:00.000Z",
	},
	createdAt: "2026-08-14T00:00:00.000Z",
	updatedAt: "2026-08-14T00:00:00.000Z",
	tags: [],
};

describe("ServiceInstanceCard provider identity", () => {
	beforeEach(() => localStorage.setItem("arr-dashboard-incognito-mode", "true"));

	it("renders a verified safe fingerprint without exposing a raw provider identity", () => {
		render(
			<IncognitoProvider>
				<ServiceInstanceCard
					instance={service}
					onTestConnection={vi.fn()}
					onEdit={vi.fn()}
					onToggleDefault={vi.fn()}
					onToggleEnabled={vi.fn()}
					onDelete={vi.fn()}
					isTesting={false}
					mutationPending={false}
				/>
			</IncognitoProvider>,
		);

		expect(screen.getByText(/verified.*plex-machine-identifier/i)).toBeInTheDocument();
		expect(screen.getByText(/7a9c6d3e1f20/)).toBeInTheDocument();
		expect(screen.getByText(/last verified/i)).toBeInTheDocument();
		expect(screen.queryByText(/plex-machine-123/)).not.toBeInTheDocument();
	});

	it.each([
		["unverified", "Provider identity verification required"],
		["mismatch", "Provider identity mismatch"],
	] as const)("renders %s identity status as actionable text", (status, expected) => {
		render(
			<IncognitoProvider>
				<ServiceInstanceCard
					instance={{ ...service, identity: { ...service.identity, status } }}
					onTestConnection={vi.fn()}
					onEdit={vi.fn()}
					onToggleDefault={vi.fn()}
					onToggleEnabled={vi.fn()}
					onDelete={vi.fn()}
					isTesting={false}
					mutationPending={false}
				/>
			</IncognitoProvider>,
		);
		expect(screen.getByText(new RegExp(expected, "i"))).toBeInTheDocument();
	});
});
