import type { AutomationRulesResponse, NotificationRuleResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

const createMutate = vi.fn().mockResolvedValue({});
const updateMutate = vi.fn().mockResolvedValue({});
let automationData: AutomationRulesResponse = { rules: [] };
let notificationRules: NotificationRuleResponse[] = [];

vi.mock("@/hooks/api/useNotifications", () => ({
	useNotificationRules: () => ({ data: notificationRules }),
	useNotificationChannels: () => ({
		data: [
			{ id: "channel-1", name: "Discord", type: "DISCORD", enabled: true },
			{ id: "channel-2", name: "Telegram", type: "TELEGRAM", enabled: true },
		],
	}),
	useCreateRule: () => ({ mutateAsync: createMutate, isPending: false }),
	useUpdateRule: () => ({ mutateAsync: updateMutate, isPending: false }),
}));

vi.mock("@/hooks/api/useAutomation", () => ({
	useAutomationRules: () => ({ data: automationData }),
}));

vi.mock("@/hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#3b82f6", to: "#8b5cf6", fromLight: "#3b82f610" },
	}),
}));

vi.mock("@/lib/theme-input-styles", () => ({
	getInputStyles: () => ({ base: "test-input", applyFocus: vi.fn(), removeFocus: vi.fn() }),
}));

import { NotificationRuleComposerDialog } from "../notification-rule-composer-dialog";

function wrapper(ui: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<IncognitoProvider>{ui}</IncognitoProvider>
		</QueryClientProvider>,
	);
}

function notificationRule(
	overrides: Partial<NotificationRuleResponse> = {},
): NotificationRuleResponse {
	return {
		id: "notification-1",
		name: "Route failures",
		enabled: false,
		priority: 17,
		action: "route",
		conditions: [],
		targetChannelIds: ["channel-2"],
		throttleMinutes: null,
		quietHoursStart: null,
		quietHoursEnd: null,
		quietHoursTimezone: null,
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	createMutate.mockClear();
	updateMutate.mockClear();
	automationData = { rules: [] };
	notificationRules = [];
});

describe("NotificationRuleComposerDialog — create", () => {
	it("creates a throttle rule through the flat field-match write path", async () => {
		wrapper(<NotificationRuleComposerDialog open onOpenChange={() => {}} />);

		fireEvent.change(screen.getByPlaceholderText(/route failed hunts/i), {
			target: { value: "Throttle hunt completions" },
		});
		fireEvent.change(screen.getByLabelText("Condition 1 value"), {
			target: { value: "HUNT_COMPLETED" },
		});
		fireEvent.change(screen.getByLabelText("Action"), { target: { value: "throttle" } });
		fireEvent.change(screen.getByLabelText(/minimum minutes/i), { target: { value: "45" } });
		fireEvent.click(screen.getByRole("button", { name: /create rule/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
		expect(createMutate).toHaveBeenCalledWith({
			name: "Throttle hunt completions",
			enabled: true,
			priority: 0,
			action: "throttle",
			conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			throttleMinutes: 45,
		});
	});

	it("creates quiet hours with the complete time-window action payload", async () => {
		wrapper(<NotificationRuleComposerDialog open onOpenChange={() => {}} />);

		fireEvent.change(screen.getByPlaceholderText(/route failed hunts/i), {
			target: { value: "Overnight quiet hours" },
		});
		fireEvent.change(screen.getByLabelText("Condition 1 value"), {
			target: { value: "SYSTEM_STARTUP" },
		});
		fireEvent.change(screen.getByLabelText("Action"), { target: { value: "quiet_hours" } });
		fireEvent.change(screen.getByLabelText("Start"), { target: { value: "23:15" } });
		fireEvent.change(screen.getByLabelText("End"), { target: { value: "06:45" } });
		fireEvent.change(screen.getByLabelText("Timezone"), {
			target: { value: "America/Chicago" },
		});
		fireEvent.click(screen.getByRole("button", { name: /create rule/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
		expect(createMutate).toHaveBeenCalledWith({
			name: "Overnight quiet hours",
			enabled: true,
			priority: 0,
			action: "quiet_hours",
			conditions: [{ field: "eventType", operator: "equals", value: "SYSTEM_STARTUP" }],
			quietHoursStart: "23:15",
			quietHoursEnd: "06:45",
			quietHoursTimezone: "America/Chicago",
		});
	});
});

describe("NotificationRuleComposerDialog — edit", () => {
	beforeEach(() => {
		automationData = {
			rules: [
				{
					id: "notification-1",
					name: "Route failures",
					enabled: false,
					context: "notifications",
					document: {
						version: 1,
						root: {
							all: [
								{
									kind: "field_match",
									params: {
										field: "eventType",
										operator: "in",
										value: ["HUNT_FAILED", "TRASH_DEPLOY_FAILED"],
									},
								},
								{
									kind: "field_match",
									params: { field: "title", operator: "contains", value: "failed" },
								},
							],
						},
					},
					unavailableKinds: [],
					unparseable: false,
				},
			],
		};
		notificationRules = [notificationRule()];
	});

	it("prefills both joined halves and echoes defaulted enabled/priority fields on PUT", async () => {
		wrapper(
			<NotificationRuleComposerDialog open onOpenChange={() => {}} editRuleId="notification-1" />,
		);

		expect(await screen.findByDisplayValue("Route failures")).toBeTruthy();
		expect(screen.getByDisplayValue("17")).toBeTruthy();
		expect(screen.getByDisplayValue("HUNT_FAILED, TRASH_DEPLOY_FAILED")).toBeTruthy();
		expect(screen.getByDisplayValue("failed")).toBeTruthy();
		expect(screen.getByLabelText("Telegram")).toBeChecked();

		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

		await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
		expect(updateMutate).toHaveBeenCalledWith({
			id: "notification-1",
			data: {
				name: "Route failures",
				enabled: false,
				priority: 17,
				action: "route",
				conditions: [
					{
						field: "eventType",
						operator: "in",
						value: ["HUNT_FAILED", "TRASH_DEPLOY_FAILED"],
					},
					{ field: "title", operator: "contains", value: "failed" },
				],
				targetChannelIds: ["channel-2"],
			},
		});
	});

	it("blocks the form until both edit sources resolve", async () => {
		notificationRules = [];
		wrapper(
			<NotificationRuleComposerDialog open onOpenChange={() => {}} editRuleId="notification-1" />,
		);
		expect(await screen.findByText(/loading rule/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
		expect(updateMutate).not.toHaveBeenCalled();
	});
});
