import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateCreation } from "../template-creation";

const mocks = vi.hoisted(() => ({
	useQuery: vi.fn(),
	importMutation: {
		mutateAsync: vi.fn(),
		isPending: false,
		isError: false,
		isSuccess: false,
		error: null,
	},
	updateMutation: {
		mutateAsync: vi.fn(),
		isPending: false,
		isError: false,
		isSuccess: false,
		error: null,
	},
	clonedMutation: {
		mutateAsync: vi.fn(),
		isPending: false,
		isError: false,
		isSuccess: false,
		error: null,
	},
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));

vi.mock("../../../../../hooks/api/useQualityProfiles", () => ({
	useImportQualityProfileWizard: () => mocks.importMutation,
	useUpdateQualityProfileTemplate: () => mocks.updateMutation,
	useCreateClonedProfileTemplate: () => mocks.clonedMutation,
}));

vi.mock("../../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { fromMuted: "transparent", fromLight: "transparent" },
	}),
}));

describe("TemplateCreation cloned source review", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.clonedMutation.mutateAsync.mockResolvedValue({});
		mocks.useQuery
			.mockReturnValueOnce({
				data: undefined,
				isLoading: false,
				error: new Error("ARR source profile is unavailable"),
			})
			.mockReturnValueOnce({ data: [], isLoading: false, error: null })
			.mockReturnValueOnce({ data: undefined, isLoading: false, error: null });
	});

	it("shows the source-review failure and disables cloned template creation", () => {
		render(
			<TemplateCreation
				serviceType="RADARR"
				wizardState={{
					selectedProfile: {
						trashId: "cloned-instance-1-4-1700000000000-abc123",
						name: "Any",
						description: "Cloned from Radarr",
					} as never,
					customFormatSelections: {
						"trash-1": { selected: true, conditionsEnabled: {} },
					},
					templateName: "My cloned profile",
					templateDescription: "",
				}}
				onComplete={vi.fn()}
				onBack={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(
				"The cloned profile review is unavailable. Go back and review the Custom Formats again.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create Template" })).toBeDisabled();
		expect(mocks.clonedMutation.mutateAsync).not.toHaveBeenCalled();
	});

	it("creates from the exact source snapshot carried from configuration", async () => {
		render(
			<TemplateCreation
				serviceType="RADARR"
				wizardState={{
					selectedProfile: {
						trashId: "cloned-instance-1-4-1700000000000-abc123",
						name: "Any",
						description: "Cloned from Radarr",
					} as never,
					customFormatSelections: {
						"instance-42": { selected: true, conditionsEnabled: {} },
					},
					templateName: "My cloned profile",
					templateDescription: "",
					clonedSourceReview: {
						sourceStateToken: "a".repeat(64),
						profile: {
							name: "Any",
							upgradeAllowed: true,
							cutoff: 1,
							minFormatScore: 0,
							items: [],
						},
						mandatoryCFTrashIds: ["instance-42"],
					},
				}}
				onComplete={vi.fn()}
				onBack={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Create Template" }));

		await waitFor(() =>
			expect(mocks.clonedMutation.mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({ sourceStateToken: "a".repeat(64) }),
			),
		);
	});
});
