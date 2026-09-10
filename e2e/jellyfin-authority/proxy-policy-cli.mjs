import { applyRequestPolicy, applyResponsePolicy } from "./proxy-policy.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const command = JSON.parse(input);
const result =
	command.kind === "request"
		? applyRequestPolicy(command)
		: command.kind === "response"
			? applyResponsePolicy(command)
			: (() => {
					throw new Error(`Unsupported policy command: ${String(command.kind)}`);
				})();

process.stdout.write(`${JSON.stringify(result)}\n`);
