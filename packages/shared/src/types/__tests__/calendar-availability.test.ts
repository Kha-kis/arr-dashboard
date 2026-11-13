import { describe, expect, it } from "vitest";
import { calendarItemSchema, multiInstanceCalendarResponseSchema } from "../dashboard.js";

const item = {
	id: 31,
	service: "sonarr",
	type: "episode",
	airDate: "2026-10-15",
	instanceId: "one",
	instanceName: "Synthetic",
};
const source = {
	instanceId: "one",
	instanceName: "Synthetic",
	service: "sonarr",
	data: [item],
	availability: "available",
	reason: null,
	rejectedItemCount: 0,
};
const envelope = {
	instances: [source],
	aggregated: [item],
	totalCount: 1,
	availability: "available",
};

describe("Calendar schedule evidence", () => {
	it("keeps the optional display schema separate from scheduled publication", () => {
		const { airDate: _date, ...undated } = item;
		expect(calendarItemSchema.safeParse(undated).success).toBe(true);
		expect(
			multiInstanceCalendarResponseSchema.safeParse({
				...envelope,
				instances: [{ ...source, data: [undated] }],
				aggregated: [undated],
			}).success,
		).toBe(false);
	});
	it.each([
		{ ...envelope, availability: undefined },
		{ ...envelope, instances: [{ ...source, availability: undefined }] },
		{ ...envelope, instances: [{ ...source, reason: undefined }] },
		{ ...envelope, instances: [{ ...source, rejectedItemCount: undefined }] },
		{ ...envelope, instances: [{ ...source, rejectedItemCount: -1 }] },
		{ ...envelope, instances: [{ ...source, rejectedItemCount: 0.5 }] },
		{ ...envelope, instances: [{ ...source, rejectedItemCount: Number.MAX_SAFE_INTEGER + 1 }] },
		{ ...envelope, instances: [{ ...source, reason: "provider-unavailable" }] },
		{
			...envelope,
			instances: [
				{ ...source, availability: "partial", reason: "invalid-items", rejectedItemCount: 0 },
			],
		},
		{
			...envelope,
			instances: [
				{ ...source, availability: "unavailable", reason: "invalid-items", rejectedItemCount: 1 },
			],
		},
		{ ...envelope, totalCount: 0 },
		{ ...envelope, availability: "partial" },
		{ ...envelope, aggregated: [{ ...item, id: 32 }] },
		{ ...envelope, instances: [{ ...source, instanceId: "other" }] },
		{ ...envelope, instances: [source, source], totalCount: 2, aggregated: [item, item] },
		{
			instances: [
				{
					...source,
					data: [],
					availability: "partial",
					reason: "invalid-items",
					rejectedItemCount: 1,
				},
			],
			aggregated: [],
			totalCount: 0,
			availability: "partial",
		},
		{
			instances: [{ ...source, data: [], availability: "unavailable", reason: null }],
			aggregated: [],
			totalCount: 0,
			availability: "unavailable",
		},
		{
			instances: [
				{
					...source,
					data: [],
					availability: "unavailable",
					reason: "provider-unavailable",
					rejectedItemCount: 1,
				},
			],
			aggregated: [],
			totalCount: 0,
			availability: "unavailable",
		},
		{
			instances: [{ ...source, data: [], availability: "unavailable", reason: "invalid-items" }],
			aggregated: [],
			totalCount: 0,
			availability: "unavailable",
		},
	])("rejects missing or inconsistent source evidence %#", (value) => {
		expect(multiInstanceCalendarResponseSchema.safeParse(value).success).toBe(false);
	});
	it.each([
		{ instances: [], aggregated: [], totalCount: 0, availability: "not-configured" },
		{
			instances: [{ ...source, data: [] }],
			aggregated: [],
			totalCount: 0,
			availability: "available",
		},
		{
			...envelope,
			availability: "partial",
			instances: [
				{ ...source, availability: "partial", reason: "invalid-items", rejectedItemCount: 1 },
			],
		},
		{
			instances: [{ ...source, data: [], availability: "unavailable", reason: "invalid-response" }],
			aggregated: [],
			totalCount: 0,
			availability: "unavailable",
		},
		{
			instances: [
				{
					...source,
					data: [],
					availability: "unavailable",
					reason: "invalid-items",
					rejectedItemCount: 2,
				},
			],
			aggregated: [],
			totalCount: 0,
			availability: "unavailable",
		},
	])("accepts literal valid evidence %#", (value) => {
		expect(multiInstanceCalendarResponseSchema.safeParse(value).success).toBe(true);
	});
	it("requires partial aggregate for healthy-empty plus unavailable", () => {
		const mixed = {
			instances: [
				{ ...source, data: [] },
				{
					...source,
					instanceId: "two",
					data: [],
					availability: "unavailable",
					reason: "provider-unavailable",
				},
			],
			aggregated: [],
			totalCount: 0,
			availability: "partial",
		};
		expect(multiInstanceCalendarResponseSchema.safeParse(mixed).success).toBe(true);
		expect(
			multiInstanceCalendarResponseSchema.safeParse({ ...mixed, availability: "available" })
				.success,
		).toBe(false);
	});
	it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, "", "   "])(
		"rejects unstable scheduled identity %s",
		(id) => {
			const bad = { ...item, id };
			expect(
				multiInstanceCalendarResponseSchema.safeParse({
					...envelope,
					instances: [{ ...source, data: [bad] }],
					aggregated: [bad],
				}).success,
			).toBe(false);
		},
	);
	it.each(["2026-02-30", "2026-13-01", "2025-02-29", "not-a-date", "2026-10-15T99:00:00Z"])(
		"rejects impossible schedule %s",
		(airDate) => {
			const bad = { ...item, airDate };
			expect(
				multiInstanceCalendarResponseSchema.safeParse({
					...envelope,
					instances: [{ ...source, data: [bad] }],
					aggregated: [bad],
				}).success,
			).toBe(false);
		},
	);
});
