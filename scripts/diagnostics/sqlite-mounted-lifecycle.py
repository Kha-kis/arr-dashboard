"""Private, disposable, network-isolated native Docker acceptance."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

candidate, stable = sys.argv[1:3]
identifier = "arr-sqlite-contract-" + uuid.uuid4().hex[:10]
root = pathlib.Path(tempfile.mkdtemp(prefix=identifier + "-"))
active = set()
volume = identifier
password = "Disposal-fixture-login-0029!"
backup_password = "Disposal-fixture-backup-0029!"

def docker(*args, check=True):
    return subprocess.run(["docker", *map(str, args)], check=check, capture_output=True, text=True, timeout=100).stdout.strip()

def state(container):
    return json.loads(docker("inspect", container))[0]["State"]

def create(image, *options):
    cid = docker("create", "--label", f"arr.test={identifier}", "--network", "none",
                 "-e", "TRASH_UPDATE_SCHEDULER_ENABLED=false",
                 "-e", "DISABLE_QUI_CACHE_PREWARM=true", "-e", "HEAP_AUTO_SNAPSHOT=0",
                 "-e", "COOKIE_SECURE=false", "-e", "BACKUP_PASSWORD=" + backup_password,
                 *options, image)
    active.add(cid)
    return cid

def api(cid, path, payload=None, cookie=""):
    source = """const [path,raw,cookie] = process.argv.slice(1);
const options = {headers:{accept:"application/json",cookie}};
if (raw !== "-") {
    options.method="POST";
    options.headers["content-type"]="application/json";
    options.body=raw;
}
fetch("http://127.0.0.1:3001"+path,options).then(async r => {
const text=await r.text(); let body;
try {body=JSON.parse(text)} catch {body=text}
console.log(JSON.stringify({status:r.status,body,cookie:r.headers.getSetCookie().map(x=>x.split(";")[0]).join("; ")}));
}).catch(()=>process.exit(2));"""
    out = docker("exec", cid, "node", "-e", source, path,
                 "-" if payload is None else json.dumps(payload), cookie, check=False)
    return json.loads(out) if out else None

def ready(cid, max_seconds=50):
    began = time.monotonic()
    while time.monotonic()-began < max_seconds:
        info = state(cid)
        if not info["Running"]:
            raise AssertionError("exited before readiness: " + docker("logs", cid))
        result = api(cid, "/health")
        if result and result["status"] == 200 and result["body"].get("status") == "ok":
            return result["body"]
        time.sleep(0.7)
    raise AssertionError("readiness timed out")

def stop(cid):
    docker("stop", "-t", 20, cid)
    observed = state(cid)
    assert observed["Status"] == "exited" and observed["ExitCode"] == 0 and not observed["OOMKilled"], observed

def remove(cid):
    docker("rm", "-f", cid)
    active.remove(cid)

def db_stamp(cid):
    return docker("exec", cid, "stat", "-c", "%d:%i:%u:%g", "/config/prod.db")

def register(cid, account):
    response = api(cid, "/auth/register", {"username": account, "password": password})
    assert response and response["status"] in (200,201), response and response["status"]
    return login(cid, account)

def login(cid, account):
    response = api(cid, "/auth/login", {"username": account, "password": password})
    assert response and response["status"] == 200 and response["cookie"], response and response["status"]
    return response["cookie"]

def assert_refused(cid, prior_storage):
    docker("start", cid)
    code = docker("wait", cid)
    assert int(code) != 0
    log = subprocess.run(["docker", "logs", cid], capture_output=True, text=True, check=True)
    assert "sqlite-mount-required" in (log.stdout + log.stderr)
    assert "schema-apply" not in (log.stdout + log.stderr)
    changes = [entry for entry in docker("diff", cid).splitlines() if "/config/prod.db" in entry]
    assert changes == prior_storage, (changes, prior_storage)
    assert not state(cid)["OOMKilled"]

def report(case, **details):
    print(json.dumps({"case":case,"passed":True,**details}), flush=True)

try:
    docker("volume", "create", "--label", f"arr.test={identifier}", volume)
    mount = ("--mount", f"type=volume,src={volume},dst=/config")
    fresh = create(candidate)
    assert_refused(fresh, [])
    remove(fresh)
    report("empty writable layer refused before database or coordinator creation")

    scratch_database = root / "legacy-data"
    scratch_database.mkdir()
    old = create(stable)
    docker("start", old)
    ready(old)
    source_stamp = db_stamp(old)
    user = "source-storage-check"
    cookie = register(old, user)

    backup = api(old, "/api/backup/create", {}, cookie)
    assert backup and backup["status"] == 200, backup and backup["status"]
    assert backup["body"].get("id")
    outfile = scratch_database / "source-backup.arr-backup"
    # Resolve and export the exact retained file by its authenticated API ID.
    source = """const [path,cookie]=process.argv.slice(1);
