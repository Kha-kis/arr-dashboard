import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

vi.mock("../../../../lib/api-client/system");

import * as systemApi from "../../../../lib/api-client/system";
import { TautulliProviderNotice } from "../tautulli-provider-notice";

function renderNotice() {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false, gcTime: 0 } },
	});

	const view = render(
		<QueryClientProvider client={queryClient}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<TautulliProviderNotice />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);

	return { ...view, queryClient };
}

describe("Tautulli provider notice", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("names the selected provider and sends both configured families to the selector", async () => {
		vi.mocked(systemApi.fetchTautulliProviderNotices)
			.mockResolvedValueOnce({
				notices: [
					{
						key: "tautulli-both-configured",
						kind: "both-configured",
						selected: "tracearr",
						actionUrl: "/settings/services#analytics-provider",
					},
				],
			})
			.mockResolvedValueOnce({ notices: [] });
		vi.mocked(systemApi.dismissTautulliProviderNotice).mockResolvedValue({ success: true });

		renderNotice();

		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(screen.getByText("Tracearr is selected for historical analytics")).toBeInTheDocument();
		expect(screen.getByText(/Tautulli is also configured/i)).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(screen.getByRole("alert")).not.toHaveAttribute("aria-modal");
		expect(document.querySelector("[class*='backdrop']")).toBeNull();
		const settingsLink = screen.getByRole("link", { name: /review analytics provider/i });
		expect(settingsLink).toHaveAttribute("href", "/settings/services#analytics-provider");

		const dismiss = screen.getByRole("button", { name: /dismiss alert/i });
		dismiss.focus();
		expect(dismiss).toHaveFocus();
		fireEvent.click(dismiss);
		await waitFor(() =>
			expect(systemApi.dismissTautulliProviderNotice).toHaveBeenCalledWith(
				"tautulli-both-configured",
			),
		);
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
	});

	it("keeps a prior removal notice selected-aware without promising recovery", async () => {
		vi.mocked(systemApi.fetchTautulliProviderNotices).mockResolvedValue({
			notices: [
				{
					key: "tautulli-prior-removal",
					kind: "prior-removal",
					selected: "tracearr",
					actionUrl: "/settings/services#analytics-provider",
				},
			],
		});

		renderNotice();

		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(screen.getByText("Tracearr is selected for historical analytics")).toBeInTheDocument();
		expect(screen.getByText(/does not restore a removed Tautulli connection/i)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /review analytics provider/i })).toHaveAttribute(
			"href",
			"/settings/services#analytics-provider",
		);
	});

	it.each(["Tautulli only", "Tracearr only", "neither provider", "dismissed state"])(
		"does not render a notice when the API reports no pending notice for %s",
		async () => {
			vi.mocked(systemApi.fetchTautulliProviderNotices).mockResolvedValue({ notices: [] });

			renderNotice();

			await waitFor(() => expect(systemApi.fetchTautulliProviderNotices).toHaveBeenCalledOnce());
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);
});
