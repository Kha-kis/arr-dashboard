import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	refresh: vi.fn(),
	importProfile: vi.fn(),
	incognito: false,
	catalogReady: false,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "blue", to: "purple" } }),
}));
vi.mock("../../../../lib/incognito", () => ({
	useIncognitoMode: () => [mocks.incognito, vi.fn()],
	getLinuxInstanceName: () => "linux-server",
}));
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({
		data: [
			{
				id: "sonarr-1",
				service: "sonarr",
				label: "Family Sonarr",
				enabled: true,
			},
		],
		isLoading: false,
		error: null,
	}),
}));
vi.mock("../../../../hooks/api/useTrashCache", () => ({
	useRefreshTrashCache: () => ({
		mutateAsync: async (...args: unknown[]) => {
			mocks.catalogReady = true;
			return mocks.refresh(...args);
		},
		isPending: false,
		error: null,
	}),
}));
vi.mock("../../../../hooks/api/useQualityProfiles", () => ({
	useQualityProfiles: (_serviceType: string, options: { enabled?: boolean }) => ({
		data: options.enabled
			? {
					profiles: [
						{
							trashId: "profile-1",
							name: "WEB-1080p",
							customFormatCount: 2,
							qualityCount: 3,
							cutoff: "Bluray-1080p",
						},
					],
				}
			: undefined,
		isLoading: false,
		error: null,
	}),
	useQualityProfileDetails: (_serviceType: string, profileId: string) => ({
		data: profileId
			? {
					profile: {},
					mandatoryCFs: [{ trash_id: "mandatory" }],
					cfGroups: [
						{
							trash_id: "group-1",
							defaultEnabled: true,
							custom_formats: [
								{ trash_id: "recommended", required: true },
								{ trash_id: "optional" },
							],
						},
					],
				}
			: undefined,
		isLoading: false,
		error: null,
	}),
	useImportQualityProfile: () => ({
		mutateAsync: mocks.importProfile,
		isPending: false,
		error: null,
	}),
}));
vi.mock("../../../../hooks/api/useTemplates", () => ({
	useTemplates: () => ({ data: { templates: [] }, error: null }),
}));
vi.mock("../../../trash-guides/components/deployment-preview-modal", () => ({
	DeploymentPreviewModal: ({ open, templateId }: { open: boolean; templateId: string | null }) =>
		open ? <div>Preview modal for {templateId}</div> : null,
}));

import { buildSetupProfileSelections, TrashProfileSetup } from "../trash-profile-setup";

describe("TrashProfileSetup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.catalogReady = false;
		mocks.incognito = false;
		mocks.refresh.mockResolvedValue({ refreshed: true });
		mocks.importProfile.mockResolvedValue({ template: { id: "template-1", name: "WEB-1080p" } });
	});

	it("uses mandatory and upstream-default group formats", () => {
		expect(
			buildSetupProfileSelections({
				profile: {},
				mandatoryCFs: [{ trash_id: "mandatory" }],
				cfGroups: [
					{
						trash_id: "default-group",
						defaultEnabled: true,
						custom_formats: [{ trash_id: "required", required: true }, { trash_id: "optional" }],
					},
				],
			}),
		).toEqual({
			selectedCFGroups: ["default-group"],
			customFormatSelections: {
				mandatory: { selected: true, conditionsEnabled: {} },
				required: { selected: true, conditionsEnabled: {} },
				optional: { selected: false, conditionsEnabled: {} },
			},
		});
	});

	it("requires explicit target and profile choices before opening the existing preview", async () => {
		render(<TrashProfileSetup />);

		expect(screen.queryByText(/Preview modal/)).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Target instance"), { target: { value: "sonarr-1" } });
		fireEvent.click(screen.getByRole("button", { name: "Load official Sonarr profiles" }));

		await waitFor(() =>
			expect(mocks.refresh).toHaveBeenCalledWith({ serviceType: "SONARR", force: false }),
		);
		fireEvent.change(await screen.findByLabelText("Official quality profile"), {
			target: { value: "profile-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Review deployment preview" }));

		await waitFor(() =>
			expect(screen.getByText("Preview modal for template-1")).toBeInTheDocument(),
		);
		expect(mocks.importProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				serviceType: "SONARR",
				trashId: "profile-1",
				templateName: "WEB-1080p",
			}),
		);
	});

	it("supports skipping without loading the catalog and masks instance names", () => {
		mocks.incognito = true;
		render(<TrashProfileSetup />);

		expect(screen.queryByText("Family Sonarr", { exact: false })).not.toBeInTheDocument();
		expect(screen.getByText(/linux-server/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Continue without deploying" }));
		expect(mocks.push).toHaveBeenCalledWith("/setup?stage=console");
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
});
