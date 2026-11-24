"""Authorize and copy one previously qualified OCI index within each registry."""

from datetime import datetime
import hashlib
import io
import json
import os
import re
import signal
import subprocess
import sys
from pathlib import Path
import zipfile

from release_registry import REGISTRIES, Registry, verify_qualification


REPOSITORY = "Kha-kis/arr-dashboard"
MAINTAINER = "Kha-kis"
STAGE_WORKFLOW = "docker-stage.yml"
LEGACY_WORKFLOW_ID = 196258923
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SHA = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
IDENTIFIER = re.compile(r"[1-9][0-9]{0,19}")
MANIFEST_FILE = "release-qualification.json"
MAX_RECORD_BYTES = 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def alias_plan(version, previous):
    require(VERSION.fullmatch(version), "invalid stable version")
    major, minor, _patch = version.split(".")
    floating = (f"{major}.{minor}", major, "latest")
    require(isinstance(previous, dict) and set(previous) == set(REGISTRIES),
            "expected aliases must cover both registries")
    for repo in REGISTRIES:
        require(isinstance(previous[repo], dict) and set(previous[repo]) == set(floating),
                "expected aliases must cover minor, major and latest")
        for value in previous[repo].values():
            require(value is None or isinstance(value, str) and DIGEST.fullmatch(value),
                    "expected alias values must be full digests or null")
    return [
        (repo, tag, None if tag == version else previous[repo][tag])
        for tag in (version, *floating)
        for repo in REGISTRIES
    ]


def read_expected(registries, repository, tag, old, index):
    current = registries[repository].tag_digest(tag)
    require(current in (old, index), f"unexpected or conflicting tag: {repository}:{tag}")
    return current


def check_aliases(registries, plan, index, *, recovery=True):
    require(DIGEST.fullmatch(index), "invalid qualified index")
    for repo, tag, old in plan:
        current = read_expected(registries, repo, tag, old, index)
        require(recovery or current == old, f"existing promotion state requires a deliberate rerun: {repo}:{tag}")


def apply_aliases(registries, plan, index, write_index, emit):
    """Accept already verified writes, and stop on the first failure or drift."""
    verified = False
    try:
        check_aliases(registries, plan, index)
        for repo, tag, old in plan:
            current = read_expected(registries, repo, tag, old, index)
            if current != index:
                emit({"status": "write-intent", "registry": repo, "tag": tag, "from": current, "to": index})
                write_index(repo, tag, index)
            require(registries[repo].tag_digest(tag) == index,
                    f"alias readback differs: {repo}:{tag}")
            emit({"status": "alias-verified", "registry": repo, "tag": tag, "digest": index})
        for repo, tag, _old in plan:
            require(registries[repo].tag_digest(tag) == index, f"final alias differs: {repo}:{tag}")
        verified = True
    finally:
        observed = {repo: {} for repo in REGISTRIES}
        read_errors = []
        for repo, tag, _old in plan:
            try:
                observed[repo][tag] = registries[repo].tag_digest(tag)
            except Exception:
                read_errors.append(f"{repo}:{tag}")
        complete = verified and not read_errors and all(
            observed[repo][tag] == index for repo, tag, _old in plan
        )
        emit({
            "status": "verified" if complete else "incomplete",
            "qualifiedIndex": index,
            "observed": observed,
            "readErrors": read_errors,
        })
        if verified:
            require(complete, "final registry observation incomplete or drifted")


def output(*args):
    return subprocess.check_output(args, stdin=subprocess.DEVNULL, timeout=120)


def get_api(path):
    return json.loads(output("gh", "api", f"repos/{REPOSITORY}/{path}"))


