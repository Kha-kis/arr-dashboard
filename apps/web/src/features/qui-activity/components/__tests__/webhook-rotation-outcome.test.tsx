import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import * as api from "../../../../lib/api-client/qui";
import * as servicesApi from "../../../../lib/api-client/services";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QuiWebhookConfigPanel } from "../webhook-config-panel";

let client: QueryClient;
beforeEach(() => {
	localStorage.clear();
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
	});
	vi.spyOn(api, "fetchQuiWebhookConfig").mockResolvedValue({
		hasSecret: true,
		webhookUrl: "http://callback.example/webhook",
	});
	vi.spyOn(api, "fetchQuiEventLog").mockResolvedValue({ entries: [], nextCursor: null });
	vi.spyOn(servicesApi, "fetchServices").mockResolvedValue([]);
	vi.spyOn(api, "rotateQuiWebhookSecret").mockResolvedValue({
		hasSecret: true,
		webhookUrl: "http://callback.example/webhook",
		secret: "synthetic-new-secret",
	});
	vi.spyOn(api, "registerQuiWebhook");
	vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
});
function mount() {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<QueryClientProvider client={client}>
					<QuiWebhookConfigPanel />
					<Toaster />
				</QueryClientProvider>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}
describe("qUI webhook rotation outcome", () => {
	it("treats a committed rotation with a lost response as unconfirmed, without retrying", async () => {
		let committed = false;
		vi.mocked(api.rotateQuiWebhookSecret).mockImplementation(async () => {
			committed = true;
			throw new Error("Synthetic response lost");
		});
		mount();
		await screen.findByDisplayValue("http://callback.example/webhook");
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		await screen.findByText("Synthetic response lost");
		expect(committed).toBe(true);
		const feedback = screen.getByText("Synthetic response lost").closest("[data-sonner-toast]");
		expect(feedback).toHaveTextContent(/not confirmed/i);
		expect(feedback).toHaveTextContent(/previous secret may no longer work/i);
		expect(screen.queryByText(/previous secret is still valid/i)).not.toBeInTheDocument();
		expect(api.rotateQuiWebhookSecret).toHaveBeenCalledTimes(1);
		expect(api.registerQuiWebhook).not.toHaveBeenCalled();
		expect(screen.getByLabelText(/Query-param secret/)).not.toHaveValue("synthetic-new-secret");
	});
	it("cancels before mutation and preserves the confirmed success display on a later explicit rotation", async () => {
		vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true);
		const view = mount();
		await screen.findByDisplayValue("http://callback.example/webhook");
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		expect(api.rotateQuiWebhookSecret).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		await screen.findByDisplayValue("synthetic-new-secret");
		expect(api.rotateQuiWebhookSecret).toHaveBeenCalledTimes(1);
		expect(api.registerQuiWebhook).not.toHaveBeenCalled();
		for (let i = 0; i < localStorage.length; i++) {
			expect(localStorage.getItem(localStorage.key(i)!)).not.toContain("synthetic-new-secret");
		}
		view.unmount();
		mount();
		await waitFor(() =>
			expect(screen.getByLabelText(/Query-param secret/)).not.toHaveValue("synthetic-new-secret"),
		);
	});
	it("registers only after confirmed rotation and explicit instance selection", async () => {
		vi.mocked(servicesApi.fetchServices).mockResolvedValue([
			{
				id: "qui-1",
				service: "qui",
				label: "Example qUI",
				baseUrl: "http://qui.example",
				externalUrl: null,
				enabled: true,
				isDefault: false,
				hasApiKey: true,
				storageGroupId: null,
				hasLocalFilesystemAccess: false,
				pathPrefix: null,
				identity: {
					status: "unverified",
					kind: null,
					fingerprint: null,
					verifiedAt: null,
					lastCheckedAt: null,
				},
				createdAt: "2026-09-28T00:00:00.000Z",
				updatedAt: "2026-09-28T00:00:00.000Z",
				tags: [],
			},
		]);
		vi.mocked(api.registerQuiWebhook).mockResolvedValue({ ok: true, quiTargetId: 42 });
		mount();
		await screen.findByRole("radio");
		expect(screen.getByRole("button", { name: "Register selected instance" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		await screen.findByDisplayValue("synthetic-new-secret");
		expect(api.registerQuiWebhook).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Register selected instance" })).toBeDisabled();
		fireEvent.click(screen.getByRole("radio"));
		fireEvent.click(screen.getByRole("button", { name: "Register selected instance" }));
		await screen.findByText(/Registered · #42/);
		expect(api.registerQuiWebhook).toHaveBeenCalledExactlyOnceWith({
			quiInstanceId: "qui-1",
			secret: "synthetic-new-secret",
		});
	});
});
