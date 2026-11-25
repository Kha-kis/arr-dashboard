"""Disposable, read-only identity observer for the native ARM64 restart gate."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
token = uuid.uuid4().hex
label = "org.arr-dashboard.restart-diagnostic"
repo = "ghcr.io/kha-kis/arr-dashboard"
images = {
    "published": ("2.25.0", "db63d1a66705e0b9e57107ac08b7d88fe4e34ade",
                  "sha256:38982ae25af50ec455ccbce05f02d79c755d542f8995cc7aaa3b916a1c1acdb0"),
    "staged": ("2.25.1", "003049ad3a6e56cb941fa05eeaf006d9967ea443",
               "sha256:bf9420386f6b9f59449b2e4fa647f6288b92a5254aa9feec18866ee2784f349d"),
}
paths = {"database": "/config/prod.db", "directory": "/config"}
paths["coordination"] = paths["database"] + ".arr-restore-runtime"
for item in ("owner", "operations"):
    paths[item] = paths["coordination"] + "/" + item + ".sqlite3"
registry = {}
containers = {}
result = {"runner": {}, "images": {}, "cases": []}


def run(*args, check=True, timeout=40):
    return subprocess.run(("docker", *args), check=check, timeout=timeout, text=True, capture_output=True)


def info(cid):
    return json.loads(run("inspect", cid).stdout)[0]


def owned(cid):
    role, expected_image, expected_mount = containers[cid]
    current = info(cid)
    assert current["Id"] == cid and current["Image"] == expected_image
    assert current["Config"]["Labels"][label] == token and current["Name"] == "/" + role
    assert not current["HostConfig"]["Privileged"] and current["HostConfig"]["RestartPolicy"]["Name"] == "no"
    binds = [x for x in current["Mounts"] if x["Destination"] == "/config"]
    if expected_mount is not None:
        assert len(binds) == 1 and binds[0]["Type"] == "bind" and binds[0]["Source"] == str(expected_mount)
    return current


def stamp(path):
    try:
        s = os.lstat(path)
        return {"device": str(s.st_dev), "inode": str(s.st_ino), "uid": s.st_uid,
                "gid": s.st_gid, "mode": oct(s.st_mode & 0o7777), "links": s.st_nlink}
    except FileNotFoundError:
        return None


def decode(text):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), text)


def mounts_for(pid):
    chosen = {}
    for line in Path(f"/proc/{pid}/mountinfo").read_text().splitlines():
        left, right = line.split(" - ", 1)
        bits, rest = left.split(), right.split()
        mountpoint = decode(bits[4])
        for key, path in paths.items():
            if path == mountpoint or path.startswith(mountpoint.rstrip("/") + "/"):
                if key not in chosen or len(mountpoint) >= len(chosen[key][0]):
                    chosen[key] = (mountpoint, {"mountId": bits[0], "majorMinor": bits[2], "type": rest[0]},
                                   next((decode(v[9:]) for v in rest[2].split(",") if v.startswith("upperdir=")), None))
    return chosen


def runtime_users(pid):
    todo, seen, roles = [pid], set(), {}
    for _ in range(64):
        if not todo:
            break
        n = todo.pop()
        if n in seen:
            continue
        seen.add(n)
        try:
            prefix = Path(f"/proc/{n}")
            todo.extend(int(v) for v in (prefix / "task" / str(n) / "children").read_text().split())
            cmd = (prefix / "cmdline").read_bytes().split(b"\0")
            for key, suffix in (("schema", b"/schema-startup.js"), ("api", b"/launcher.js")):
                if any(arg.endswith(suffix) or arg == b"dist" + suffix for arg in cmd):
                    status = (prefix / "status").read_text()
                    roles[key] = {k.lower(): int(re.search(rf"^{k}:\s+\d+\s+(\d+)", status, re.M)[1])
                                  for k in ("Uid", "Gid")}
        except (OSError, ProcessLookupError):
            continue
    return roles


def backing(current, chosen=None):
    bind = next((Path(x["Source"]) for x in current["Mounts"] if x["Destination"] == "/config"), None)
    graph = current.get("GraphDriver") or {}
    upper = (graph.get("Data") or {}).get("UpperDir")
    if not upper and chosen:
        upper = chosen.get("directory", ("", {}, None))[2]
    stamps = None
    if bind:
        stamps = {key: stamp(bind / Path(path).relative_to("/config")) for key, path in paths.items()}
    elif upper and Path(upper).is_absolute():
        stamps = {key: stamp(Path(upper) / path.lstrip("/")) for key, path in paths.items()}
    identity = None
    if bind or upper:
        identity = hashlib.sha256(os.fsencode(bind or upper)).hexdigest()
    return {"kind": "host-config-mount" if bind else ("overlay-upper" if upper else "unavailable"),
            "pathFingerprint": identity, "objects": stamps}


def observe(cid):
    current = owned(cid)
    pid = current["State"]["Pid"]
    if not pid:
        return None
    try:
        chosen = mounts_for(pid)
        return {"pid": pid, "view": {k: stamp(f"/proc/{pid}/root{v}") for k, v in paths.items()},
                "mounts": {k: data[1] for k, data in chosen.items()}, "backing": backing(current, chosen),
                "roles": runtime_users(pid)}
    except (FileNotFoundError, ProcessLookupError):
        return None


HEALTH = """
(async () => {
 const [a,b]=await Promise.all([fetch('http://127.0.0.1:3001/health',{signal:AbortSignal.timeout(2000)}),
 fetch('http://127.0.0.1:3000/login',{signal:AbortSignal.timeout(2000)})]);
 const h=await a.json(); await b.body?.cancel();
 if(!a.ok||!b.ok||h.status!=='ok'||h.commit!==process.argv[1]||h.version!==process.argv[2])process.exitCode=1;
})().catch(()=>process.exitCode=1);
"""
READ_BINDING = """
const fs=require('node:fs');
const paths=JSON.parse(process.argv[1]);
const Binding=require(require.resolve('better-sqlite3',{paths:['/app/api/providers/sqlite','/app/api']}));
const columns=Object.keys(paths).flatMap(k=>[k+'Device',k+'Inode']).concat(['id','protocolVersion']);
const db=new Binding(paths.database,{readonly:true,fileMustExist:true,timeout:1500});
let stored;
try {
 stored=db.prepare('SELECT '+columns.join(',')+' FROM SqliteRestoreStorageBinding LIMIT 2').all();
} finally {db.close();}
const view=Object.fromEntries(Object.entries(paths).map(([k,p])=>{let s=fs.lstatSync(p,{bigint:true});
return [k,{device:String(s.dev),inode:String(s.ino)}]}));
console.log(JSON.stringify({stored,view,filesystemMagic:fs.statfsSync(paths.directory,{bigint:true}).type.toString()}));
"""


def read_binding(cid, identity):
    uid, gid = registry[identity]["uid"], registry[identity]["gid"]
    return json.loads(run("exec", "--user", f"{uid}:{gid}", cid, "node", "-e", READ_BINDING, json.dumps(paths)).stdout)


def changes(stored, observed):
    if len(stored) != 1 or not observed:
        return None
    row = stored[0]
    mismatch = {}
    for key in paths:
        value = observed.get(key)
        for field in ("device", "inode"):
            column = key + field.capitalize()
            got = value[field] if value is not None else None
            if str(row[column]) != got:
                mismatch[column] = {"stored": row[column], "observed": got}
    for column in ("id", "protocolVersion"):
        if row[column] != 1:
            mismatch[column] = {"stored": row[column], "required": 1}
    return mismatch


def boot(cid, identity, epoch, case, previous=None):
    observations, errors = [], []
    stop = threading.Event()
    def monitor():
        while not stop.is_set():
            try:
                current = observe(cid)
                if current and (not observations or current != observations[-1]):
                    observations.append(current)
            except Exception as exc:
                errors.append(type(exc).__name__)
            stop.wait(.025)
    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    version, commit, _ = images[identity]
    entry = {"phase": epoch, "ready": False}
    case["boots"].append(entry)
    try:
        run("start", cid)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if not owned(cid)["State"]["Running"]:
                break
            if run("exec", cid, "node", "-e", HEALTH, commit, version, check=False, timeout=12).returncode == 0:
                entry["ready"] = True
                entry["binding"] = read_binding(cid, identity)
                entry["viewAtReadiness"] = observe(cid)
                assert entry["viewAtReadiness"] is not None
                actual = entry["viewAtReadiness"]["view"]
                assert all(entry["binding"]["view"][k] == {"device": v["device"], "inode": v["inode"]}
                           for k, v in actual.items())
                entry["storedVsLive"] = changes(entry["binding"]["stored"], actual)
                break
            time.sleep(.7)
        if not entry["ready"]:
            log = run("logs", cid).stdout + run("logs", cid).stderr
            entry["failureEvents"] = []
            for line in log.splitlines():
                if not line.startswith("{"):
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("category") == "sqlite-startup-phase" and row.get("outcome") == "failed":
                    entry["failureEvents"].append({k: row.get(k) for k in ("phase", "errorCategory", "code")})
    finally:
        stop.set()
        watcher.join(timeout=45)
        assert not watcher.is_alive()
        entry["observations"] = observations
        entry["observerErrors"] = sorted(set(errors))
        if previous:
            complete = [x for x in observations if all(v is not None for v in x["view"].values())]
            entry["beforeStoredVsObserved"] = [changes(previous["binding"]["stored"], x["view"]) for x in complete]
    return entry


def clean_stop(cid):
    if owned(cid)["State"]["Running"]:
        run("stop", "--time", "120", cid, timeout=140)
    m = owned(cid)
    s = m["State"]
    return {"pid": s["Pid"], "exitCode": s["ExitCode"], "oomKilled": s["OOMKilled"],
            "clean": s["Pid"] == 0 and s["ExitCode"] == 0 and not s["OOMKilled"], "backing": backing(m)}


def create(identity, case, bind=None, helper=False):
    role = f"arr-v2251-{token[:8]}-{case}"
    image = registry[identity]["id"]
    args = ["create", "--pull=never", "--name", role, "--label", label+"="+token]
    if bind is not None:
        args += ["--mount", f"type=bind,source={bind},target=/config"]
    if helper:
        args += ["--network", "none", "--entrypoint", "/bin/sh", image, "-c", "sleep 240"]
    else:
        args += ["-p", "127.0.0.1:3000:3000", "-p", "127.0.0.1:3001:3001", image]
    cid = run(*args).stdout.strip()
    containers[cid] = (role, image, bind)
    owned(cid)
    return cid


def remove(cid):
    clean_stop(cid)
    assert not owned(cid)["State"]["Running"]
    run("rm", "-v", cid)
    containers.pop(cid)


def test_case(identity, topology, root):
    case = {"image": identity, "topology": topology, "boots": [], "stops": []}
    result["cases"].append(case)
    bind = None
    if topology == "bind":
        bind = root / (identity+"-config")
        bind.mkdir(mode=0o700)
        os.chown(bind, registry[identity]["uid"], registry[identity]["gid"])
    cid = create(identity, identity+"-"+topology, bind)
    m = owned(cid)
    case["docker"] = {"id": cid, "graphDriver": (m.get("GraphDriver") or {}).get("Name"),
                      "mounts": [{"type": x["Type"], "destination": x["Destination"], "rw": x["RW"]}
                                 for x in m["Mounts"]],
                      "networkMode": m["HostConfig"]["NetworkMode"], "user": m["Config"]["User"],
                      "imageDefaultIdentity": {k: registry[identity][k] for k in ("uid", "gid")}}
    first = boot(cid, identity, "fresh", case)
    if not first["ready"]:
        remove(cid)
        return
    for provider in ("sqlite", "postgresql"):
        run("exec", cid, "node", "/app/api/validate-provider-runtime.cjs",
            f"/app/api/providers/{provider}", provider, timeout=55)
    stop = clean_stop(cid)
    case["stops"].append(stop)
    assert stop["clean"]
    second = boot(cid, identity, "same-container", case, first)
    stop = clean_stop(cid)
    case["stops"].append(stop)
    if topology == "bind":
        if not second["ready"]:
            remove(cid)
            return
        assert stop["clean"]
        remove(cid)
        partner = "staged" if identity == "published" else identity
        next_cid = create(partner, identity+"-replacement", bind)
        boot(next_cid, partner, "bind-replacement", case, second)
        case["stops"].append(clean_stop(next_cid))
        remove(next_cid)
    else:
        if second["ready"]:
            assert stop["clean"]
            helpers = []
            try:
                for n in range(3):
                    helper = create(identity, identity+f"-overlay-neighbor-{n}", helper=True)
                    helpers.append(helper)
                    run("start", helper)
                case["neighbors"] = [observe(h) for h in helpers]
                boot(cid, identity, "same-container-with-neighbor-mounts", case, second)
                case["stops"].append(clean_stop(cid))
            finally:
                for h in reversed(helpers):
                    remove(h)
        remove(cid)
    print(json.dumps({"case":identity+"/"+topology,"boots":[[x["phase"],x["ready"],x.get("failureEvents")]
                                                                     for x in case["boots"]]}),flush=True)


def main():
    assert platform.machine() == "aarch64" or os.environ.get("ARR_DIAGNOSTIC_LOCAL_SMOKE") == "1"
    d = json.loads(run("info", "--format", "{{json .}}").stdout)
    result["runner"] = {k: d.get(k) for k in ("Driver", "DriverStatus", "KernelVersion", "OperatingSystem",
                                             "Architecture", "ServerVersion", "DockerRootDir")}
    result["runner"].pop("DockerRootDir",None)
    result["runner"]["machine"] = platform.machine()
    for identity,(version,commit,digest) in images.items():
        ref = repo+"@"+digest
        expected_arch = "amd64" if platform.machine()=="x86_64" else "arm64"
        run("pull","--platform","linux/"+expected_arch,ref,timeout=180)
        m = json.loads(run("image","inspect",ref).stdout)[0]
        labels = m["Config"]["Labels"]
        assert m["Architecture"] == expected_arch and m["Os"] == "linux"
        assert labels["org.opencontainers.image.version"] == version
        assert labels["org.opencontainers.image.revision"] == commit
        values = dict(x.split("=",1) for x in m["Config"]["Env"])
        registry[identity] = {"id":m["Id"],"uid":int(values["PUID"]),"gid":int(values["PGID"]),"digest":digest,
                              "version":version,"commit":commit,"architecture":m["Architecture"],
                              "declaredVolumes":sorted((m["Config"]["Volumes"] or {}).keys())}
    assert registry["published"]["uid"]==registry["staged"]["uid"]
    assert registry["published"]["gid"]==registry["staged"]["gid"]
    result["images"] = registry
    with tempfile.TemporaryDirectory(prefix="arr-restart-fixture-") as td:
        for topology in ("qualification","bind"):
            for identity in images:
                test_case(identity,topology,Path(td))


try:
    main()
finally:
    try:
        for cid in list(containers):
            remove(cid)
    finally:
        result["cleanupComplete"] = not containers
        (out / "result.json").write_text(json.dumps(result, indent=2)+"\n")
