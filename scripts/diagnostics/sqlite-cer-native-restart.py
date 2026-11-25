"""Native, network-isolated exact-code CER fault runs. The Node preload is test-only."""
import json
import pathlib
import subprocess
import sys
import tempfile
import time

IMAGE = sys.argv[1]
FAULT = r"""
const Database = require("/app/api/providers/sqlite/node_modules/better-sqlite3");
const {readFileSync, writeFileSync, existsSync}=require("node:fs");
const original=Database.prototype.exec;
const marker="/config/disposable-probe-fired";
const mode=process.env.ARR_TEST_BOUNDARY;
function fail(number) {
    writeFileSync(marker,String(number));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,11000);
    throw Object.assign(new Error("Synthetic controlled fault"),{code:"SQLITE_BUSY"});
}
Database.prototype.exec=function(sql) {
    const prior=existsSync(marker)?Number(readFileSync(marker,"utf8")):0;
    const main=this.name==="/config/prod.db";
    const commit=main && sql.trim()==="COMMIT";
    if (!prior && mode==="unattributed" &&
        this.name.endsWith("/owner.sqlite3") &&
        sql.includes("CREATE TABLE RestoreOwnerCoordination")) fail(1);
    if (!prior && mode==="publishing" && commit &&
        this.prepare("SELECT 1 FROM sqlite_schema WHERE name='ArrSchemaMigrationReceipt'").get())
        fail(1);
    const result=original.call(this,sql);
    if (mode==="resumable" && commit && prior<2 &&
        this.prepare("SELECT 1 FROM sqlite_schema WHERE name='ArrSqliteEnrollmentIntent'").get()) {
        const row=this.prepare("SELECT payload FROM ArrSqliteEnrollmentIntent").get();
        const intent=JSON.parse(row.payload);
        if (intent.phase==="preparing" && intent.objects.length===prior+1) fail(prior+1);
    }
    return result;
};
"""
def run(*args, check=True):
    p = subprocess.run(args, check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    return p.stdout.strip()

def phases(logs):
    for line in logs.splitlines():
        if line.startswith("{"):
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("category") == "sqlite-startup-phase" and row.get("outcome") == "failed":
                yield row["phase"]

for case in ("resumable", "unattributed", "publishing"):
    root = pathlib.Path(tempfile.mkdtemp(prefix="arr-cer-native-"))
    config = root / "config"
    config.mkdir()
    hook = root / "inject.cjs"
    hook.write_text(FAULT)
    container = ""
    try:
        container = run("docker","run","-d","--network","none","--restart","unless-stopped","--stop-timeout","120",
                        "--label","arr.test=sqlite-enrollment-disposable",
                        "--mount",f"type=bind,src={config},dst=/config",
                        "--mount",f"type=bind,src={hook},dst=/test/cer.cjs,readonly",
                        "-e","PUID=1000","-e","PGID=100","-e",f"ARR_TEST_BOUNDARY={case}",
                        "-e","NODE_OPTIONS=--require=/test/cer.cjs",IMAGE)
        for _ in range(90):
            logs = subprocess.run(["docker","logs",container],capture_output=True,text=True,check=True,timeout=10)
            first_failures = list(phases(logs.stderr + "\n" + logs.stdout))
            count = int(run("docker","inspect","--format","{{.RestartCount}}",container))
            health = subprocess.run(["docker","exec",container,"node","-e",
                       'fetch("http://127.0.0.1:3001/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'],
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8).returncode
            if case == "resumable" and count >= 2 and health == 0:
                assert (config/"disposable-probe-fired").read_text()=="2"
                assert first_failures.count("enrollment-object-checkpoint") == 2
                run("docker","stop","-t","30",container)
                assert run("docker","inspect","--format","{{.State.ExitCode}} {{.State.OOMKilled}}",container) == "0 false"
                break
            if case != "resumable" and count >= 1 and "cold-enrollment-check" in first_failures:
                phase = "coordination-enrollment" if case=="unattributed" else "commit"
                assert phase in first_failures and health != 0
                break
            time.sleep(1)
        else:
            raise AssertionError((case,logs.stderr[-5000:]))
        print(json.dumps({"case":case,"restartCount":count,"ready":case=="resumable","passed":True}),flush=True)
    finally:
        if container:
            run("docker","rm","-f",container,check=False)
        if root.resolve().parent != pathlib.Path(tempfile.gettempdir()).resolve() or not root.name.startswith("arr-cer-native-"):
            raise RuntimeError("Unexpected disposable path")
        run("sudo","-n","rm","-rf","--",root)
