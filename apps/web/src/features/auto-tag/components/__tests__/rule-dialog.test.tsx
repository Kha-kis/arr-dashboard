import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	create: vi.fn(),
	update: vi.fn(),
	incognito: false,
	services: [
		{ id: "plex-1", service: "plex", label: "Private Plex", enabled: true },
		{ id: "jellyfin-disabled", service: "jellyfin", label: "Disabled Jellyfin", enabled: false },
		{ id: "sonarr-1", service: "sonarr", label: "Private Sonarr", enabled: true },
	] as never[],
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
vi.mock("../../../../components/ui/input", () => ({
	Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("../../../../hooks/api/useAutoTag", () => ({
	useCreateAutoTagRule: () => ({ mutateAsync: state.create, isPending: false }),
	useUpdateAutoTagRule: () => ({ mutateAsync: state.update, isPending: false }),
}));
vi.mock("../../../../hooks/api/useLibraryCleanup", () => ({
	useCleanupFieldOptions: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: state.services, isLoading: false }),
}));
vi.mock("../../../../lib/incognito", () => ({
	getLinuxInstanceName: () => "Masked server",
	useIncognitoMode: () => [state.incognito, vi.fn()],
}));
vi.mock("../../../rule-criteria/components/condition-params-fields", () => ({
	ConditionParamsFields: () => <p>Other criterion parameters</p>,
	getDefaultConditionParams: () => ({}),
}));

import { RuleDialog } from "../rule-dialog";

beforeEach(() => {
	state.create.mockReset().mockResolvedValue(undefined);
	state.update.mockReset().mockResolvedValue(undefined);
	state.incognito = false;
});

describe("RuleDialog media server presence", () => {
	it("submits the selected enabled Plex instance as a positive presence criterion", async () => {
		render(<RuleDialog rule={null} onClose={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Present movies" } });
		fireEvent.change(screen.getByLabelText("Tag to apply"), { target: { value: "present" } });
		fireEvent.change(screen.getByLabelText("Match criteria"), {
			target: { value: "media_server_presence" },
		});

		const providerSelect = screen.getByLabelText("Media server");
		expect(screen.queryByRole("option", { name: /Disabled Jellyfin/i })).not.toBeInTheDocument();
		fireEvent.change(providerSelect, { target: { value: "plex-1" } });
		fireEvent.click(screen.getByRole("button", { name: "Create rule" }));

		await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
		expect(state.create).toHaveBeenCalledWith(
			expect.objectContaining({
				ruleType: "media_server_presence",
				parameters: { instanceId: "plex-1" },
				operator: null,
				conditions: null,
			}),
		);
	});

	it("masks selected provider names in incognito mode", () => {
		state.incognito = true;
		render(<RuleDialog rule={null} onClose={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("Match criteria"), {
			target: { value: "media_server_presence" },
		});

		expect(screen.getByRole("option", { name: /Masked server/i })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: /Private Plex/i })).not.toBeInTheDocument();
	});
});
