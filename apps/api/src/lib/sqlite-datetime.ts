/** Match the installed Prisma adapter's UTC, millisecond-resolution storage. */
export const SQLITE_TIMESTAMP_FORMAT = "iso8601" as const;

/** Static SQLite clock expressions; never accept caller-provided SQL fragments. */
export const SQLITE_DATETIME_SQL_FORMAT = "'%Y-%m-%dT%H:%M:%f+00:00'";
export const SQLITE_NOW_SQL = `strftime(${SQLITE_DATETIME_SQL_FORMAT}, 'now')`;

export class SqliteDateCompatibilityError extends Error {
	readonly category = "format-migration-required";

	constructor() {
		super("SQLite date evidence requires a supported format migration.");
		this.name = "SqliteDateCompatibilityError";
	}
}

function unavailable(): never {
	throw new SqliteDateCompatibilityError();
}

const MAX_DATE_MS = 8_640_000_000_000_000;
const ISO_DATE =
	/^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const SQLITE_UTC_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * Normalize only recognized native date encodings, without guessing units or
 * silently rolling invalid calendar dates forward. This function performs no I/O.
 */
export function encodeCanonicalSqliteDate(value: unknown, nullable: boolean): string | null {
	if (value === null) return nullable ? null : unavailable();

	let milliseconds: number;
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_DATE_MS) unavailable();
		milliseconds = value;
	} else if (typeof value === "string") {
		const iso = ISO_DATE.exec(value);
		const components = iso ?? SQLITE_UTC_DATE.exec(value);
		if (!components || components[1] === "-000000") unavailable();

		const year = Number(components[1]);
		const month = Number(components[2]);
		const day = Number(components[3]);
		const hour = Number(components[4]);
		const minute = Number(components[5]);
		const second = Number(components[6]);
		const fraction = iso?.[7] ?? "";
		const zone = iso?.[8] ?? "Z";
		const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
		const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
		if (
			month < 1 ||
			month > 12 ||
			day < 1 ||
			day > days[month - 1]! ||
			hour > 23 ||
			minute > 59 ||
			second > 59 ||
			/[1-9]/.test(fraction.slice(3)) ||
			(zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
		)
			unavailable();

		const local =
			`${components[1]}-${components[2]}-${components[3]}T` +
			`${components[4]}:${components[5]}:${components[6]}.${fraction.slice(0, 3).padEnd(3, "0")}${zone}`;
		milliseconds = Date.parse(local);
		if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > MAX_DATE_MS) unavailable();
	} else {
		unavailable();
	}

	return new Date(milliseconds).toISOString().replace("Z", "+00:00");
}
