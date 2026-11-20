// Exercise the actual Next lint dependency chain, not a separate test-only copy.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const web = createRequire(new URL("../apps/web/package.json", import.meta.url));
const next = createRequire(web.resolve("@next/eslint-plugin-next"));
const glob = createRequire(next.resolve("fast-glob"));
const micromatch = createRequire(glob.resolve("micromatch"));
const req = createRequire(micromatch.resolve("braces"));
const braces = micromatch("braces"),
	flatten = req("./lib/utils.js").flatten;
assert.equal(micromatch("braces/package.json").version, "3.0.3");
const controlled = (fn) =>
	assert.throws(fn, (e) => e instanceof RangeError && e.code === "ERR_BRACES_MAX_DEPTH");
const stringApis = {
	main: (s) => braces(s),
	create: (s) => braces.create(s),
	parse: (s) => braces.parse(s),
	compile: (s) => braces.compile(s),
	expand: (s) => braces.expand(s),
	stringify: (s) => braces.stringify(s),
};
for (const [name, fn] of Object.entries(stringApis))
	for (const [shape, open, close] of [
		["brace", "{", "}"],
		["paren", "(", ")"],
	])
		test("rejects over-depth string " + name + " " + shape, () =>
			controlled(() => fn(open.repeat(129) + "x" + close.repeat(129))),
		);
for (const [name, fn] of Object.entries(stringApis))
	test("depth option cannot disable string guard " + name, () =>
		controlled(() =>
			name === "main"
				? braces("(".repeat(129) + "x" + ")".repeat(129), { maxDepth: Infinity })
				: braces[name]("(".repeat(129) + "x" + ")".repeat(129), { maxDepth: Infinity }),
		),
	);
function ast(depth) {
	const root = { type: "root", nodes: [] };
	let node = root;
	for (let n = 1; n < depth; n++) {
		const child = { type: "paren", nodes: [], parent: node };
		node.nodes.push(child);
		node = child;
	}
	node.nodes.push({ type: "text", value: "x", parent: node });
	return root;
}
for (const name of ["compile", "expand", "stringify"]) {
	test("rejects over-depth direct AST " + name, () => controlled(() => braces[name](ast(129))));
	test("rejects cyclic child AST " + name, () => {
		const a = { type: "root", nodes: [] };
		a.nodes.push(a);
		controlled(() => braces[name](a));
	});
	test("rejects cyclic parent AST " + name, () => {
		const a = ast(2);
		a.nodes[0].parent = a.nodes[0];
		controlled(() => braces[name](a));
	});
	test("preserves exact AST depth128 boundary " + name, () =>
		assert.deepEqual(braces[name](ast(128)), name === "expand" ? ["x"] : "x"),
	);
}
function nestedArray(depth) {
	let a = "x";
	for (let n = 0; n < depth; n++) a = [a];
	return a;
}
for (const name of ["compile", "expand", "stringify"])
	test("rejects deeply nested AST value arrays " + name, () => {
		const a = ast(1);
		a.nodes[0].value = nestedArray(130);
		controlled(() => braces[name](a));
	});
test("rejects deeply nested flatten input", () => controlled(() => flatten(nestedArray(130))));
test("rejects cyclic flatten input", () => {
	const a = [];
	a.push(a);
	controlled(() => flatten(a));
});
test("preserves ordinary flatten order and undefined handling", () =>
	assert.deepEqual(flatten(["a", ["b", undefined]], null, 0, ["c"]), ["a", "b", null, 0, "c"]));
for (const [pattern, expected] of [
	["{a,b}", "{a,b}"],
	["a/{b,c}/d", "a/{b,c}/d"],
	["{1..3}", "{1..3}"],
	["{01..03}", "{01..03}"],
	["{a..c}", "{a..c}"],
	["x{a,{b,c}}y", "x{a,{b,c}}y"],
	["${name}", "${name}"],
	["a\\{b,c\\}", "a{b,c}"],
	["[{}]", "[{}]"],
	['"{a,b}"', "{a,b}"],
])
	test("preserves ordinary stringify " + pattern, () =>
		assert.equal(braces.stringify(pattern), expected),
	);
test("preserves independently expected expansion", () => {
	assert.deepEqual(braces.expand("a/{b,c}/d"), ["a/b/d", "a/c/d"]);
	assert.deepEqual(braces.expand("{01..03}"), ["01", "02", "03"]);
	assert.deepEqual(braces.expand("x{a,{b,c}}y"), ["xay", "xby", "xcy"]);
});
test("preserves independently expected compile and options", () => {
	assert.equal(braces.compile("a/{b,c}/d"), "a/(b|c)/d");
	assert.deepEqual(braces(["{a,a}", "{b,}"], { expand: true, nodupes: true, noempty: true }), [
		"a",
		"b",
	]);
	assert.throws(() => braces.expand("{1..1001}"), /range limit/);
});
test("preserves native maximum input length refusal", () =>
	assert.throws(() => braces.parse("x".repeat(65537)), SyntaxError));
test("preserves bounded deep balanced and imbalanced strings", () => {
	for (const n of [32, 96, 127])
		for (const [open, close] of [
			["(", ")"],
			["{", "}"],
		]) {
			const p = open.repeat(n) + "x" + close.repeat(n);
			assert.equal(braces.stringify(p), p);
			assert.equal(braces.compile(p), p);
			assert.deepEqual(braces.expand(p), [p]);
		}
	const p = "{".repeat(96) + "x";
	assert.equal(braces.stringify(p), p);
});
