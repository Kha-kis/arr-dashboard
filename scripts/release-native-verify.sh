#!/usr/bin/env bash
set -euo pipefail
: "${CANDIDATE_IMAGE:?}" "${CANDIDATE_DIGEST:?}" "${CANDIDATE_MANIFEST_DIGEST:?}" "${CONFIG_DIGEST:?}" "${SOURCE_SHA:?}" "${SOURCE_TREE:?}" "${VERSION:?}" "${BUILD_DATE:?}" "${ARCH:?}" "${RUN_ID:?}"
case "$ARCH" in amd64) expected_arch=x86_64 ;; arm64) expected_arch=aarch64 ;; *) exit 2 ;; esac
test "$(uname -m)" = "$expected_arch"
for digest in "$CANDIDATE_DIGEST" "$CANDIDATE_MANIFEST_DIGEST" "$CONFIG_DIGEST"; do [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; done
test "$(docker image inspect --format '{{.Architecture}}' "$CANDIDATE_IMAGE")" = "$ARCH"
mkdir -p "$RUNNER_TEMP/release"
cid=""
volume=""
cleanup() {
  if [[ -n "$cid" ]]; then docker rm -f "$cid" >/dev/null 2>&1 || true; fi
  if [[ -n "$volume" ]]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
volume="$(docker volume create --label "arr-release-qualification=$RUN_ID" \
  "arr-native-$RUN_ID-$ARCH-$(cat /proc/sys/kernel/random/uuid)")"
cid="$(docker run -d --label "arr-release-qualification=$RUN_ID" \
  --mount "type=volume,src=$volume,dst=/config" \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 "$CANDIDATE_IMAGE")"
wait_ready() {
  for _ in $(seq 1 180); do
    if docker exec "$cid" node -e 'Promise.all([fetch("http://127.0.0.1:3001/health").then(async r=>{const j=await r.json();return r.ok&&j.status==="ok"&&j.commit===process.argv[1]&&j.version===process.argv[2]}),fetch("http://127.0.0.1:3000/login").then(r=>r.ok)]).then(x=>process.exit(x.every(Boolean)?0:1)).catch(()=>process.exit(1))' "$SOURCE_SHA" "$VERSION" >/dev/null 2>&1; then return 0; fi
    test "$(docker inspect --format '{{.State.Running}}' "$cid")" = true || break
    sleep 1
  done
  docker logs "$cid"
  return 1
}
wait_ready
docker exec "$cid" node /app/api/validate-provider-runtime.cjs /app/api/providers/sqlite sqlite
docker exec "$cid" node /app/api/validate-provider-runtime.cjs /app/api/providers/postgresql postgresql
asset_hash() {
 docker exec "$cid" node -e '
 const fs=require("node:fs"),p=require("node:path"),c=require("node:crypto");
 const root=fs.realpathSync(process.argv[1]),h=c.createHash("sha256"),base="/app";
 if(!root.startsWith(base+"/"))throw Error("asset escaped application root");
 function visit(dir,rel=""){
   for(const n of fs.readdirSync(dir).sort()){
     const r=rel?rel+"/"+n:n;
     if(r.split("/").some((v,i,a)=>v===".next"&&a[i+1]==="cache"))continue;
     const f=p.join(dir,n),st=fs.lstatSync(f);
     if(st.isSymbolicLink()){
       const target=fs.readlinkSync(f);
       if(!fs.realpathSync(f).startsWith(base+"/"))throw Error("asset symlink escaped application root: "+r);
       h.update("l\0"+r+"\0"+target+"\0");
     }else if(st.isDirectory()){
       h.update("d\0"+r+"\0");visit(f,r);
     }else if(st.isFile()){
       h.update("f\0"+r+"\0");h.update(fs.readFileSync(f));
     }else throw Error("special asset");
   }
 }
 visit(root);process.stdout.write(h.digest("hex"));
 ' "$1"
}
WEB_HASH="$(asset_hash /app/web)"
SQLITE_HASH="$(asset_hash /app/api/providers/sqlite)"
POSTGRES_HASH="$(asset_hash /app/api/providers/postgresql)"
# A clean stop followed by successful readiness verifies lifecycle on the exact image.
docker stop --time 120 "$cid" >/dev/null
test "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}' "$cid")" = "exited 0 false"
docker start "$cid" >/dev/null
wait_ready
# The 15 browser cases exercise this image while its actual web/API processes are live.
CI=true PLAYWRIGHT_JSON_OUTPUT_FILE="$RUNNER_TEMP/release/playwright.json" \
  pnpm exec playwright test e2e/trash-cache-mobile.spec.ts --project=chromium --retries=0 --reporter=json
node - "$RUNNER_TEMP/release/playwright.json" <<'NODE'
const fs=require("node:fs"),assert=require("node:assert/strict");
const report=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));let cases=[];
function visit(s){for(const spec of s.specs||[])for(const t of spec.tests||[])if(t.projectName==="chromium")cases.push(t);for(const child of s.suites||[])visit(child)}
for(const suite of report.suites||[])visit(suite);
assert.equal(cases.length,15,"expected exactly 15 mobile browser cases");
for(const [i,t] of cases.entries()){assert.equal(t.expectedStatus,"passed",`case ${i+1} expected pass`);assert.equal(t.results?.length,1,`case ${i+1} must run once`);assert.equal(t.results[0].status,"passed",`case ${i+1} must pass without skip`)}
NODE
docker stop --time 120 "$cid" >/dev/null
test "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}' "$cid")" = "exited 0 false"
docker rm "$cid" >/dev/null
cid=""
docker volume rm "$volume" >/dev/null
volume=""
storage_receipt="$RUNNER_TEMP/release/sqlite-storage.json"
python3 -B scripts/release_sqlite_storage.py "$CANDIDATE_IMAGE" "$ARCH" "$storage_receipt"
jq -n --slurpfile storage "$storage_receipt" --arg arch "$ARCH" --arg index "$CANDIDATE_DIGEST" --arg digest "$CANDIDATE_MANIFEST_DIGEST" --arg config "$CONFIG_DIGEST" --arg source "$SOURCE_SHA" --arg tree "$SOURCE_TREE" --arg version "$VERSION" --arg date "$BUILD_DATE" --arg web "$WEB_HASH" --arg sqlite "$SQLITE_HASH" --arg pg "$POSTGRES_HASH" '{architecture:$arch,indexDigest:$index,manifestDigest:$digest,configDigest:$config,source:$source,tree:$tree,version:$version,buildDate:$date,assets:{web:$web,sqlite:$sqlite,postgresql:$pg},runtime:{healthy:true,cleanStop:true,restart:true,browserCases:15},sqliteStorage:$storage[0]}' > "$RUNNER_TEMP/release-receipt.json"
echo "CONFIG_DIGEST=$CONFIG_DIGEST" >> "$GITHUB_ENV"