fetch("http://127.0.0.1:3001"+path,{headers:{cookie}}).then(async r=>{
if(!r.ok)throw Error(String(r.status));
process.stdout.write(Buffer.from(await r.arrayBuffer()).toString("base64"));
}).catch(()=>process.exit(2));"""
    backup_bytes = docker("exec", old, "node", "-e", source,
                          "/api/backup/" + backup["body"]["id"] + "/download", cookie)
    assert backup_bytes
    stop(old)
    docker("cp", f"{old}:/config/prod.db", scratch_database / "prod.db")
    current = create(candidate)
    docker("cp", scratch_database / "prod.db", f"{current}:/config/prod.db")
    legacy_objects = [entry for entry in docker("diff", current).splitlines() if "/config/prod.db" in entry]
    assert legacy_objects == ["A /config/prod.db"]
    assert_refused(current, legacy_objects)
    docker("cp", f"{current}:/config/prod.db", scratch_database / "refused.db")
    assert (scratch_database/"prod.db").read_bytes() == (scratch_database/"refused.db").read_bytes()
    remove(current)
    report("legacy writable layer database refused and bytes preserved")

    dest = create(candidate, *mount, "-e", "PUID=1000", "-e", "PGID=100")
    docker("start", dest)
    ready(dest)
    stamp = db_stamp(dest)
    assert stamp != source_stamp and stamp.endswith(":1000:100")
    destination_cookie = register(dest, "destination-storage-check")
    restore = api(dest, "/api/backup/restore", {"backupData":backup_bytes, "password":backup_password},
                  destination_cookie)
    assert restore and restore["status"] == 200 and restore["body"].get("restoreId"), restore and restore["status"]
    restore_id = restore["body"]["restoreId"]
    for _ in range(30):
        response = api(dest, "/auth/setup-required")
        if response and response["status"] == 200 and not response["body"]["required"]:
            if "automatic-requested" in json.dumps(restore["body"]):
                log = subprocess.run(["docker", "logs", dest], capture_output=True, text=True, check=True)
                if "restart" not in (log.stdout+log.stderr).lower():
                    time.sleep(.75)
                    continue
            break
        time.sleep(.75)
    stop(dest)
    docker("start", dest)
    ready(dest)
    dest_cookie = login(dest,user)
    status = api(dest,"/api/backup/restore/status",cookie=dest_cookie)
    assert status and status["status"] == 200 and status["body"]["latestCommitted"]["restoreId"] == restore_id
    assert db_stamp(dest) == stamp
    stop(dest)
    remove(dest)
    dest = create(candidate, *mount, "-e", "PUID=1000", "-e", "PGID=100")
    docker("start",dest)
    ready(dest)
    assert db_stamp(dest) == stamp
    login(dest,user)
    stop(dest)
    remove(dest)
    assert state(old)["Status"] == "exited"
    report("legacy encrypted backup restored into new named storage and verified after restart and replacement",
           destination_binding_unchanged=True,source_retained_through_verification=True)
    remove(old)

    upgrade = root / "upgrade"
    upgrade.mkdir()
    options = ("--mount",f"type=bind,src={upgrade},dst=/config","-e","PUID=568","-e","PGID=568")
    prior = create(stable,*options)
    docker("start",prior)
    ready(prior)
    register(prior,"mounted-upgrade-check")
    original_stamp = db_stamp(prior)
    stop(prior)
    upgraded = create(candidate,*options)
    docker("start",upgraded)
    ready(upgraded)
    login(upgraded,"mounted-upgrade-check")
    assert db_stamp(upgraded) == original_stamp
    stop(upgraded)
    remove(upgraded)
    remove(prior)
    report("stable v2.25.0 upgraded by replacing container and retaining the owned ext4 bind")

    bind = root / "rootless"
    bind.mkdir()
    options = ("--mount",f"type=bind,src={bind},dst=/config")
    docker("run","--rm","--network","none",*options,"--entrypoint","chown",candidate,"1000:100","/config")
    rootless = create(candidate,*options,"--user","1000:100")
    docker("start",rootless)
    ready(rootless)
    stamp = db_stamp(rootless)
    assert stamp.endswith(":1000:100")
    stop(rootless)
    docker("start",rootless)
    ready(rootless)
    assert db_stamp(rootless) == stamp
    stop(rootless)
    remove(rootless)
    report("rootless ext4 bind fresh, clean stop and restart")
finally:
    for cid in active:
        docker("rm","-f",cid,check=False)
    docker("volume","rm",volume,check=False)
    subprocess.run(["sudo","-n","rm","-rf","--",root],check=True)
