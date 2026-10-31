import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { LabelSyncClient } from "../label-sync-client";

const mocks = vi.hoisted(() => ({
	rules: [] as unknown[],
	isError: false,
	run: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("../../../../hooks/api/useLabelSync", () => ({
	useLabelSyncRules: () => ({ data: mocks.rules, isLoading: false, isError: mocks.isError }),
	useDeleteLabelSyncRule: () => ({ mutateAsync: mocks.remove }),
	useRunLabelSyncRule: () => ({ mutateAsync: mocks.run }),
}));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#000", to: "#fff" } }),
}));

function rule(recovery?: object) {
	return {
		id: "synthetic-rule",
		userId: "owner",
		name: "Synthetic rule",
		enabled: true,
		sourceService: "radarr",
		sourceInstanceId: null,
		sourceTagName: "source",
		destService: "jellyfin",
		destInstanceId: "destination",
		destTagName: "tag",
		destinationMutationCapability: { supported: true },
		recovery,
		lastRunAt: "2026-10-07T00:00:00.000Z",
		lastRunStatus: "success",
		lastRunMessage: "Old completed run",
		createdAt: "2026-10-07T00:00:00.000Z",
		updatedAt: "2026-10-07T00:00:00.000Z",
	};
}
const held = {
	availability: "known",
	state: "restored-held",
	heldCount: 2,
	reconciledCount: 1,
	lastCheckAt: null,
};
beforeEach(() => {
	mocks.rules = [];
	mocks.isError = false;
	vi.clearAllMocks();
	localStorage.clear();
});
function show() {
	return render(
		<IncognitoProvider>
			<LabelSyncClient />
		</IncognitoProvider>,
	);
}

