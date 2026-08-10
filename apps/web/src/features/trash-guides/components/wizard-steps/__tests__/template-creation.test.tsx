import { render, screen } from "@testing-library/react";
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

		expect(screen.getByText("ARR source profile is unavailable")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create Template" })).toBeDisabled();
		expect(mocks.clonedMutation.mutateAsync).not.toHaveBeenCalled();
	});
});
