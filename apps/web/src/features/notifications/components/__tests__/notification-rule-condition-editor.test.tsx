import {
	type CreateNotificationRule,
	createNotificationRuleSchema,
	type NotificationRuleResponse,
	type RuleCondition,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuleEngine } from "../../../../../../api/src/lib/notifications/rule-engine";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationRulesTab } from "../notification-rules-tab";

const original: NotificationRuleResponse = {
	id: "synthetic-rule",
	name: "Synthetic condition rule",
	enabled: true,
	priority: 4,
	action: "suppress",
	conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
	targetChannelIds: null,
	throttleMinutes: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};
const event = {
	eventType: "HUNT_COMPLETED" as const,
	title: "Synthetic completed hunt",
	body: "Synthetic body",
	metadata: { count: 7, "literal.key": "literal, member" },
};
const clients: QueryClient[] = [];
const violations: string[] = [];

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function PrivacyControl() {
	const [mode, setMode] = useIncognitoMode();
	return (
		<button type="button" onClick={() => setMode(!mode)}>
			Toggle privacy
		</button>
	);
}

// The only substitutes are external HTTP and jsdom's absent matchMedia API.
// RulesTab, providers, query hooks, API client and engine matching stay real.
function mount(
	conditions: RuleCondition[] = original.conditions,
	options: { create?: boolean; rejectFirstWrite?: boolean } = {},
) {
	let rules = options.create ? [] : [{ ...original, conditions }];
	const writes: Array<{ method: string; path: string; payload: CreateNotificationRule }> = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		const method = init.method ?? "GET";
		if (init.credentials !== "include" || "expectedSuccessStatus" in init) {
			violations.push("Unexpected wire options");
			throw new Error("Unexpected wire options");
		}
		if (method === "GET" && init.body === undefined) {
			if (path === "/api/notifications/channels") return json([]);
			if (path === "/api/notifications/rules") return json(rules);
		}
		const expectedMethod = options.create ? "POST" : "PUT";
		const expectedPath = options.create
			? "/api/notifications/rules"
			: "/api/notifications/rules/synthetic-rule";
		if (
			method !== expectedMethod ||
			path !== expectedPath ||
			new Headers(init.headers).get("Content-Type") !== "application/json" ||
			typeof init.body !== "string"
		) {
			violations.push(`${method} ${path}`);
			throw new Error("Unexpected condition-editor HTTP edge");
		}
		const payload = JSON.parse(init.body) as CreateNotificationRule;
		if (!createNotificationRuleSchema.safeParse(payload).success) {
			violations.push("Request violates actual shared rule contract");
			return json({ message: "Invalid synthetic request" }, 400);
		}
		writes.push({ method, path, payload });
		if (options.rejectFirstWrite && writes.length === 1) {
			return json({ message: "Synthetic rule save rejected" }, 409);
		}
		const confirmed = { ...original, ...payload };
		rules = [confirmed];
		return json(confirmed, options.create ? 201 : 200);
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<PrivacyControl />
					<NotificationRulesTab />
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { writes, client };
}

async function edit() {
	fireEvent.click(await screen.findByTitle("Edit rule"));
	await screen.findByRole("button", { name: "Update Rule" });
}

async function save(wire: ReturnType<typeof mount>, count = 1, create = false) {
	fireEvent.click(screen.getByRole("button", { name: create ? "Create Rule" : "Update Rule" }));
	await waitFor(() => {
		expect(wire.writes).toHaveLength(count);
		const mutation = wire.client.getMutationCache().getAll().at(-1);
		expect(["success", "error"]).toContain(mutation?.state.status);
	});
	return wire.writes[count - 1]!.payload;
}

beforeEach(() => {
	localStorage.clear();
	toast.dismiss();
	vi.stubGlobal("matchMedia", (media: string) => ({
		media,
		matches: false,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	}));
});

afterEach(() => {
	cleanup();
	toast.dismiss();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	expect(violations.splice(0)).toEqual([]);
});