describe("truthful restored recovery UI", () => {
	it("prioritizes held work over old successful status and prevents edit/delete suggestions", () => {
		mocks.rules = [rule(held)];
		show();
		expect(screen.getByRole("status")).toHaveTextContent(/2.*held/i);
		expect(screen.queryByText(/^success$/i)).not.toBeInTheDocument();
		expect(screen.getByText(/read-only/i)).toBeInTheDocument();
		expect(screen.getByText(/not.*resen|no.*resen/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /edit rule/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /delete rule/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Run rule now" })).not.toBeDisabled();
		expect(screen.getByRole("link", { name: /connection settings/i })).toHaveAttribute(
			"href",
			"/settings",
		);
		expect(
			screen.queryByRole("button", { name: /retry|force|release hold/i }),
		).not.toBeInTheDocument();
	});
	it("labels reconciliation as observation rather than labels applied or an original send acknowledgment", () => {
		mocks.rules = [
			rule({
				availability: "known",
				state: "reconciled",
				heldCount: 0,
				reconciledCount: 3,
				lastCheckAt: "2026-10-07T12:00:00.000Z",
			}),
		];
		show();
		expect(screen.getByRole("status")).toHaveTextContent(/desired state observed/i);
		expect(screen.getByRole("status")).toHaveTextContent("3");
		expect(screen.queryByText(/^success$/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/labels applied/i)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /edit rule/i })).not.toBeDisabled();
		expect(screen.getByRole("button", { name: /delete rule/i })).not.toBeDisabled();
		expect(screen.getByText(/last observation/i).querySelector("time")).toHaveAttribute(
			"dateTime",
			"2026-10-07T12:00:00.000Z",
		);
	});
	it.each([undefined, { availability: "unavailable" }])(
		"does not fabricate zero or success for unavailable evidence",
		(recovery) => {
			mocks.rules = [rule(recovery)];
			show();
			expect(screen.getByRole("status")).toHaveTextContent(/recovery.*unavailable/i);
			expect(screen.queryByText(/^success$/i)).not.toBeInTheDocument();
			expect(screen.getByRole("status")).not.toHaveTextContent(/0.*held/i);
			expect(screen.getByRole("button", { name: /edit rule/i })).toBeDisabled();
		},
	);
	it("does not retain an old healthy recovery badge after a failed query", () => {
		mocks.rules = [
			rule({
				availability: "known",
				state: "clear",
				heldCount: 0,
				reconciledCount: 0,
				lastCheckAt: null,
			}),
		];
		mocks.isError = true;
		show();
		expect(screen.getByRole("status")).toHaveTextContent(/recovery.*unavailable/i);
		expect(screen.queryByText(/^success$/i)).not.toBeInTheDocument();
	});
	it("keeps fetch failure distinct from an empty rules list", () => {
		mocks.isError = true;
		show();
		expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i);
		expect(screen.queryByText(/no label-sync rules/i)).not.toBeInTheDocument();
	});
	it("preserves historical status only when restored recovery is genuinely clear", () => {
		mocks.rules = [
			rule({
				availability: "known",
				state: "clear",
				heldCount: 0,
				reconciledCount: 0,
				lastCheckAt: null,
			}),
		];
		show();
		expect(screen.getByText(/^success$/i)).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
	it("keeps a successful unrelated-target run from announcing held recovery as success", async () => {
		mocks.rules = [rule(held)];
		mocks.run.mockResolvedValue(rule(held));
		const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
		show();
		fireEvent.click(screen.getByRole("button", { name: "Run rule now" }));
		await waitFor(() => expect(alert).toHaveBeenCalled());
		expect(alert.mock.calls[0]![0]).toMatch(/held/i);
		expect(alert.mock.calls[0]![0]).not.toMatch(/^success/i);
		alert.mockRestore();
	});
	it("retains generic recovery evidence but masks rule names and tag labels in incognito mode", () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		mocks.rules = [rule(held)];
		show();
		expect(screen.getByRole("status")).toHaveTextContent(/2.*held/i);
		expect(screen.queryByText("Synthetic rule")).not.toBeInTheDocument();
		expect(screen.queryByText(/^source$/)).not.toBeInTheDocument();
		expect(screen.queryByText(/^tag$/)).not.toBeInTheDocument();
	});
	it.each(
		["failed", "partial"].flatMap((status) =>
			[held, { ...held, state: "reconciled", heldCount: 0 }, { availability: "unavailable" }].map(
				(recovery) => ({ status, recovery }),
			),
		),
	)("retains $status run outcome alongside recovery=$recovery", async ({ status, recovery }) => {
		mocks.rules = [
			{ ...rule(recovery), lastRunStatus: status, lastRunMessage: "Synthetic run failure details" },
		];
		mocks.run.mockResolvedValue(mocks.rules[0]);
		const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
		try {
			show();
			expect(screen.getByText(new RegExp(`last run: ${status}`, "i"))).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Run rule now" }));
			await waitFor(() => expect(alert).toHaveBeenCalled());
			expect(alert.mock.calls[0]![0]).toMatch(new RegExp(status, "i"));
			expect(alert.mock.calls[0]![0]).toContain("Synthetic run failure details");
			expect(alert.mock.calls[0]![0]).toMatch(/held|observed|unavailable/i);
		} finally {
			alert.mockRestore();
		}
	});
	it("keeps incognito run failure categories visible but hides their private details", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		mocks.rules = [
			{ ...rule(held), lastRunStatus: "failed", lastRunMessage: "Synthetic private run details" },
		];
		mocks.run.mockResolvedValue(mocks.rules[0]);
		const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
		try {
			show();
			fireEvent.click(screen.getByRole("button", { name: "Run rule now" }));
			await waitFor(() => expect(alert).toHaveBeenCalled());
			expect(alert.mock.calls[0]![0]).toMatch(/failed/i);
			expect(alert.mock.calls[0]![0]).toMatch(/held/i);
			expect(alert.mock.calls[0]![0]).not.toContain("Synthetic private run details");
		} finally {
			alert.mockRestore();
		}
	});
});
