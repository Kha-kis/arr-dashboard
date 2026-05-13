#!/usr/bin/env python3
"""
heap-retainer-walk.py — V8 heap snapshot retainer-chain analyzer.

Built during the issue #427 OOM investigation to identify which code path
was holding ~800 MB of Lidarr records resident at near-OOM time. Given a
.heapsnapshot (or .heapsnapshot.gz) produced by V8 (HEAP_AUTO_SNAPSHOT=1,
the `dump-heap` helper, or any other source), this script:

  1. Parses the node + edge sections into compact binary representations
  2. Builds an inverted edge map (dst_node -> list of retainer nodes)
  3. Identifies "interesting" target nodes automatically (largest strings,
     largest Arrays by element count, sampled plain Object instances)
  4. Walks the retainer graph backward from each target to GC roots and
     prints the chain — so you can read e.g. that a 10,003-element Array
     is held by a Generator's parameters_and_registers (i.e. the local
     of a suspended async function)

Intermediate parsing is cached per-input-file (cache key = inode + mtime),
so re-running on the same snapshot is fast (~1s vs ~20s cold).

USAGE

    python3 heap-retainer-walk.py <path-to-snapshot>
    python3 heap-retainer-walk.py heap.heapsnapshot.gz

    # Walk a specific node index (after seeing it in auto-output)
    python3 heap-retainer-walk.py heap.gz --target 3394

    # Custom walk shape
    python3 heap-retainer-walk.py heap.gz --depth 20 --branching 3

    # See full help
    python3 heap-retainer-walk.py --help

CAVEATS

  - Snapshots are ~3x the heap size on disk. A 768 MB heap can produce a
    ~2 GB .heapsnapshot file. Decompressed in-memory parsing peaks around
    1.5x that. The /tmp cache files persist between runs.
  - This walks one retainer per node per level by default (the simple
    strong-reference path V8 typically follows). Use `--branching N` to
    fan out wider if you suspect multiple retention paths.
  - The script intentionally does not load the entire snapshot via the
    `json` module. The nodes/edges sections are too large; we parse them
    as flat number-CSV streams. The strings table is small enough to
    `json.loads` directly.
"""

import argparse
import array
import gzip
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

# V8 heap-snapshot node types (index into the type enum)
NODE_TYPES = [
    "hidden", "array", "string", "object", "code", "closure", "regexp",
    "number", "native", "synthetic", "concatenated string", "sliced string",
    "symbol", "bigint", "object shape",
]

# V8 heap-snapshot edge types
EDGE_TYPES = [
    "context", "element", "property", "internal",
    "hidden", "shortcut", "weak",
]

# Edge types whose name_or_index field is a string-table index (not a number)
EDGE_NAME_IS_STRING_REF = {"context", "property", "internal", "shortcut"}


def find_section_offsets(path: Path) -> dict:
    """Locate byte offsets of each major snapshot section.

    Returns a dict with offsets relative to the decompressed byte stream.
    Also includes the full decompressed bytes under the `__data__` key so
    callers can reuse the read.
    """
    keys = [
        b'"nodes":[',
        b'"edges":[',
        b'"trace_function_infos":[',
        b'"trace_tree":[',
        b'"samples":[',
        b'"locations":[',
        b'"strings":[',
    ]

    is_gzip = path.suffix == ".gz"
    if not is_gzip:
        with open(path, "rb") as f:
            is_gzip = f.read(2) == b"\x1f\x8b"

    if is_gzip:
        with gzip.open(path, "rb") as f:
            data = f.read()
    else:
        with open(path, "rb") as f:
            data = f.read()

    offsets = {}
    for k in keys:
        offsets[k.decode()] = data.find(k)
    offsets["__size__"] = len(data)
    offsets["__data__"] = data
    return offsets


def cache_key(path: Path) -> str:
    """Derive a per-file cache key so re-runs reuse parsed binaries."""
    st = os.stat(path)
    return f"heap-retainer-{abs(hash((str(path.resolve()), st.st_ino, st.st_mtime_ns, st.st_size)))}"


