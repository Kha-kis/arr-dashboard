import type { ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ApiError } from "../../../../lib/api-client/base";
import { serviceKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { useServicesManagement } from "../../hooks/use-services-management";
import { defaultFormState, type ServiceFormState } from "../../lib/settings-utils";
import { ServiceForm } from "../service-form";
import { ServiceInstanceCard } from "../service-instance-card";

vi.mock("../../../../lib/api-client/services");

import * as api from "../../../../lib/api-client/services";

const candidate = {
	service: "JELLYFIN" as const,
	identityKind: "jellyfin-server-id",
	fingerprint: "7a9c6d3e1f20",
	confirmationDigest: "a".repeat(64),
};
const baseService: ServiceInstanceSummary = {
	id: "jellyfin-1",
	service: "jellyfin",
	label: "Library Server",
	baseUrl: "http://jellyfin.test",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	hasHttpAuth: false,
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
	createdAt: "2026-08-14T00:00:00.000Z",
	updatedAt: "2026-08-14T00:00:00.000Z",
	tags: [],
};

function Fixture({ fallback = baseService }: { fallback?: ServiceInstanceSummary }) {
	const management = useServicesManagement();
	const { data = [] } = useQuery({
		queryKey: serviceKeys.all,
		queryFn: async (): Promise<ServiceInstanceSummary[]> => [],
		enabled: false,
	});
	const service = data[0] ?? fallback;
	const [form, setForm] = useState<ServiceFormState>({
		...defaultFormState(service.service),
		label: service.label,
		baseUrl: service.baseUrl,
		apiKey: "",
	});
	return (
		<>
			<ServiceInstanceCard
				instance={service}
				onTestConnection={vi.fn()}
				onEdit={vi.fn()}
				onToggleDefault={vi.fn()}
				onToggleEnabled={vi.fn()}
				onDelete={vi.fn()}
				onInspectIdentity={management.inspectIdentity}
				isTesting={false}
				mutationPending={false}
			/>
			<ServiceForm
				formState={form}
				onFormStateChange={(updater) => setForm(updater)}
				onSubmit={(event) => {
					event.preventDefault();
					void management.handleSubmit(form, service, vi.fn());
				}}
				onCancel={vi.fn()}
				onTestConnection={vi.fn()}
				selectedService={service}
				services={data}
				availableTags={[]}
				isCreating={false}
				isUpdating={false}
				isTesting={false}
				identityFlow={management.identityFlow}
				onConfirmIdentity={() => void management.confirmIdentity()}
				onDismissIdentityFlow={management.dismissIdentityFlow}
				onInspectIdentity={() => void management.inspectIdentity(service)}
			/>
		</>
	);
}

function renderFixture(service = baseService) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	client.setQueryData(serviceKeys.all, [service]);
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<Fixture fallback={service} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

describe("provider identity rendered administrator flow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
	});

	it("inspects an unverified card then confirms a safe candidate into rendered verified state", async () => {
		vi.mocked(api.inspectServiceIdentity).mockResolvedValue({
			candidate,
			connectionGeneration: 4,
			identityGeneration: 2,
		});
		vi.mocked(api.verifyServiceIdentity).mockResolvedValue({
			...baseService,
			identity: {
				status: "verified",
				kind: candidate.identityKind,
				fingerprint: candidate.fingerprint,
				verifiedAt: "2026-08-14T01:00:00.000Z",
				lastCheckedAt: "2026-08-14T01:00:00.000Z",
			},
		});
		const { container } = renderFixture();
		fireEvent.click(screen.getByRole("button", { name: /verify identity/i }));
		await screen.findByText(/Candidate: jellyfin-server-id/);
		fireEvent.click(screen.getByRole("button", { name: /confirm verification/i }));
		await waitFor(() =>
			expect(screen.getByText(/Verified jellyfin-server-id/i)).toBeInTheDocument(),
		);
		expect(container.textContent).not.toContain("raw-server-id");
		expect(container.textContent).not.toContain("submitted-api-key");
	});

	it("keeps staged fields through a replacement conflict and requires explicit replacement", async () => {
		vi.mocked(api.updateService).mockRejectedValue(
			new ApiError("replace", 409, {
				details: {
					code: "IDENTITY_REPLACEMENT_REQUIRED",
					candidate,
					connectionGeneration: 4,
					identityGeneration: 2,
				},
			}),
		);
		vi.mocked(api.replaceServiceIdentity).mockResolvedValue({
			...baseService,
			label: "Staged label",
			identity: {
				status: "verified",
				kind: candidate.identityKind,
				fingerprint: candidate.fingerprint,
				verifiedAt: "2026-08-14T01:00:00.000Z",
				lastCheckedAt: "2026-08-14T01:00:00.000Z",
			},
		});
		const { container } = renderFixture();
		fireEvent.change(document.getElementById("service-label")!, {
			target: { value: "Staged label" },
		});
		fireEvent.submit(screen.getByRole("button", { name: /save changes/i }).closest("form")!);
		await screen.findByRole("button", { name: /confirm replacement/i });
		expect(document.getElementById("service-label")).toHaveValue("Staged label");
		fireEvent.click(screen.getByRole("button", { name: /confirm replacement/i }));
		await waitFor(() =>
			expect(screen.getByText(/Verified jellyfin-server-id/i)).toBeInTheDocument(),
		);
		expect(container.textContent).not.toContain("submitted-api-key");
	});

	it("renders mismatch before inspecting and explicitly replaces it with a verified provider", async () => {
		const mismatched = {
			...baseService,
			identity: { ...baseService.identity, status: "mismatch" as const },
		};
		vi.mocked(api.inspectServiceIdentity).mockResolvedValue({
			candidate,
			connectionGeneration: 4,
			identityGeneration: 2,
		});
		vi.mocked(api.replaceServiceIdentity).mockResolvedValue({
			...mismatched,
			identity: {
				status: "verified",
				kind: candidate.identityKind,
				fingerprint: candidate.fingerprint,
				verifiedAt: "2026-08-14T01:00:00.000Z",
				lastCheckedAt: "2026-08-14T01:00:00.000Z",
			},
		});
		renderFixture(mismatched);
		expect(screen.getByText(/Provider identity mismatch/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /verify identity/i }));
		await screen.findByRole("button", { name: /confirm replacement/i });
		fireEvent.click(screen.getByRole("button", { name: /confirm replacement/i }));
		await waitFor(() =>
			expect(screen.getByText(/Verified jellyfin-server-id/i)).toBeInTheDocument(),
		);
	});

	it("keeps submitted API and proxy credentials out of replacement confirmation and status text", async () => {
		const tautulli = { ...baseService, id: "tautulli-1", service: "tautulli" as const };
		const tautulliCandidate = {
			service: "TAUTULLI" as const,
			identityKind: "tautulli-pms-identifier",
			fingerprint: "222222222222",
			confirmationDigest: "c".repeat(64),
		};
		const apiKey = "submitted-api-key-unique";
		const username = "proxy-user-unique";
		const password = "proxy-password-unique";
		vi.mocked(api.updateService).mockRejectedValue(
			new ApiError("replace", 409, {
				details: {
					code: "IDENTITY_REPLACEMENT_REQUIRED",
					candidate: tautulliCandidate,
					connectionGeneration: 4,
					identityGeneration: 2,
				},
			}),
		);
		renderFixture(tautulli);
		fireEvent.change(document.getElementById("service-apikey")!, { target: { value: apiKey } });
		fireEvent.click(screen.getByLabelText(/Reverse proxy HTTP Basic Auth/i));
		fireEvent.change(document.getElementById("service-http-username")!, {
			target: { value: username },
		});
		fireEvent.change(document.getElementById("service-http-password")!, {
			target: { value: password },
		});
		fireEvent.submit(screen.getByRole("button", { name: /save changes/i }).closest("form")!);
		await screen.findByRole("button", { name: /confirm replacement/i });
		const rendered = document.body.textContent ?? "";
		expect(rendered).not.toContain(apiKey);
		expect(rendered).not.toContain(username);
		expect(rendered).not.toContain(password);
		expect(rendered).not.toContain("raw-upstream-identity-unique");
	});

	it.each(["IDENTITY_CANDIDATE_CHANGED", "IDENTITY_GENERATION_STALE"])(
		"blocks %s until reinspection without losing staged input",
		async (code) => {
			vi.mocked(api.inspectServiceIdentity)
				.mockResolvedValueOnce({ candidate, connectionGeneration: 4, identityGeneration: 2 })
				.mockResolvedValueOnce({
					candidate: {
						...candidate,
						fingerprint: "111111111111",
						confirmationDigest: "b".repeat(64),
					},
					connectionGeneration: 5,
					identityGeneration: 2,
				});
			vi.mocked(api.verifyServiceIdentity).mockRejectedValue(
				new ApiError("changed", 409, {
					details: { code, candidate, connectionGeneration: 5, identityGeneration: 2 },
				}),
			);
			renderFixture();
			fireEvent.change(document.getElementById("service-label")!, {
				target: { value: "Still staged" },
			});
			fireEvent.click(screen.getByRole("button", { name: /verify identity/i }));
			await screen.findByRole("button", { name: /confirm verification/i });
			fireEvent.click(screen.getByRole("button", { name: /confirm verification/i }));
			await screen.findByRole("button", { name: /inspect again/i });
			expect(screen.getByRole("button", { name: /confirm verification/i })).toBeDisabled();
			expect(document.getElementById("service-label")).toHaveValue("Still staged");
			fireEvent.click(screen.getByRole("button", { name: /inspect again/i }));
			await waitFor(() =>
				expect(screen.getByRole("button", { name: /confirm verification/i })).toBeEnabled(),
			);
			expect(document.getElementById("service-label")).toHaveValue("Still staged");
		},
	);
});
