"""Authorize and copy one previously qualified OCI index within each registry."""

import hashlib
import io
import json
import os
import re
import signal
import subprocess
import sys
import zipfile


REPOSITORY = "Kha-kis/arr-dashboard"
REGISTRIES = ("khak1s/arr-dashboard", "ghcr.io/kha-kis/arr-dashboard")
ENVIRONMENT = "stable-release"
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


def check_aliases(registries, plan, index):
    require(DIGEST.fullmatch(index), "invalid qualified index")
    for repo, tag, old in plan:
        read_expected(registries, repo, tag, old, index)


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


def require_environment_approval(environment, reviews, approval_comment):
    require(environment.get("name") == ENVIRONMENT
            and environment.get("can_admins_bypass") is not True,
            "stable-release protection is missing or reports administrator bypass")
    reviewers = {
        row["reviewer"]["id"]
        for rule in environment.get("protection_rules", [])
        if rule["type"] == "required_reviewers"
        for row in rule.get("reviewers", [])
        if row["type"] == "User"
    }
    require(reviewers, "stable-release needs named individual required reviewers")
    matching = [
        review for review in reviews
        if any(env["id"] == environment["id"] for env in review.get("environments", []))
    ]
    require(not any(review["state"] == "rejected" for review in matching),
            "this stable-release deployment was rejected")
    require(any(review["state"] == "approved" and review["user"]["id"] in reviewers
                and isinstance(review.get("comment"), str) and review["comment"].strip() == approval_comment
                for review in matching),
            "current dispatch lacks an explicit configured reviewer approval")


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


def require_dispatch():
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY
            and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and os.environ.get("GITHUB_REF") == "refs/heads/main"
            and os.environ.get("GITHUB_RUN_ATTEMPT") == "1",
            "promotion requires a new canonical main dispatch")
    source = os.environ["GITHUB_SHA"]
    run_id = os.environ["GITHUB_RUN_ID"]
    require(SHA.fullmatch(source) and IDENTIFIER.fullmatch(run_id), "invalid source or run ID")
    require(output("git", "rev-parse", "HEAD").decode().strip() == source,
            "checkout differs from dispatch source")
    require(get_api("git/ref/heads/main")["object"]["sha"] == source, "main has advanced")
    return source, run_id


def approved(run_id, approval_comment):
    require_environment_approval(
        get_api(f"environments/{ENVIRONMENT}"),
        get_api(f"actions/runs/{run_id}/approvals"),
        approval_comment,
    )


def require_tag(version, source):
    reference = get_api(f"git/ref/tags/v{version}")
    obj = reference["object"]
    require(reference["ref"] == f"refs/tags/v{version}" and obj["type"] == "tag",
            "the exact release tag must be annotated")
    require(SHA.fullmatch(obj["sha"]), "invalid annotated tag identity")
    tag = get_api(f"git/tags/{obj['sha']}")
    require(tag["tag"] == "v" + version
            and tag["object"]["type"] == "commit" and tag["object"]["sha"] == source,
            "release tag does not point directly to the qualified main commit")


def read_qualification(stage_id, attempt, source, expected_hash):
    workflow = get_api("actions/workflows/docker-combined.yml")
    run = get_api(f"actions/runs/{stage_id}/attempts/{attempt}")
    require(run["workflow_id"] == workflow["id"] and run["id"] == int(stage_id)
            and run["run_attempt"] == int(attempt) and run["event"] == "workflow_dispatch"
            and run["head_branch"] == "main" and run["head_sha"] == source
            and run["head_repository"]["full_name"] == REPOSITORY
            and run["status"] == "completed" and run["conclusion"] == "success",
            "qualification is not a successful canonical stage run at this source")
    name = f"release-qualification-attempt-{attempt}"
    response = get_api(f"actions/runs/{stage_id}/artifacts?name={name}&per_page=2")
    require(response["total_count"] == len(response["artifacts"]) == 1,
            "expected one immutable qualification artifact for the selected attempt")
    artifact = response["artifacts"][0]
    require(artifact["name"] == name and artifact["expired"] is False
            and 0 < artifact["size_in_bytes"] <= MAX_RECORD_BYTES
            and type(artifact["id"]) is int, "qualification artifact is invalid or expired")
    archive = output("gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip")
    require(0 < len(archive) <= MAX_RECORD_BYTES, "qualification archive exceeds the allowed size")
    with zipfile.ZipFile(io.BytesIO(archive)) as files:
        require(files.namelist() == [MANIFEST_FILE], "unexpected qualification archive contents")
        require(0 < files.getinfo(MANIFEST_FILE).file_size <= MAX_RECORD_BYTES,
                "qualification record exceeds the allowed size")
        raw = files.read(MANIFEST_FILE)
    require(hashlib.sha256(raw).hexdigest() == expected_hash,
            "qualification record hash differs from the approved hash")
    return json.loads(raw)


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
    source, promotion_id = require_dispatch()
    version = os.environ["RELEASE_VERSION"]
    stage_id = os.environ["STAGE_RUN_ID"]
    attempt = os.environ["STAGE_RUN_ATTEMPT"]
    sha = os.environ["QUALIFICATION_SHA256"]
    index = os.environ["QUALIFIED_INDEX_DIGEST"]
    require(VERSION.fullmatch(version) and IDENTIFIER.fullmatch(stage_id)
            and attempt == "1" and re.fullmatch(r"[0-9a-f]{64}", sha)
            and DIGEST.fullmatch(index), "invalid promotion input")
    approval_comment = f"Promote v{version} {index} {sha}"
    if mode in ("authorize", "promote"):
        approved(promotion_id, approval_comment)
    if mode == "authorize":
        return
    require(json.loads(output("git", "show", "HEAD:package.json"))["version"] == version,
            "package version differs from the authorized release")
    tree = output("git", "rev-parse", "HEAD^{tree}").decode().strip()
    require_tag(version, source)
    record = read_qualification(stage_id, attempt, source, sha)
    plan = alias_plan(version, json.loads(os.environ["EXPECTED_ALIASES"]))
    from release_registry import Registry, verify_qualification

    verify_qualification(record, version=version, source=source, tree=tree,
                         run_id=int(stage_id), run_attempt=int(attempt), index_digest=index)
    registries = {repo: Registry(repo) for repo in REGISTRIES}
    if mode == "preflight":
        check_aliases(registries, plan, index)
        emit_record({"status": "preflight-verified", "source": source, "tree": tree, "version": version,
                     "stageRun": stage_id, "stageAttempt": attempt, "qualificationSha256": sha,
                     "qualifiedIndex": index, "expectedAliases": plan,
                     "requiredApprovalComment": approval_comment})
        return
    require_dispatch()
    require_tag(version, source)
    approved(promotion_id, approval_comment)
    for repository in REGISTRIES:
        verify_copy_plan(repository, index)
    apply_aliases(registries, plan, index, copy_index, emit_record)


def interrupted(_signum, _frame):
    raise InterruptedError("promotion interrupted; inspect registry state before requesting a new dispatch")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ("preflight", "authorize", "promote"),
                "expected preflight, authorize or promote")
        main(sys.argv[1])
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Release gate failed ({type(error).__name__}): {error}", file=sys.stderr)
        sys.exit(1)
