import {
	type CleanupFieldOptionsResponse,
	type CleanupRuleType,
	jellyfinEpisodeCompletionParamsSchema,
} from "@arr/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "@/contexts/IncognitoContext";

vi.mock("@/hooks/useThemeGradient", () => ({
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

import { ConditionParamsFields, getDefaultConditionParams } from "../condition-params-fields";

const fieldOptions: CleanupFieldOptionsResponse = {
	videoCodecs: [],
	audioCodecs: [],
	resolutions: [],
	hdrTypes: [],
	releaseGroups: [],
	tautulliUsers: [],
	plexUsers: [],
	plexLibraries: [],
	plexCollections: [],
	plexLabels: [],
	jellyfinUsers: ["Alex"],
	jellyfinLibraries: [],
	arrTags: [],
	hasPlex: false,
	hasTautulli: false,
	hasJellyfin: true,
};

function renderFields(
	ruleType: CleanupRuleType,
	params = getDefaultConditionParams(ruleType),
	options = fieldOptions,
) {
	cleanup();
	const onParamsChange = vi.fn();
	render(
		<IncognitoProvider>
			<ConditionParamsFields
				ruleType={ruleType}
				params={params}
				onParamsChange={onParamsChange}
				fieldOptions={options}
				fieldOptionsLoading={false}
				inputClass="input"
				labelClass="label"
			/>
		</IncognitoProvider>,
	);
	return onParamsChange;
}

describe("ConditionParamsFields Jellyfin composite conditions", () => {
	beforeEach(() => {
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
	});

	it.each([
		["jellyfin_last_watched", { operator: "older_than", days: 90 }],
		["jellyfin_watch_count", { operator: "less_than", count: 1 }],
		["jellyfin_on_deck", { isDeck: false }],
		["jellyfin_user_rating", { operator: "less_than", rating: 5 }],
		["jellyfin_watched_by", { operator: "includes_any", userNames: [] }],
		["jellyfin_added_at", { operator: "older_than", days: 90 }],
		["jellyfin_episode_completion", { operator: "less_than", percentage: 10 }],
	] as [CleanupRuleType, Record<string, unknown>][])(
		"defaults %s to the schema-compatible composite parameters",
		(ruleType, expected) => {
			expect(getDefaultConditionParams(ruleType)).toEqual(expected);
		},
	);

	it("renders the controls required by every Jellyfin condition in a composite rule", () => {
		renderFields("jellyfin_last_watched");
		expect(screen.getByRole("combobox")).toHaveValue("older_than");
		expect(screen.getByDisplayValue("90")).toBeInTheDocument();

		for (const [ruleType, expectedOperator, expectedValue] of [
			["jellyfin_watch_count", "less_than", "1"],
			["jellyfin_user_rating", "less_than", "5"],
			["jellyfin_added_at", "older_than", "90"],
			["jellyfin_episode_completion", "less_than", "10"],
		] as [CleanupRuleType, string, string][]) {
			renderFields(ruleType);
			expect(screen.getByRole("combobox")).toHaveValue(expectedOperator);
			expect(screen.getByDisplayValue(expectedValue)).toBeInTheDocument();
		}

		renderFields("jellyfin_on_deck");
		expect(screen.getByRole("switch", { name: "Item is on Continue Watching" })).toHaveAttribute(
			"aria-checked",
			"false",
		);

		renderFields("jellyfin_watched_by");
		expect(screen.getByRole("combobox")).toHaveValue("includes_any");
		expect(screen.getByText("Jellyfin Users")).toBeInTheDocument();
		expect(screen.getByText("Alex")).toBeInTheDocument();
	});

	it("passes Jellyfin field changes through without discarding composite parameters", () => {
		const onParamsChange = renderFields("jellyfin_watch_count", {
			operator: "less_than",
			count: 1,
			extra: "preserved",
		});
		fireEvent.change(screen.getByDisplayValue("1"), { target: { value: "3" } });
		expect(onParamsChange).toHaveBeenCalledWith({
			operator: "less_than",
			count: 3,
			extra: "preserved",
		});
	});

	it("passes Jellyfin continue-watching toggle changes through", () => {
		const onParamsChange = renderFields("jellyfin_on_deck", { isDeck: false });
		fireEvent.click(screen.getByRole("switch", { name: "Item is on Continue Watching" }));
		expect(onParamsChange).toHaveBeenCalledWith({ isDeck: true });
	});

	it("keeps colliding masked Jellyfin users distinct while preserving raw values", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const onParamsChange = renderFields(
			"jellyfin_watched_by",
			{
				operator: "includes_any",
				userNames: [],
			},
			{ ...fieldOptions, jellyfinUsers: ["Alex", "B"] },
		);

		await waitFor(() => expect(screen.getByText("root 1")).toBeInTheDocument());
		expect(screen.getByText("root 2")).toBeInTheDocument();
		expect(screen.queryByText("Alex")).not.toBeInTheDocument();
		expect(screen.queryByText("B")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("checkbox", { name: "root 2" }));
		expect(onParamsChange).toHaveBeenCalledWith({
			operator: "includes_any",
			userNames: ["B"],
		});
	});

	it("preserves an unavailable selected user when its alias collides with an available user", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const onParamsChange = renderFields(
			"jellyfin_watched_by",
			{
				operator: "includes_any",
				userNames: ["B"],
			},
			{ ...fieldOptions, jellyfinUsers: ["Alex"] },
		);

		await waitFor(() => expect(screen.getByText("root 1")).toBeInTheDocument());
		expect(screen.getByRole("checkbox", { name: "root 1" })).not.toBeChecked();
		expect(screen.getByText("1 selected")).toBeInTheDocument();
		expect(screen.queryByText("Alex")).not.toBeInTheDocument();
		expect(screen.queryByText("B")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(onParamsChange).toHaveBeenCalledWith({
			operator: "includes_any",
			userNames: ["B", "Alex"],
		});
	});

	it("omits an empty Jellyfin minimum season instead of serializing zero", () => {
		let onParamsChange = renderFields("jellyfin_episode_completion");
		expect(screen.getByLabelText("Min Season")).toHaveValue(null);

		onParamsChange = renderFields("jellyfin_episode_completion", {
			operator: "less_than",
			percentage: 10,
			minSeason: 2,
		});
		fireEvent.change(screen.getByLabelText("Min Season"), { target: { value: "" } });

		const updatedParams = onParamsChange.mock.calls[0]![0];
		expect(updatedParams).toEqual({ operator: "less_than", percentage: 10 });
		expect(jellyfinEpisodeCompletionParamsSchema.safeParse(updatedParams).success).toBe(true);
	});
});
