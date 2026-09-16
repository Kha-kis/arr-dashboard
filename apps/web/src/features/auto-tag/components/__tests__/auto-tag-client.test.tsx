import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	preview: undefined as unknown,
	previewCalls: [] as string[],
	run: vi.fn(),
	delete: vi.fn(),
	create: vi.fn(),
}));

vi.mock("../../../../components/layout", () => ({
	GlassmorphicCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("../../../../components/ui/button", () => ({
	Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
}));
vi.mock("../../../../components/ui/dialog", () => ({
	Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
	DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../../../../hooks/api/useAutoTag", () => ({
	useAutoTagRules: () => ({ data: [rule], isLoading: false }),
	useAutoTagRulePreview: (id: string) => {
		state.previewCalls.push(id);
		return { data: state.preview, isLoading: false, isError: false };
	},
	useDeleteAutoTagRule: () => ({ mutateAsync: state.delete }),
	useRunAutoTagRule: () => ({ mutateAsync: state.run }),
}));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#111", to: "#222" } }),
}));
vi.mock("../../../../lib/incognito", () => ({
	getLinuxIsoName: () => "Masked title",
	useIncognitoMode: () => [false, vi.fn()],
}));
vi.mock("../rule-dialog", () => ({ RuleDialog: () => null }));
vi.mock("../webhook-config-panel", () => ({ WebhookConfigPanel: () => null }));

import { AutoTagClient } from "../auto-tag-client";

const rule = {
	id: "rule-1",
	userId: "user-1",
	name: "Presence rule",
	enabled: true,
	ruleType: "media_server_presence",
	parameters: { instanceId: "plex-1" },
	operator: null,
	conditions: null,
	serviceFilter: null,
	instanceFilter: null,
	excludeTags: null,
	excludeTitles: null,
	plexLibraryFilter: null,
	tagName: "present",
	lastRunAt: null,
	lastRunStatus: null,
	lastRunMessage: null,
	createdAt: "2026-09-14T00:00:00.000Z",
	updatedAt: "2026-09-14T00:00:00.000Z",
} as never;

beforeEach(() => {
	state.preview = undefined;
	state.previewCalls.length = 0;
	state.run.mockReset();
	state.delete.mockReset();
	state.create.mockReset();
});

describe("AutoTagClient preview", () => {
	it("loads a read-only preview and displays unknown reasons", () => {
		state.preview = {
			itemsScanned: 2,
			itemsMatched: 1,
			itemsUnknown: 1,
			truncated: false,
			items: [
				{
					instanceId: "plex-1",
					arrItemId: 10,
					itemType: "movie",
					title: "Matched title",
					state: "true",
					reason: "Present at last complete scan",
				},
				{
					instanceId: "plex-1",
					arrItemId: 11,
					itemType: "series",
					title: "Unknown title",
					state: "unknown",
					reason: "Provider snapshot is stale",
				},
			],
		};
		render(<AutoTagClient />);

		fireEvent.click(screen.getByTitle("Preview rule"));

		expect(screen.getByText("Preview: Presence rule")).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
		expect(screen.getByText("Would tag")).toBeInTheDocument();
		expect(screen.getAllByText("Unknown")).not.toHaveLength(0);
		expect(screen.getByText("Provider snapshot is stale")).toBeInTheDocument();
		expect(state.previewCalls).toContain("rule-1");
		expect(state.run).not.toHaveBeenCalled();
		expect(state.delete).not.toHaveBeenCalled();
	});
});
