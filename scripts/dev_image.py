"""Bind development images to exact main and guard observed mutable-alias state.

The workflow serializes its own writers. Registries do not offer tag CAS: an
external credential holder can still race the last observation and write. Stop
on observed drift or partial failure, report observations, and never roll back.
"""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from release_registry import REGISTRIES, Registry


REPOSITORY = "Kha-kis/arr-dashboard"
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
ACTIVE = ("queued", "in_progress", "waiting", "pending", "requested")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def output(*args):
    return subprocess.check_output(args, stdin=subprocess.DEVNULL, timeout=120).decode().strip()


def api(path):
    return json.loads(output("gh", "api", "--paginate", "--slurp", f"repos/{REPOSITORY}/{path}"))


def select_source(context, event):
    require(context.get("GITHUB_REPOSITORY") == REPOSITORY, "canonical repository required")
    require(context.get("GITHUB_REF") == "refs/heads/main", "main workflow ref required")
    if context.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
        source = event.get("inputs", {}).get("source_sha")
        require(source == context.get("GITHUB_SHA"), "manual source differs from dispatch commit")
    else:
        require(context.get("GITHUB_EVENT_NAME") == "workflow_run", "unsupported event")
        run = event.get("workflow_run", {})
        require(run.get("name") == "CI" and run.get("event") == "push"
                and run.get("status") == "completed" and run.get("conclusion") == "success"
                and run.get("head_branch") == "main"
                and run.get("head_repository", {}).get("full_name") == REPOSITORY,
                "successful canonical main push CI required")
        source = run.get("head_sha")
    require(isinstance(source, str) and SHA.fullmatch(source), "full lowercase source SHA required")
    return source


def check_authority(source, run_id, get_api=api):
    require(SHA.fullmatch(source), "invalid source")
    main = get_api("git/ref/heads/main")
    # gh --slurp wraps even the single ref response in a page list.
    if isinstance(main, list):
        require(len(main) == 1, "unexpected main response")
        main = main[0]
    require(main["object"]["sha"] == source, "source is no longer current main")
    for state in ACTIVE:
        pages = get_api(f"actions/workflows/docker-dev.yml/runs?status={state}&per_page=100")
        require(isinstance(pages, list) and pages, "missing workflow run response")
        for page in pages:
            runs = page["workflow_runs"]
            require(isinstance(runs, list), "invalid workflow runs")
            for run in runs:
                require(str(run["id"]) == run_id or run["status"] == "completed",
                        "another dev workflow run may write mutable aliases")


def snapshot(registries):
    return {repo: registries[repo].tag_digest("dev") for repo in REGISTRIES}


def promote(registries, baseline, index, check, write):
    require(isinstance(index, str) and DIGEST.fullmatch(index), "invalid build digest")
    require(set(baseline) == set(REGISTRIES), "incomplete alias baseline")
    require(all(value is None or isinstance(value, str) and DIGEST.fullmatch(value)
                for value in baseline.values()), "invalid alias baseline")
    check()
    require(snapshot(registries) == baseline, "dev aliases changed during build")
    expected = dict(baseline)
    for repo in REGISTRIES:
        check()
        require(snapshot(registries) == expected, "competing dev alias writer observed")
        write(repo, index)
        require(registries[repo].tag_digest("dev") == index, "dev alias readback differs")
        expected[repo] = index
    check()
    require(snapshot(registries) == expected, "final dev alias state differs")


def assert_checkout(source):
    require(output("git", "rev-parse", "HEAD") == source, "checkout source differs")
    require(not output("git", "status", "--porcelain", "--untracked-files=all"), "source tree is dirty")


def main():
    context = os.environ
    source = select_source(context, json.loads(Path(context["GITHUB_EVENT_PATH"]).read_text()))
    run_id = context["GITHUB_RUN_ID"]
    attempt = context["GITHUB_RUN_ATTEMPT"]
    require(re.fullmatch(r"[1-9][0-9]*", run_id) and re.fullmatch(r"[1-9][0-9]*", attempt),
            "invalid workflow run identity")
    check = lambda: check_authority(source, run_id)
    state_path = Path(context["RUNNER_TEMP"]) / "dev-image-baseline.json"
    if sys.argv[1:] == ["prepare"]:
        check()
        state = {"source": source, "run": run_id, "attempt": attempt,
                 "baseline": snapshot({repo: Registry(repo) for repo in REGISTRIES})}
        state_path.write_text(json.dumps(state))
        with open(context["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"source={source}\ntag=dev-{source}-{run_id}-{attempt}\n")
            stream.write(f"date={datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}\n")
    elif sys.argv[1:] == ["assert-source"]:
        assert_checkout(source)
        check()
    elif sys.argv[1:] == ["publish"]:
        state = json.loads(state_path.read_text())
        require((state["source"], state["run"], state["attempt"]) == (source, run_id, attempt),
                "baseline belongs to a different run/source")
        index = context["BUILD_DIGEST"]
        registries = {repo: Registry(repo) for repo in REGISTRIES}
        tag = f"dev-{source}-{run_id}-{attempt}"
        require(all(registries[repo].tag_digest(tag) == index for repo in REGISTRIES),
                "built candidate digest differs between registries")
        def write(repo, digest):
            print(json.dumps({"status": "write-intent", "source": source, "registry": repo, "digest": digest}), flush=True)
            subprocess.run(["docker", "buildx", "imagetools", "create", "--prefer-index=false",
                            "--tag", f"{repo}:dev", f"{repo}@{digest}"], check=True, timeout=120)
        try:
            promote(registries, state["baseline"], index, check, write)
        finally:
            # Report partial results without masking the original error or restoring old tags.
            for repo in REGISTRIES:
                try:
                    print(json.dumps({"registry": repo, "observedDev": registries[repo].tag_digest("dev")}))
                except Exception:
                    print(json.dumps({"registry": repo, "observedDev": "UNKNOWN"}))
    else:
        raise ValueError("expected prepare, assert-source or publish")


if __name__ == "__main__":
    main()