def parse_snapshot(path: Path, cache_dir: Path, use_cache: bool) -> dict:
    """Parse a heap snapshot into compact array.array buffers.

    Returns a dict with: strings (list), nodes (array 'I'), edges (array 'I').
    Cache files: <key>.nodes.bin (raw uint32), <key>.edges.bin (raw uint32),
                 <key>.strings.json (JSON list — safe to parse, no code-exec risk).
    """
    cache_prefix = cache_dir / cache_key(path)
    nodes_cache = cache_prefix.with_suffix(".nodes.bin")
    edges_cache = cache_prefix.with_suffix(".edges.bin")
    strings_cache = cache_prefix.with_suffix(".strings.json")

    t0 = time.time()
    if use_cache and nodes_cache.exists() and edges_cache.exists() and strings_cache.exists():
        print(f"[{time.time()-t0:5.1f}s] Loading cached parse for {path.name}", file=sys.stderr)
        with open(strings_cache, "r", encoding="utf-8") as f:
            strings = json.load(f)
        nodes = array.array("I")
        with open(nodes_cache, "rb") as f:
            nodes.frombytes(f.read())
        edges = array.array("I")
        with open(edges_cache, "rb") as f:
            edges.frombytes(f.read())
        return {"strings": strings, "nodes": nodes, "edges": edges}

    print(f"[{time.time()-t0:5.1f}s] Locating sections in {path.name}...", file=sys.stderr)
    offsets = find_section_offsets(path)
    data = offsets["__data__"]
    nodes_start = offsets['"nodes":[']
    edges_start = offsets['"edges":[']
    strings_start = offsets['"strings":[']
    if nodes_start < 0 or edges_start < 0 or strings_start < 0:
        raise SystemExit("Could not locate one of nodes/edges/strings sections — is this a V8 heap snapshot?")

    print(f"[{time.time()-t0:5.1f}s] Parsing strings table...", file=sys.stderr)
    rest = data[strings_start:].decode("utf-8")
    i = rest.index("[")
    j = rest.rindex("]")
    strings = json.loads(rest[i:j + 1])
    print(f"[{time.time()-t0:5.1f}s] Loaded {len(strings):,} strings", file=sys.stderr)

    print(f"[{time.time()-t0:5.1f}s] Parsing nodes...", file=sys.stderr)
    s = data[nodes_start:edges_start].decode("ascii").replace("\n", "").replace(" ", "")
    arr_text = s[s.index("[") + 1:s.rindex("]")]
    nodes = array.array("I", map(int, arr_text.split(",")))
    print(f"[{time.time()-t0:5.1f}s] Loaded {len(nodes) // 7:,} nodes", file=sys.stderr)

    print(f"[{time.time()-t0:5.1f}s] Parsing edges...", file=sys.stderr)
    edges_end = offsets['"trace_function_infos":[']
    if edges_end < 0:
        edges_end = strings_start
    s = data[edges_start:edges_end].decode("ascii").replace("\n", "").replace(" ", "")
    arr_text = s[s.index("[") + 1:s.rindex("]")]
    edges = array.array("I", map(int, arr_text.split(",")))
    print(f"[{time.time()-t0:5.1f}s] Loaded {len(edges) // 3:,} edges", file=sys.stderr)

    if use_cache:
        print(f"[{time.time()-t0:5.1f}s] Caching parsed binaries to {cache_prefix}.*", file=sys.stderr)
        with open(strings_cache, "w", encoding="utf-8") as f:
            json.dump(strings, f)
        with open(nodes_cache, "wb") as f:
            nodes.tofile(f)
        with open(edges_cache, "wb") as f:
            edges.tofile(f)

    return {"strings": strings, "nodes": nodes, "edges": edges}


