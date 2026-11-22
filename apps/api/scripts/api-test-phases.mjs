/** Select coverage before any native fixture is prepared. */
export function selectApiTestPhases(argv, sqliteWorkers = "4") {
	let phase;
	const vitestArguments = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--phase" || argument.startsWith("--phase=")) {
			if (phase !== undefined) throw new Error("Duplicate API test --phase selection.");
			phase = argument === "--phase" ? argv[++index] : argument.slice("--phase=".length);
			if (!["all", "sqlite", "postgres"].includes(phase))
				throw new Error("API test --phase must be all, sqlite, or postgres.");
		} else if (!["run", "--run"].includes(argument)) vitestArguments.push(argument);
	}
	phase ??= "all";
	if (vitestArguments.some((argument) => /^(--watch|--ui)(=|$)/.test(argument)))
		throw new Error("The API gate is noninteractive so native child exit can be joined.");
	if (sqliteWorkers !== "2" && sqliteWorkers !== "4")
		throw new Error("ARR_API_TEST_WORKERS must be 2 or 4.");
	if (phase === "postgres" && vitestArguments.length > 0)
		throw new Error("PostgreSQL-only mode does not accept extra Vitest arguments.");
	return {
		phase,
		vitestArguments,
		sqliteWorkers,
		runSqlite: phase !== "postgres",
		runPostgres: phase !== "sqlite",
	};
}
