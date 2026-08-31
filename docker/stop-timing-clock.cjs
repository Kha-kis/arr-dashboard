const { spawnSync } = require("node:child_process");

const TIMING_LIMITS = Object.freeze({
	collision: { limitMilliseconds: 9_000, operator: ">=" },
	prompt: { limitMilliseconds: 4_000, operator: "<=" },
	restart: { limitMilliseconds: 10_000, operator: "<" },
	stubborn: { limitMilliseconds: 9_000, operator: "<" },
});

function monotonicMilliseconds() {
	return Number(process.hrtime.bigint() / 1_000_000n);
}

function withinTimingLimit(kind, elapsedMilliseconds) {
	const gate = TIMING_LIMITS[kind];
	if (!gate || !Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0) {
		throw new TypeError("unknown timing gate or invalid elapsed milliseconds");
	}
	switch (gate.operator) {
		case "<":
			return elapsedMilliseconds < gate.limitMilliseconds;
		case "<=":
			return elapsedMilliseconds <= gate.limitMilliseconds;
		case ">=":
			return elapsedMilliseconds >= gate.limitMilliseconds;
		default:
			throw new TypeError("unsupported timing operator");
	}
}

function measureCommand(command, args) {
	const start = process.hrtime.bigint();
	const result = spawnSync(command, args, {
		stdio: ["inherit", "ignore", "inherit"],
	});
	const elapsedMilliseconds = Number(
		(process.hrtime.bigint() - start) / 1_000_000n,
	);
	process.stdout.write(`${elapsedMilliseconds}\n`);
	if (result.error) {
		process.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

if (require.main === module) {
	const [, , operation, ...args] = process.argv;
	if (!operation) {
		process.stdout.write(`${monotonicMilliseconds()}\n`);
	} else if (operation === "measure" && args.length > 0) {
		process.exitCode = measureCommand(args[0], args.slice(1));
	} else if (operation === "check" && args.length === 2) {
		process.exitCode = withinTimingLimit(args[0], Number(args[1])) ? 0 : 1;
	} else if (operation === "limit" && args.length === 1 && TIMING_LIMITS[args[0]]) {
		process.stdout.write(`${TIMING_LIMITS[args[0]].limitMilliseconds}\n`);
	} else {
		process.stderr.write(
			"usage: stop-timing-clock.cjs [measure COMMAND...|check GATE MILLISECONDS|limit GATE]\n",
		);
		process.exitCode = 64;
	}
}

module.exports = { TIMING_LIMITS, monotonicMilliseconds, withinTimingLimit };