def build_retainer_index(nodes: array.array, edges: array.array) -> dict:
    """Build the inverted edge map: for each dst node, list of source node indices.

    Stored as a flat array + offsets so memory cost is O(num_edges) ints.
    Also returns out_offset[i] = first edge index of node i (for forward lookups).
    """
    N = len(nodes) // 7
    E = len(edges) // 3

    t0 = time.time()
    print(f"[{time.time()-t0:5.1f}s] Counting retainers per node...", file=sys.stderr)
    in_count = array.array("I", [0] * N)
    for k in range(E):
        in_count[edges[k * 3 + 2] // 7] += 1

    print(f"[{time.time()-t0:5.1f}s] Computing inverse-edge offsets...", file=sys.stderr)
    in_offset = array.array("I", [0] * (N + 1))
    running = 0
    for i in range(N):
        in_offset[i] = running
        running += in_count[i]
    in_offset[N] = running

    print(f"[{time.time()-t0:5.1f}s] Filling inverse-edge map (E={E:,})...", file=sys.stderr)
    inv_src = array.array("I", [0] * E)
    write_pos = array.array("I", list(in_offset[:N]))
    edge_idx = 0
    for src in range(N):
        cnt = nodes[src * 7 + 4]
        for _ in range(cnt):
            dst = edges[edge_idx * 3 + 2] // 7
            inv_src[write_pos[dst]] = src
            write_pos[dst] += 1
            edge_idx += 1

    print(f"[{time.time()-t0:5.1f}s] Computing forward-edge offsets...", file=sys.stderr)
    out_offset = array.array("I", [0] * (N + 1))
    running = 0
    for i in range(N):
        out_offset[i] = running
        running += nodes[i * 7 + 4]
    out_offset[N] = running

    print(f"[{time.time()-t0:5.1f}s] Retainer index ready", file=sys.stderr)
    return {"in_offset": in_offset, "inv_src": inv_src, "out_offset": out_offset}


def make_describe(nodes: array.array, strings: list):
    """Return a function that pretty-prints a node by its index."""

    def describe(idx: int) -> str:
        t = NODE_TYPES[nodes[idx * 7]]
        name_idx = nodes[idx * 7 + 1]
        sz = nodes[idx * 7 + 3]
        ec = nodes[idx * 7 + 4]
        s = strings[name_idx] if name_idx < len(strings) else "?"
        s = s.replace("\n", "\\n").replace("\r", "\\r")
        if len(s) > 60:
            s = s[:60] + "..."
        return f"#{idx} <{t}> {s!r} sz={sz:,} ec={ec}"

    return describe


def make_get_retainers(nodes: array.array, edges: array.array, strings: list, idx_data: dict):
    """Return a function that lists (src_idx, edge_type, edge_name_str) retainers for a node."""
    in_offset = idx_data["in_offset"]
    inv_src = idx_data["inv_src"]
    out_offset = idx_data["out_offset"]

    def get_retainers(idx: int) -> list:
        result = []
        start = in_offset[idx]
        end = in_offset[idx + 1]
        for k in range(start, end):
            src = inv_src[k]
            out_start = out_offset[src]
            out_end = out_offset[src + 1]
            for e in range(out_start, out_end):
                if edges[e * 3 + 2] // 7 == idx:
                    etype = EDGE_TYPES[edges[e * 3]]
                    eni = edges[e * 3 + 1]
                    if etype in EDGE_NAME_IS_STRING_REF and eni < len(strings):
                        ename = strings[eni]
                    else:
                        ename = f"[{eni}]"
                    result.append((src, etype, str(ename)[:60]))
                    break
        return result

    return get_retainers


def walk_retainers(target: int, describe, get_retainers, max_depth: int, branching: int) -> None:
    """Print the retainer chain backward from `target` up to `max_depth` hops."""
    print(f"\n=== Retainer walk from {describe(target)} ===")
    frontier = [(target, 0)]
    visited = {target}
    while frontier:
        node, depth = frontier.pop(0)
        if depth >= max_depth:
            print(f"{'  ' * depth}[max depth reached at {describe(node)}]")
            continue
        rets = get_retainers(node)
        if not rets:
            tag = " <-- ROOT" if depth > 0 else ""
            print(f"{'  ' * depth}* {describe(node)}{tag}")
            continue
        kept = 0
        for src, etype, ename in rets:
            if src in visited:
                continue
            visited.add(src)
            kept += 1
            print(f"{'  ' * (depth + 1)}<- {describe(src)} (via {etype}.{ename})")
            frontier.append((src, depth + 1))
            if kept >= branching:
                break


def auto_targets(nodes: array.array, strings: list, top_strings: int, top_arrays: int, sample_objects: int) -> list:
    """Pick interesting nodes to walk: largest strings, largest Arrays, sample plain Objects."""
    N = len(nodes) // 7
    targets = []

    print("\nScanning for largest strings...", file=sys.stderr)
    string_nodes = []
    for i in range(N):
        if nodes[i * 7] == 2:  # type "string"
            string_nodes.append((nodes[i * 7 + 3], i))
    string_nodes.sort(reverse=True)
    for _sz, idx in string_nodes[:top_strings]:
        targets.append(("largest-string", idx))

    print("Scanning for largest Arrays...", file=sys.stderr)
    array_nodes = []
    for i in range(N):
        if nodes[i * 7] == 3:  # type "object"
            name_idx = nodes[i * 7 + 1]
            if name_idx < len(strings) and strings[name_idx] == "Array":
                ec = nodes[i * 7 + 4]
                if ec >= 100:
                    array_nodes.append((ec, i))
    array_nodes.sort(reverse=True)
    for _ec, idx in array_nodes[:top_arrays]:
        targets.append(("largest-array", idx))

    print("Sampling plain Object instances...", file=sys.stderr)
    positions = [N // (sample_objects + 1) * (k + 1) for k in range(sample_objects)]
    for pos in positions:
        for i in range(pos, min(pos + 5000, N)):
            if nodes[i * 7] == 3:
                name_idx = nodes[i * 7 + 1]
                if name_idx < len(strings) and strings[name_idx] == "Object":
                    targets.append(("sample-plain-object", i))
                    break

    return targets


def summarize(nodes: array.array, strings: list) -> None:
    """Print a quick top-level summary of the heap by type + top constructors."""
    N = len(nodes) // 7
    by_type = defaultdict(lambda: [0, 0])
    by_typename = defaultdict(lambda: [0, 0])

    for i in range(N):
        t = NODE_TYPES[nodes[i * 7]]
        sz = nodes[i * 7 + 3]
        name_idx = nodes[i * 7 + 1]
        by_type[t][0] += sz
        by_type[t][1] += 1
        if name_idx < len(strings):
            nm = strings[name_idx]
            by_typename[(t, nm)][0] += sz
            by_typename[(t, nm)][1] += 1

    print("\n=== Self-size by node type ===")
    for tname, (total, cnt) in sorted(by_type.items(), key=lambda x: -x[1][0]):
        print(f"  {tname:24s} {total / 1024 / 1024:>10.2f} MB    ({cnt:,} nodes)")

    print("\n=== Top 20 (type, name) buckets by self_size ===")
    ranked = sorted(by_typename.items(), key=lambda x: -x[1][0])[:20]
    for (tname, name), (total, cnt) in ranked:
        avg = total / cnt if cnt else 0
        name_disp = (name[:50] + "...") if len(name) > 50 else name
        print(f"  {tname:14s} {total / 1024 / 1024:>8.2f} MB  cnt={cnt:>8,}  avg={avg:>8.0f}B  name={name_disp!r}")


def main():
    parser = argparse.ArgumentParser(
        description="V8 heap snapshot retainer-chain analyzer (issue #427 toolkit).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("snapshot", type=Path, help=".heapsnapshot or .heapsnapshot.gz")
    parser.add_argument("--target", type=int, action="append", default=[],
                        help="Walk retainers from this node index (can repeat).")
    parser.add_argument("--top-strings", type=int, default=3,
                        help="Auto-walk the N largest strings (default 3).")
    parser.add_argument("--top-arrays", type=int, default=5,
                        help="Auto-walk the N largest Arrays by edge_count (default 5).")
    parser.add_argument("--sample-objects", type=int, default=3,
                        help="Auto-walk N spread-out plain Object samples (default 3).")
    parser.add_argument("--depth", type=int, default=15, help="Max retainer-walk depth (default 15).")
    parser.add_argument("--branching", type=int, default=2,
                        help="Retainers to follow per node per level (default 2).")
    parser.add_argument("--cache-dir", type=Path, default=Path("/tmp"),
                        help="Where to cache parsed binaries (default /tmp).")
    parser.add_argument("--no-cache", action="store_true", help="Don't read or write the cache.")
    parser.add_argument("--no-summary", action="store_true",
                        help="Skip the type/constructor summary at the top.")
    args = parser.parse_args()

    if not args.snapshot.exists():
        raise SystemExit(f"Not found: {args.snapshot}")

    parsed = parse_snapshot(args.snapshot, args.cache_dir, not args.no_cache)
    nodes, edges, strings = parsed["nodes"], parsed["edges"], parsed["strings"]

    if not args.no_summary:
        summarize(nodes, strings)

    idx_data = build_retainer_index(nodes, edges)
    describe = make_describe(nodes, strings)
    get_retainers = make_get_retainers(nodes, edges, strings, idx_data)

    if args.target:
        for t in args.target:
            walk_retainers(t, describe, get_retainers, args.depth, args.branching)
    else:
        targets = auto_targets(nodes, strings, args.top_strings, args.top_arrays, args.sample_objects)
        if not targets:
            print("\nNo auto-targets found.", file=sys.stderr)
        for label, idx in targets:
            print(f"\n--- {label} ---")
            walk_retainers(idx, describe, get_retainers, args.depth, args.branching)


if __name__ == "__main__":
    main()