describe("stored condition representation", () => {
	it.each(["metadata.literal.key", "custom.absent.field"])(
		"shows the stored %s field when opening its editor",
		async (field) => {
			mount([{ field, operator: "equals", value: "literal, member" }]);
			await edit();
			expect(screen.getByLabelText("Condition field")).toHaveValue(field);
		},
	);

	it("shows the stored greater_than operator when opening its editor", async () => {
		mount([{ field: "title", operator: "greater_than", value: 3 }]);
		await edit();
		expect(screen.getByLabelText("Condition operator")).toHaveValue("greater_than");
	});
});

describe("membership request compatibility", () => {
	it.each(["new", "existing"] as const)(
		"saves an edited %s membership condition as an array that matches the real engine",
		async (kind) => {
			const wire = mount([{ field: "eventType", operator: "in", value: ["HUNT_FAILED"] }], {
				create: kind === "new",
			});
			if (kind === "new") {
				fireEvent.click(await screen.findByRole("button", { name: "Add your first rule" }));
				fireEvent.change(screen.getByLabelText("Rule name"), {
					target: { value: "Synthetic membership rule" },
				});
				fireEvent.change(screen.getByLabelText("Condition operator"), {
					target: { value: "in" },
				});
			} else {
				await edit();
			}
			fireEvent.change(screen.getByLabelText("List value"), {
				target: { value: "HUNT_COMPLETED" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Add value" }));
			fireEvent.change(screen.getAllByLabelText("List value")[1]!, {
				target: { value: "HUNT_FAILED" },
			});
			const payload = await save(wire, 1, kind === "new");
			expect
				.soft(payload.conditions)
				.toEqual([
					{ field: "eventType", operator: "in", value: ["HUNT_COMPLETED", "HUNT_FAILED"] },
				]);
			expect(
				new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
			).toMatchObject({ action: "suppress", ruleId: "synthetic-rule" });
		},
	);
});

const historical = [
	{ field: "metadata.literal.key", operator: "equals", value: " literal, member " },
	{ field: "metadata.count", operator: "greater_than", value: 0 },
	{
		field: "title",
		operator: "in",
		value: ["literal, member", " spaced ", "", "duplicate", "duplicate"],
	},
	{ field: "custom.absent.field", operator: "in", value: "legacy,scalar" },
	{ field: "custom.absent.field", operator: "in", value: 0 },
] satisfies RuleCondition[];

describe("untouched literal preservation controls", () => {
	it.each(["ordinary save", "privacy round trip", "unrelated draft edit"])(
		"preserves exact historical string, number and array payloads after %s",
		async (interaction) => {
			const wire = mount(historical);
			await edit();
			if (interaction === "privacy round trip") {
				fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
				expect(screen.getByRole("button", { name: "Update Rule" })).toBeDisabled();
				fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
			}
			if (interaction === "unrelated draft edit") {
				fireEvent.change(screen.getByLabelText("Rule name"), {
					target: { value: "Synthetic renamed rule" },
				});
			}
			const payload = await save(wire);
			expect(payload.conditions).toEqual([
				{ field: "metadata.literal.key", operator: "equals", value: " literal, member " },
				{ field: "metadata.count", operator: "greater_than", value: 0 },
				{
					field: "title",
					operator: "in",
					value: ["literal, member", " spaced ", "", "duplicate", "duplicate"],
				},
				{ field: "custom.absent.field", operator: "in", value: "legacy,scalar" },
				{ field: "custom.absent.field", operator: "in", value: 0 },
			]);
			// Arbitrary absent fields remain nonmatching, rather than becoming eventType.
			expect(
				new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
			).toBeNull();
		},
	);

	it("retains exact untouched literals across a rejected save and explicit retry", async () => {
		const wire = mount(historical, { rejectFirstWrite: true });
		await edit();
		await save(wire);
		await screen.findByText("Synthetic rule save rejected");
		expect(screen.getByRole("button", { name: "Update Rule" })).toBeEnabled();
		const payload = await save(wire, 2);
		expect(payload.conditions).toEqual([
			{ field: "metadata.literal.key", operator: "equals", value: " literal, member " },
			{ field: "metadata.count", operator: "greater_than", value: 0 },
			{
				field: "title",
				operator: "in",
				value: ["literal, member", " spaced ", "", "duplicate", "duplicate"],
			},
			{ field: "custom.absent.field", operator: "in", value: "legacy,scalar" },
			{ field: "custom.absent.field", operator: "in", value: 0 },
		]);
	});
});

describe("untouched blank condition request preservation", () => {
	it.each([
		{ label: "empty string", operator: "equals", value: "" },
		{ label: "whitespace string", operator: "equals", value: "   " },
		{ label: "empty array", operator: "in", value: [] },
		{ label: "empty member array", operator: "in", value: [""] },
		{ label: "whitespace member array", operator: "in", value: ["   "] },
	] satisfies Array<{
		label: string;
		operator: RuleCondition["operator"];
		value: RuleCondition["value"];
	}>)(
		"keeps a stored $label condition alongside its sibling on ordinary save",
		async ({ operator, value }) => {
			const wire = mount([
				{ field: "title", operator, value },
				{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			]);
			await edit();
			const payload = await save(wire);
			expect(payload.conditions).toEqual([
				{ field: "title", operator, value },
				{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			]);
		},
	);
});

describe("ordinary operator and actual engine controls", () => {
	it.each([
		{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
		{ field: "eventType", operator: "not_equals", value: "HUNT_FAILED" },
		{ field: "title", operator: "contains", value: "COMPLETED" },
		{ field: "eventType", operator: "in", value: ["HUNT_COMPLETED", "HUNT_FAILED"] },
	] satisfies RuleCondition[])(
		"saves and matches untouched $operator conditions",
		async (condition) => {
			const wire = mount([condition]);
			await edit();
			expect(screen.getByLabelText("Condition field")).toHaveValue(condition.field);
			expect(screen.getByLabelText("Condition operator")).toHaveValue(condition.operator);
			const payload = await save(wire);
			expect(payload.conditions).toEqual([condition]);
			expect(
				new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
			).toMatchObject({ action: "suppress", ruleId: "synthetic-rule" });
		},
	);
});

async function create() {
	fireEvent.click(await screen.findByRole("button", { name: "Add your first rule" }));
	fireEvent.change(screen.getByLabelText("Rule name"), {
		target: { value: "Synthetic typed rule" },
	});
}

function selectType(value: "text" | "number" | "list", index = 0) {
	fireEvent.change(screen.getAllByLabelText("Value type")[index]!, { target: { value } });
}

describe("explicit field and typed value editing", () => {
	it("creates a metadata numeric rule that matches the actual engine", async () => {
		const wire = mount(undefined, { create: true });
		await create();
		fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: "" } });
		fireEvent.change(screen.getByLabelText("Field path"), {
			target: { value: "metadata.count" },
		});
		fireEvent.change(screen.getByLabelText("Condition operator"), {
			target: { value: "greater_than" },
		});
		selectType("number");
		fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "3" } });
		const payload = await save(wire, 1, true);
		expect(wire.writes[0]).toMatchObject({ method: "POST", path: "/api/notifications/rules" });
		expect(payload.conditions).toEqual([
			{ field: "metadata.count", operator: "greater_than", value: 3 },
		]);
		expect(
			new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
		).toMatchObject({ action: "suppress", ruleId: "synthetic-rule" });
	});

	it.each(["", "   ", "NaN", "Infinity", "3e", "."])(
		"blocks invalid numeric draft %j without losing sibling conditions and recovers on edit",
		async (raw) => {
			const wire = mount([
				{ field: "metadata.count", operator: "greater_than", value: 1 },
				{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			]);
			await edit();
			expect(screen.getAllByLabelText("Value type")[0]).toHaveValue("number");
			fireEvent.change(screen.getAllByLabelText("Condition value")[0]!, { target: { value: raw } });
			fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
			expect(await screen.findByRole("alert")).toHaveTextContent(/condition/i);
			expect(wire.writes).toEqual([]);
			expect(screen.getAllByLabelText("Condition value")[0]).toHaveValue(raw);
			fireEvent.change(screen.getAllByLabelText("Condition value")[0]!, {
				target: { value: "2.5" },
			});
			const payload = await save(wire);
			expect(wire.writes[0]).toMatchObject({
				method: "PUT",
				path: "/api/notifications/rules/synthetic-rule",
			});
			expect(payload.conditions).toEqual([
				{ field: "metadata.count", operator: "greater_than", value: 2.5 },
				{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			]);
			expect(
				new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
			).toMatchObject({ action: "suppress", ruleId: "synthetic-rule" });
		},
	);

	it("edits a literal custom field without remapping absent fields", async () => {
		const wire = mount([{ field: "custom.old.field", operator: "equals", value: "literal" }]);
		await edit();
		expect(screen.getByLabelText("Field path")).toHaveValue("custom.old.field");
		fireEvent.change(screen.getByLabelText("Field path"), {
			target: { value: "custom.new.field" },
		});
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "custom.new.field", operator: "equals", value: "literal" },
		]);
		expect(
			new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
		).toBeNull();
	});

	it("blocks a missing field as a whole and retains the editable draft", async () => {
		const wire = mount();
		await edit();
		fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/condition/i);
		expect(wire.writes).toEqual([]);
		fireEvent.change(screen.getByLabelText("Field path"), {
			target: { value: "metadata.literal.key" },
		});
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "metadata.literal.key", operator: "equals", value: "HUNT_COMPLETED" },
		]);
	});
});

