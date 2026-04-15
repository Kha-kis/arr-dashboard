/**
 * Pins the `/settings#<tab>` deep-link behaviour.
 *
 * Pulse items (e.g. validation-health) deep-link to `/settings#system`
 * expecting to land on the System tab. Without this, the client mounts
 * on the default Services tab and the operator has to hunt — silently
 * eroding the trust that action links point where they claim.
 *
 * We mock every child tab + data hook to a stub so this test only
 * exercises the hash → activeTab wiring.
 */

import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// --- Stub every hook the SettingsClient touches -----------------------------
vi.mock("../../../../hooks/api/useAuth", () => ({
	useCurrentUser: () => ({ data: { id: "u1", email: "op@example.com" } }),
}));
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../../../hooks/api/useTags", () => ({
	useTagsQuery: () => ({ data: [] }),
}));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: "" }),
}));
vi.mock("../../hooks", () => ({
	useServiceFormState: () => ({
		formState: {},
		selectedServiceForEdit: null,
		resetForm: vi.fn(),
		handleEdit: vi.fn(),
	}),
	useServicesManagement: () => ({
		handleSubmit: vi.fn(),
		handleTestConnection: vi.fn(),
		handleTestFormConnection: vi.fn(),
		handleDeleteService: vi.fn(),
		toggleDefault: vi.fn(),
		toggleEnabled: vi.fn(),
		resetFormTestResult: vi.fn(),
		testingConnection: null,
		testingFormConnection: false,
		testResult: null,
		formTestResult: null,
		createServiceMutation: { isPending: false },
		updateServiceMutation: { isPending: false },
	}),
	useTagsManagement: () => ({}),
	useAccountManagement: () => ({}),
}));

// --- Stub every child tab so we don't pull in their deps --------------------
// Factories are inline because vi.mock hoists above any module-scope helpers.
vi.mock("../services-tab", () => ({
	ServicesTab: () => <div data-testid="tab-services">services</div>,
}));
vi.mock("../tags-tab", () => ({ TagsTab: () => <div data-testid="tab-tags">tags</div> }));
vi.mock("../account-tab", () => ({
	AccountTab: () => <div data-testid="tab-account">account</div>,
}));
vi.mock("../appearance-tab", () => ({
	AppearanceTab: () => <div data-testid="tab-appearance">appearance</div>,
}));
vi.mock("../backup-tab", () => ({
	BackupTab: () => <div data-testid="tab-backup">backup</div>,
}));
vi.mock("../system-tab", () => ({
	SystemTab: () => <div data-testid="tab-system">system</div>,
}));
vi.mock("../../../notifications/components/notifications-tab", () => ({
	NotificationsTab: () => <div data-testid="tab-notifications">notifications</div>,
}));
vi.mock("../oidc-provider-section", () => ({ OIDCProviderSection: () => <div /> }));
vi.mock("../passkey-section", () => ({ PasskeySection: () => <div /> }));
vi.mock("../password-section", () => ({ PasswordSection: () => <div /> }));
vi.mock("../getting-started-banner", () => ({ GettingStartedBanner: () => <div /> }));
vi.mock("../service-form", () => ({ ServiceForm: () => <div /> }));
vi.mock("../sessions-section", () => ({ SessionsSection: () => <div /> }));
vi.mock("../../../../components/layout", () => ({
	PremiumPageHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	PremiumPageLoading: () => <div>loading</div>,
	PremiumTabs: () => <div />,
}));

import { SettingsClient } from "../settings-client";

describe("SettingsClient — URL hash deep-link", () => {
	beforeEach(() => {
		window.location.hash = "";
	});

	it("defaults to the services tab when no hash is present", () => {
		const { queryByTestId } = render(<SettingsClient />);
		expect(queryByTestId("tab-services")).not.toBeNull();
		expect(queryByTestId("tab-system")).toBeNull();
	});

	it("selects the System tab when hash is #system (validation-health Pulse link)", () => {
		window.location.hash = "#system";
		const { queryByTestId } = render(<SettingsClient />);
		expect(queryByTestId("tab-system")).not.toBeNull();
		expect(queryByTestId("tab-services")).toBeNull();
	});

	it("ignores an unknown hash and falls back to the default tab", () => {
		window.location.hash = "#not-a-tab";
		const { queryByTestId } = render(<SettingsClient />);
		expect(queryByTestId("tab-services")).not.toBeNull();
	});
});
