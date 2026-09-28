#!/bin/sh
# Exercise the same nonroot/read-only/zero-capability model used by Kubernetes.
set -eu
runtime=${CONTAINER_RUNTIME:-docker}
api_image=${1:?API image required}
web_image=${2:?web image required}
api_name="opengym-hardening-api-$$"
web_name="opengym-hardening-web-$$"
cleanup() {
  "$runtime" rm -f "$web_name" "$api_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
"$runtime" run -d --name "$api_name" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user 1000:1000 \
  --tmpfs /data:rw,noexec,nosuid,nodev,mode=1777,size=64m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=64m \
  -e PASSWORD_LOGIN=1 "$api_image" >/dev/null
"$runtime" run -d --name "$web_name" --network="container:$api_name" \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 101:101 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=64m \
  -e BACKEND=127.0.0.1 -e NGINX_PORT=8080 "$web_image" >/dev/null
attempt=0
until "$runtime" exec "$web_name" wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    "$runtime" logs "$api_name"
    "$runtime" logs "$web_name"
    exit 1
  fi
  sleep 1
done
"$runtime" exec "$web_name" wget -qO- http://127.0.0.1:8080/ | grep -q '<div id="root">'
test "$("$runtime" exec "$api_name" id -u)" = 1000
test "$("$runtime" exec "$web_name" id -u)" = 101
"$runtime" exec "$api_name" node --input-type=module -e '
  import fs from "node:fs";
  import assert from "node:assert/strict";
  const base = "http://127.0.0.1:8080";
  const signup = await fetch(base + "/api/register/password", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({name:"smoke", password:"smoke-only-long-passphrase-729"})
  });
  assert.equal(signup.status, 200, await signup.text());
  const cookie = signup.headers.get("set-cookie").split(";")[0];
  const save = await fetch(base + "/api/data", {
    method:"PUT", headers:{cookie,"Content-Type":"application/json"},
    body:JSON.stringify({state:{routines:[],workouts:[],unit:"kg"}})
  });
  assert.equal(save.status,200,await save.text());
  const state = await (await fetch(base + "/api/data",{headers:{cookie}})).json();
  assert.equal(state.state.unit,"kg");
  assert.equal(fs.statSync("/data/secret").mode & 0o777,0o600);
  assert.throws(()=>fs.writeFileSync("/app/hardening-must-not-write","x"));
  const {adapterFor} = await import("./coach/adapters/index.js");
  for (const id of ["anthropic","openai","gemini","compatible"]) {
    assert.equal(adapterFor(id).spawns,false);
  }
  const {canDropPrivileges} = await import("./coach/adapters/spawn.js");
  assert.equal(canDropPrivileges().ok,false,"CLI runtime must fail closed as nonroot");
  console.log("nonroot read-only API/web: proxy, signup, state round trip and CLI isolation passed");
'