describe("literal list entries and explicit representation transitions", () => {
	it("edits comma, whitespace, duplicate and empty members without normalizing them", async () => {
		const wire = mount([{ field: "metadata.literal.key", operator: "in", value: ["old", "old"] }]);
		await edit();
		fireEvent.change(screen.getAllByLabelText("List value")[0]!, {
			target: { value: "literal, member" },
		});
		fireEvent.change(screen.getAllByLabelText("List value")[1]!, { target: { value: " spaced " } });
		fireEvent.click(screen.getByRole("button", { name: "Add value" }));
		fireEvent.click(screen.getByRole("button", { name: "Add value" }));
		fireEvent.change(screen.getAllByLabelText("List value")[3]!, {
			target: { value: "literal, member" },
		});
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{
				field: "metadata.literal.key",
				operator: "in",
				value: ["literal, member", " spaced ", "", "literal, member"],
			},
		]);
		expect(
			new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
		).toMatchObject({ action: "suppress", ruleId: "synthetic-rule" });
	});

	it("keeps a surviving list entry focused when an earlier entry is removed", async () => {
		const wire = mount([{ field: "title", operator: "in", value: ["first", "second", "third"] }]);
		await edit();
		const surviving = screen.getAllByLabelText("List value")[1]!;
		surviving.focus();
		fireEvent.click(screen.getAllByRole("button", { name: "Remove value" })[0]!);
		expect(screen.getAllByLabelText("List value")[0]).toBe(surviving);
		expect(surviving).toHaveFocus();
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "title", operator: "in", value: ["second", "third"] },
		]);
	});

	it("saves an explicitly emptied membership list without removing its condition", async () => {
		const wire = mount([{ field: "eventType", operator: "in", value: ["HUNT_COMPLETED"] }]);
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "Remove value" }));
		expect(screen.getByText(/empty membership list matches nothing/i)).toBeInTheDocument();
		const payload = await save(wire);
		expect(payload.conditions).toEqual([{ field: "eventType", operator: "in", value: [] }]);
		expect(
			new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
		).toBeNull();
	});

	it("repairs legacy scalar membership only by explicit list conversion as one literal member", async () => {
		const wire = mount([
			{ field: "metadata.literal.key", operator: "in", value: "literal, member" },
		]);
		await edit();
		expect(screen.getByText(/scalar membership value does not match/i)).toBeInTheDocument();
		expect(screen.getByLabelText("Value type")).toHaveValue("text");
		selectType("list");
		expect(screen.getAllByLabelText("List value")).toHaveLength(1);
		expect(screen.getByLabelText("List value")).toHaveValue("literal, member");
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "metadata.literal.key", operator: "in", value: ["literal, member"] },
		]);
		expect(
			new RuleEngine().evaluate(event, [{ ...original, conditions: payload.conditions }]),
		).toMatchObject({ action: "suppress", ruleId: "synthetic-rule" });
	});

	it("selecting in converts scalar to one literal entry and changing operator keeps its list", async () => {
		const wire = mount([{ field: "title", operator: "equals", value: "first,second" }]);
		await edit();
		fireEvent.change(screen.getByLabelText("Condition operator"), { target: { value: "in" } });
		expect(screen.getByLabelText("List value")).toHaveValue("first,second");
		fireEvent.change(screen.getByLabelText("Condition operator"), {
			target: { value: "contains" },
		});
		expect(screen.getByLabelText("Value type")).toHaveValue("list");
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "title", operator: "contains", value: ["first,second"] },
		]);
	});

	it("converts list to text only on explicit value-type choice", async () => {
		const wire = mount([
			{ field: "title", operator: "equals", value: [" first ", "second,part", ""] },
		]);
		await edit();
		selectType("text");
		expect(screen.getByLabelText("Condition value")).toHaveValue(" first ,second,part,");
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "title", operator: "equals", value: " first ,second,part," },
		]);
	});

	it("keeps explicit list-to-number raw text invalid until corrected and text stays a string", async () => {
		const wire = mount([{ field: "metadata.count", operator: "greater_than", value: ["1", "2"] }]);
		await edit();
		selectType("number");
		expect(screen.getByLabelText("Condition value")).toHaveValue("1,2");
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/condition/i);
		expect(wire.writes).toEqual([]);
		fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "3" } });
		selectType("text");
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "metadata.count", operator: "greater_than", value: "3" },
		]);
	});
});