def emit_record(value):
    line = json.dumps(value, sort_keys=True)
    print(line, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(line + "\n")


def timestamp(value):
    require(isinstance(value, str), "missing release evidence timestamp")
    when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(when.tzinfo is not None, "release evidence timestamp needs timezone")
    return when


def require_release_event():
    """Bind a trusted create-only tag push to the checked-out current main."""
    env = os.environ
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY
            and env.get("GITHUB_EVENT_NAME") == "push"
            and env.get("GITHUB_ACTOR") == MAINTAINER
            and env.get("GITHUB_TRIGGERING_ACTOR") == MAINTAINER,
            "publication requires a stable tag push or recovery rerun by the maintainer")
    ref = env.get("GITHUB_REF", "")
    version = ref.removeprefix("refs/tags/v")
    require(ref == "refs/tags/v" + version and VERSION.fullmatch(version), "invalid stable tag")
    require(env.get("GITHUB_REF_PROTECTED") == "true", "stable tag needs an active repository ruleset")
    run_id = env.get("GITHUB_RUN_ID", "")
    require(IDENTIFIER.fullmatch(run_id) and IDENTIFIER.fullmatch(env.get("GITHUB_RUN_ATTEMPT", "")),
            "invalid promotion run identity")
    event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_bytes())
    require(event.get("ref") == ref and event.get("created") is True
            and event.get("deleted") is False and event.get("forced") is False
            and event.get("before") == "0" * 40 and event["sender"]["login"] == MAINTAINER
            and event["repository"]["full_name"] == REPOSITORY,
            "promotion requires creation of the exact release tag")

    reference = get_api(f"git/ref/tags/v{version}")
    obj = reference["object"]
    require(reference["ref"] == ref and obj["type"] == "tag" and SHA.fullmatch(obj["sha"]),
            "the exact release tag must be annotated")
    tag = get_api(f"git/tags/{obj['sha']}")
    source = tag["object"]["sha"]
    require(tag["tag"] == "v" + version and tag["object"]["type"] == "commit" and SHA.fullmatch(source)
            and env.get("GITHUB_SHA") in (obj["sha"], source)
            and event.get("after") in (obj["sha"], source),
            "release tag or push identity differs from the checked-out source")
    require(output("git", "rev-parse", "HEAD").decode().strip() == source
            and get_api("git/ref/heads/main")["object"]["sha"] == source,
            "release tag does not point to exact current main")
    require(json.loads(output("git", "show", "HEAD:package.json"))["version"] == version,
            "package version differs from the release tag")
    run = get_api(f"actions/runs/{run_id}")
    require(run["id"] == int(run_id) and run["event"] == "push"
            and run["head_sha"] in (obj["sha"], source), "promotion run source differs")
    require(get_api(f"actions/workflows/{LEGACY_WORKFLOW_ID}")["state"] == "disabled_manually",
            "retire the historical unqualified release workflow before publishing")
    cutoff = min(timestamp(tag["tagger"]["date"]), timestamp(run["created_at"]))
    return version, source, obj["sha"], cutoff


def read_qualification(stage_id, source, cutoff, workflow_id):
    run = get_api(f"actions/runs/{stage_id}/attempts/1")
    require(run["workflow_id"] == workflow_id and run["id"] == stage_id
            and run["run_attempt"] == 1 and run["event"] == "workflow_dispatch"
            and run["head_branch"] == "main" and run["head_sha"] == source
            and run["head_repository"]["full_name"] == REPOSITORY
            and run["status"] == "completed" and run["conclusion"] == "success"
            and timestamp(run["updated_at"]) < cutoff,
            "qualification is not a successful canonical stage before the tag")
    name = "release-qualification-attempt-1"
    response = get_api(f"actions/runs/{stage_id}/artifacts?name={name}&per_page=2")
    require(response["total_count"] == len(response["artifacts"]) == 1,
            "expected one immutable qualification artifact for the selected run")
    artifact = response["artifacts"][0]
    require(artifact["name"] == name and artifact["expired"] is False
            and 0 < artifact["size_in_bytes"] <= MAX_RECORD_BYTES
            and type(artifact["id"]) is int and artifact["id"] > 0
            and DIGEST.fullmatch(artifact["digest"]) and timestamp(artifact["created_at"]) < cutoff,
            "qualification artifact is invalid, expired, or newer than the tag")
    archive = output("gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip")
    require(0 < len(archive) <= MAX_RECORD_BYTES
            and "sha256:" + hashlib.sha256(archive).hexdigest() == artifact["digest"],
            "qualification archive size or immutable digest differs")
    with zipfile.ZipFile(io.BytesIO(archive)) as files:
        require(files.namelist() == [MANIFEST_FILE], "unexpected qualification archive contents")
        require(0 < files.getinfo(MANIFEST_FILE).file_size <= MAX_RECORD_BYTES,
                "qualification record exceeds the allowed size")
        raw = files.read(MANIFEST_FILE)
    record = json.loads(raw)
    require(type(record) is dict, "qualification record must be a JSON object")
    return record, hashlib.sha256(raw).hexdigest()


