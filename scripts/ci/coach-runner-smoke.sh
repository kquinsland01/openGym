#!/bin/sh
# No paid calls: exercise authenticated IPC in separate restricted containers.
set -eu
runtime=${CONTAINER_RUNTIME:-docker}
api_image=${1:?API image required}
runner_image=${2:?runner-fixture image required}
api_name="opengym-runner-client-$$"
runner_name="opengym-runner-$$"
volume="opengym-runner-ipc-$$"
keys=$(mktemp -d)
cleanup() {
  "$runtime" rm -f "$api_name" "$runner_name" >/dev/null 2>&1 || true
  "$runtime" volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$keys"
}
trap cleanup EXIT HUP INT TERM
# Generated throwaway key files are readable by their mounted container only.
openssl genpkey -algorithm ED25519 -out "$keys/private.pem" 2>/dev/null
openssl pkey -in "$keys/private.pem" -pubout -out "$keys/public.pem" 2>/dev/null
chmod 644 "$keys/private.pem" "$keys/public.pem"
"$runtime" volume create "$volume" >/dev/null
# Prepare shared socket volume for differing numeric UIDs without host ownership assumptions.
"$runtime" run --rm --user 0:0 -v "$volume:/run/coach" --entrypoint sh "$api_image" \
  -c 'chown 1100:1000 /run/coach; chmod 2770 /run/coach'
"$runtime" run -d --name "$runner_name" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user 1100:1000 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=64m \
  -v "$volume:/run/coach" -v "$keys/public.pem:/run/coach-verification/public.pem:ro" \
  -e COACH_RUNNER_FIXTURE_MODE=isolation "$runner_image" >/dev/null
"$runtime" run -d --name "$api_name" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user 1000:1000 \
  --tmpfs /data:rw,noexec,nosuid,nodev,mode=1777,size=64m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=64m \
  -v "$volume:/run/coach" -v "$keys/private.pem:/run/coach-signing/private.pem:ro" \
  -e COACH_RUNNER_SOCKET=/run/coach/runner.sock "$api_image" >/dev/null
attempt=0
until "$runtime" exec "$api_name" test -S /run/coach/runner.sock; do
  attempt=$((attempt + 1)); test "$attempt" -lt 30 || exit 1; sleep 1
done
"$runtime" exec "$api_name" node --input-type=module -e '
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import { adapterFor } from "./coach/adapters/index.js";
  fs.writeFileSync("/data/runner-must-not-read", "private-api-sentinel", {mode:0o600});
  const adapter = adapterFor("fixture");
  assert.equal(adapter.remote, true);
  assert.equal((await adapter.check()).ok, true);
  const result = await adapter.invoke({prompt:"test Coach", env:{}, timeoutMs:5000});
  assert.equal(result.code, 0, JSON.stringify(result));
  const report = JSON.parse(result.text);
  assert.equal(report.dataAbsent,true);
  assert.equal(report.signingKeyAbsent,true);
  assert.equal(report.uid,1100);
  assert.equal(report.homeIsJob,true);
  assert.equal(report.credentialAbsent,true);
  assert.equal(fs.readFileSync("/data/runner-must-not-read","utf8"),"private-api-sentinel");
  console.log("signed fixture invocation: isolated UID/private HOME, no API data/signing key");
'
"$runtime" exec "$runner_name" node --input-type=module -e '
  import fs from "node:fs";
  import assert from "node:assert/strict";
  assert.equal(fs.existsSync("/data"),false);
  assert.equal(fs.existsSync("/run/coach-signing"),false);
  assert.equal(fs.readdirSync("/tmp").some(n=>n.startsWith("coach-runner-")),false);
'