describe("new blank confirmation and private typed drafts", () => {
	it("blocks a new untouched row after field/operator changes until explicitly kept empty", async () => {
		const wire = mount();
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		fireEvent.change(screen.getAllByLabelText("Condition field")[1]!, {
			target: { value: "title" },
		});
		fireEvent.change(screen.getAllByLabelText("Condition operator")[1]!, {
			target: { value: "contains" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/condition/i);
		expect(wire.writes).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Keep empty value" }));
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			{ field: "title", operator: "contains", value: "" },
		]);
	});

	it("allows explicit removal of an incomplete new row without dropping other conditions", async () => {
		const wire = mount();
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		fireEvent.click(screen.getAllByTitle("Remove condition")[1]!);
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
		]);
	});

	it("masks field paths, list and numeric drafts, blocks private edits, and restores them exactly", async () => {
		const wire = mount([
			{
				field: "metadata.private-key",
				operator: "in",
				value: ["private,literal", " private-space "],
			},
			{ field: "metadata.private-count", operator: "greater_than", value: 9137 },
		]);
		await edit();
		const field = screen.getAllByLabelText("Field path")[0]!;
		const list = screen.getAllByLabelText("List value")[0]!;
		const numeric = screen.getByLabelText("Condition value");
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		const privateSurface =
			document.body.innerHTML +
			Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"))
				.map((control) => control.value)
				.join(" ");
		for (const marker of [
			"metadata.private-key",
			"metadata.private-count",
			"private,literal",
			" private-space ",
			"9137",
		])
			expect(privateSurface).not.toContain(marker);
		for (const control of [field, list, numeric]) expect(control).toBeDisabled();
		fireEvent.change(field, { target: { value: "custom.changed" } });
		fireEvent.change(list, { target: { value: "changed" } });
		fireEvent.change(numeric, { target: { value: "0" } });
		fireEvent.click(screen.getAllByRole("button", { name: "Add value" })[0]!);
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		expect(wire.writes).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		expect(field).toHaveValue("metadata.private-key");
		expect(list).toHaveValue("private,literal");
		expect(numeric).toHaveValue("9137");
		const payload = await save(wire);
		expect(payload.conditions).toEqual([
			{
				field: "metadata.private-key",
				operator: "in",
				value: ["private,literal", " private-space "],
			},
			{ field: "metadata.private-count", operator: "greater_than", value: 9137 },
		]);
	});
});