def discover_qualification(version, source, tree, cutoff):
    workflow = get_api(f"actions/workflows/{STAGE_WORKFLOW}")
    require(workflow["path"] == ".github/workflows/" + STAGE_WORKFLOW and workflow["state"] == "active"
            and type(workflow["id"]) is int and workflow["id"] != LEGACY_WORKFLOW_ID,
            "invalid staging workflow identity")
    found = get_api(f"actions/workflows/{workflow['id']}/runs?"
                    f"head_sha={source}&branch=main&event=workflow_dispatch&status=success&per_page=100")
    require(found["total_count"] == len(found["workflow_runs"]) <= 100,
            "qualification discovery was incomplete")
    candidates = []
    for run in found["workflow_runs"]:
        if run["run_attempt"] != 1 or timestamp(run["updated_at"]) >= cutoff:
            continue
        stage_id = run["id"]
        require(type(stage_id) is int and stage_id > 0, "invalid stage run ID")
        record, digest = read_qualification(stage_id, source, cutoff, workflow["id"])
        require(record.get("version") == version and record.get("source") == source
                and record.get("tree") == tree and record.get("runId") == stage_id
                and record.get("runAttempt") == 1 and DIGEST.fullmatch(record["indexDigest"]),
                "qualification record differs from the exact tagged release")
        plan = alias_plan(version, record["expectedAliases"])
        candidates.append((stage_id, record, digest, plan))
    require(candidates, "no successful canonical qualification found before the tag")
    first = min(candidates, key=lambda candidate: candidate[0])
    for _, record, _, plan in candidates:
        require(record["indexDigest"] == first[1]["indexDigest"] and plan == first[3],
                "incompatible qualification records exist for this tag")
    return first


def verify_copy_plan(repository, index):
    raw = output("docker", "buildx", "imagetools", "create", "--prefer-index=false", "--dry-run", f"{repository}@{index}")
    # Buildx writes the raw index followed by a newline on stdout.
    require(any("sha256:" + hashlib.sha256(data).hexdigest() == index
                for data in (raw, raw.removesuffix(b"\n"))),
            f"registry copy plan differs from the qualified index: {repository}")


def copy_index(repository, alias, index):
    subprocess.run(
        ["docker", "buildx", "imagetools", "create", "--prefer-index=false", "--tag", f"{repository}:{alias}",
         f"{repository}@{index}"],
        check=True, stdin=subprocess.DEVNULL, timeout=180,
    )


def main(mode):
    version, source, tag, cutoff = require_release_event()
    tree = output("git", "rev-parse", "HEAD^{tree}").decode().strip()
    stage_id, record, receipt_hash, plan = discover_qualification(version, source, tree, cutoff)
    index = record["indexDigest"]
    selected = f"{tag}:{stage_id}:{receipt_hash}:{index}"
    if mode == "promote":
        require(os.environ.get("PREFLIGHT_SELECTION") == selected,
                "qualification changed since read-only preflight")

    verify_qualification(record, version=version, source=source, tree=tree,
                         run_id=stage_id, run_attempt=1, index_digest=index)
    registries = {repo: Registry(repo) for repo in REGISTRIES}
    recovery = os.environ["GITHUB_RUN_ATTEMPT"] != "1"
    if mode == "preflight":
        check_aliases(registries, plan, index, recovery=recovery)
        emit_record({"status": "preflight-verified", "source": source, "tree": tree, "version": version,
                     "tagObject": tag, "stageRun": stage_id, "qualificationSha256": receipt_hash,
                     "qualifiedIndex": index, "expectedAliases": plan})
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            stream.write("selection=" + selected + "\n")
        return

    for repository in REGISTRIES:
        verify_copy_plan(repository, index)
    require(require_release_event() == (version, source, tag, cutoff),
            "release authorization changed before writing")
    check_aliases(registries, plan, index, recovery=recovery)
    apply_aliases(registries, plan, index, copy_index, emit_record)


def interrupted(_signum, _frame):
    raise InterruptedError("promotion interrupted; inspect registry state before deliberately rerunning promotion")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ("preflight", "promote"),
                "expected preflight or promote")
        main(sys.argv[1])
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Release gate failed ({type(error).__name__}): {error}", file=sys.stderr)
        sys.exit(1)
