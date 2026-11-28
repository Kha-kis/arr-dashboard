#!/usr/bin/env node
// A separate entrypoint keeps CLI execution out of shared API/launcher bundles.
import {
	bindCombinedStartupLauncher,
	consumeCombinedStartupChannel,
	prepareCombinedStartupChannel,
	readCombinedStartupChannel,
	readCombinedStartupStatus,
	removeCombinedStartupChannel,
} from "./lib/lifecycle/combined-startup.js";

try {
	const [command, ...args] = process.argv.slice(2);
	if (command === "prepare" && args.length === 0) {
		const c = prepareCombinedStartupChannel();
		process.stdout.write(`${c.directory}\t${c.nonce}\t${c.device}\t${c.inode}\n`);
	} else if (
		(command === "bind" &&
			args.length === 2 &&
			args.every((value) => /^[1-9][0-9]*$/.test(value))) ||
		((command === "read" || command === "consume" || command === "cleanup") && args.length === 0)
	) {
		const c = readCombinedStartupChannel(process.env);
		if (!c) throw new Error("Missing startup channel.");
		if (command === "bind") bindCombinedStartupLauncher(c, Number(args[0]), Number(args[1]));
		else if (command === "cleanup") removeCombinedStartupChannel(c);
		else if (command === "consume") consumeCombinedStartupChannel(c);
		else {
			const result = readCombinedStartupStatus(c);
			if (result)
				process.stdout.write(`${result.apiPort}\t${result.webPort}\t${result.listenAddress}\n`);
			else process.exitCode = 2;
		}
	} else throw new Error("Unexpected startup arguments.");
} catch {
	process.stderr.write("Combined startup handoff is unavailable.\n");
	process.exitCode = 1;
}
