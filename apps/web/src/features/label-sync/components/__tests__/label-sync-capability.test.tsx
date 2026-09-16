import type { LabelSyncRule, ServiceInstanceSummary } from "@arr/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { RuleDialog } from "../rule-dialog";

const mocks = vi.hoisted(() => ({
	services: [] as ServiceInstanceSummary[],
	create: vi.fn(),
	update: vi.fn(),
	delete: vi.fn(),
	rules: [] as LabelSyncRule[],
	run: vi.fn(),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: mocks.services }),
}));
vi.mock("../../../../hooks/api/useLabelSync", () => ({
	useCreateLabelSyncRule: () => ({ mutateAsync: mocks.create, isPending: false }),
	useUpdateLabelSyncRule: () => ({ mutateAsync: mocks.update, isPending: false }),
	useDeleteLabelSyncRule: () => ({ mutateAsync: mocks.delete, isPending: false }),
	useLabelSyncRules: () => ({ data: mocks.rules, isLoading: false }),
	useRunLabelSyncRule: () => ({ mutateAsync: mocks.run, isPending: false }),
}));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#000", to: "#fff" } }),
}));

const blockedCapability = {
	supported: false,
	code: "destination_mutation_authority_unavailable",
	message:
		"Emby label destinations are temporarily unavailable because the provider cannot yet be re-authorized safely at execution time.",
} as const;

function makeService(
	id: string,
	service: ServiceInstanceSummary["service"],
): ServiceInstanceSummary {
	return { id, service, label: `${service} instance`, enabled: true } as ServiceInstanceSummary;
}

function makeRule(overrides: Partial<LabelSyncRule> = {}): LabelSyncRule {
	return {
		id: "rule-1",
		userId: "user-1",
		name: "Contained rule",
		enabled: true,
		sourceService: "sonarr",
		sourceInstanceId: "sonarr-1",
		sourceTagName: "kids",
		destService: "emby",
		destInstanceId: "emby-1",
		destTagName: "Kids",
		destinationMutationCapability: blockedCapability,
		lastRunAt: null,
		lastRunStatus: null,
		lastRunMessage: null,
		createdAt: "2026-08-31T00:00:00.000Z",
		updatedAt: "2026-08-31T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	mocks.services = [
		makeService("sonarr-1", "sonarr"),
		makeService("jellyfin-1", "jellyfin"),
		makeService("emby-1", "emby"),
	];
	mocks.rules = [];
	vi.clearAllMocks();
});

describe("label-sync destination capability UI", () => {
	it("enables Jellyfin destinations while retaining Emby containment", () => {
		render(
			<IncognitoProvider>
				<RuleDialog rule={null} onClose={vi.fn()} />
			</IncognitoProvider>,
		);

		const source = screen.getByLabelText("Source service") as HTMLSelectElement;
		const destination = screen.getByLabelText("Destination service") as HTMLSelectElement;
		expect(source.querySelector('option[value="jellyfin"]')).not.toBeDisabled();
		expect(source.querySelector('option[value="emby"]')).not.toBeDisabled();
		expect(destination.querySelector('option[value="jellyfin"]')).not.toBeDisabled();
		expect(destination.querySelector('option[value="emby"]')).toBeDisabled();
		expect(destination.querySelector('option[value="emby"]')).toHaveAttribute(
			"title",
			blockedCapability.message,
		);
	});

	it("warns when editing an existing blocked destination", () => {
		render(
			<IncognitoProvider>
				<RuleDialog rule={makeRule()} onClose={vi.fn()} />
			</IncognitoProvider>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent(blockedCapability.message);
	});

	it("shows blocked capability and disables Run for an existing rule", async () => {
		mocks.rules = [makeRule()];
		const { LabelSyncClient } = await import("../label-sync-client");
		render(
			<IncognitoProvider>
				<LabelSyncClient />
			</IncognitoProvider>,
		);

		expect(screen.getByText("Mutation unavailable")).toBeInTheDocument();
		expect(screen.getByText(/Sources: Sonarr, Radarr, Plex, Jellyfin, Emby/)).toBeInTheDocument();
		expect(screen.getByText(/Destinations: Sonarr, Radarr, Plex, or Jellyfin/)).toBeInTheDocument();
		expect(screen.queryByText(/any destination service/i)).not.toBeInTheDocument();
		const run = screen.getByRole("button", { name: "Run rule unavailable" });
		expect(run).toBeDisabled();
		expect(run).toHaveAttribute("title", blockedCapability.message);
		fireEvent.click(run);
		expect(mocks.run).not.toHaveBeenCalled();
	});
});

it("allows running a supported Jellyfin rule", async () => {
	mocks.rules = [
		makeRule({
			destService: "jellyfin",
			destInstanceId: "jellyfin-1",
			destinationMutationCapability: { supported: true },
		}),
	];
	const { LabelSyncClient } = await import("../label-sync-client");
	render(
		<IncognitoProvider>
			<LabelSyncClient />
		</IncognitoProvider>,
	);
	expect(screen.queryByText("Mutation unavailable")).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Run rule now" })).not.toBeDisabled();
});
