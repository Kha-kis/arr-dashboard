import type { EnhancedPreviewResult } from "@arr/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { EnhancedDryRunPreview } from "../dry-run-preview";

function fixture(action: "import" | "skip" = "import"): EnhancedPreviewResult {
	return {
		instanceId: "synthetic-instance",
		instanceLabel: "Synthetic provider label",
		instanceService: "radarr",
		instanceReachable: true,
		queueSummary: {
			totalItems: 1,
			downloading: 0,
			paused: 0,
			queued: 0,
			seeding: 0,
			importPending: 1,
			failed: 0,
		},
		wouldRemove: 0,
		wouldImport: action === "import" ? 1 : 0,
		wouldWarn: 0,
		wouldSkip: action === "skip" ? 1 : 0,
		previewItems: [
			{
				id: 42,
				title: "Synthetic private title",
				downloadId: "synthetic-source",
				action,
				rule: "import_pending",
				reason:
					action === "import" ? "Import eligible" : "Import budget exhausted; source retained",
				detailedReason: "Current verification required; source retained",
				queueAge: 60,
			},
		],
		ruleSummary: { import_pending: 1 },
		previewGeneratedAt: "2026-10-01T12:00:00.000Z",
		configSnapshot: {
			dryRunMode: false,
			strikeSystemEnabled: false,
			maxStrikes: 2,
			maxRemovalsPerRun: 10,
		},
	};
}
function show(result: EnhancedPreviewResult) {
	const run = vi.fn().mockResolvedValue(undefined);
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<EnhancedDryRunPreview
					result={result}
					onClose={vi.fn()}
					onRunClean={run}
					isRunningClean={false}
				/>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
	return run;
}
beforeEach(() => localStorage.clear());
describe("Cleaner import preview", () => {
	it("shows conditional attempts separately from removals and enables the ordinary run", () => {
		const run = show(fixture());
		expect(screen.getByRole("button", { name: /Would Attempt Import \(1\)/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Would Remove \(/i })).not.toBeInTheDocument();
		expect(screen.getByText(/import attempts retain their source/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Run Clean Now/i }));
		expect(run).toHaveBeenCalledOnce();
	});
	it("renders deferred items and their reason rather than hiding the Keep count", () => {
		show(fixture("skip"));
		fireEvent.click(screen.getByRole("button", { name: /Would Keep \(1\)/i }));
		expect(screen.getByText(/Import budget exhausted; source retained/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Run Clean Now/i })).not.toBeInTheDocument();
	});
	it("preserves individual import-attempt outcomes for a grouped download", () => {
		const result = fixture();
		result.previewItems.push({
			...result.previewItems[0]!,
			id: 43,
			title: "Synthetic private title - S01E02",
		});
		result.wouldImport = 2;
		show(result);
		const group = screen.getByRole("button", { name: /2 items/i });
		expect(within(group).getByText(/import attempt/i)).toBeInTheDocument();
		fireEvent.click(group);
		expect(screen.getAllByText("Import attempt")).toHaveLength(3);
	});
	it("conceals existing private labels in incognito mode, including expanded items", () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		show(fixture());
		fireEvent.click(screen.getByRole("button", { name: /\.iso/i }));
		expect(screen.getByText("Current verification required; source retained")).toBeInTheDocument();
		expect(screen.queryByText("Synthetic provider label")).not.toBeInTheDocument();
		expect(screen.queryByText("Synthetic private title")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Would Attempt Import \(1\)/i })).toBeInTheDocument();
	});
});
