# Nonroot Coach runner

The default API stays UID 1000 with `/data` as its only persistent writable path.
HTTP providers still run directly. For CLI-backed Coach, deploy the optional
`kubernetes-coach` overlay and build the API Dockerfile's `runner` target from the
same commit. It runs UID 1100 with a read-only root, dropped capabilities and no
privilege escalation. **Never mount `/data`, the API signing key, host paths, the
container engine socket, or a ServiceAccount token into the runner.** The runner
refuses startup if `/data` exists. Keep pod process namespaces separate (the default).
The lightweight `runner-fixture` target exercises the same isolation without SDKs.

The API signs requests with Ed25519. Only the API receives the private key; the
runner receives the public key. The Unix socket is on a dedicated memory emptyDir,
mode 0660, group 1000. Readiness/liveness perform bounded socket requests and
expect an authentication refusal, proving event-loop responsiveness without running
a job or logging probes. There is no TCP listener or remotely addressable execution
endpoint. Signatures cover the entire request, timestamp and nonce. A 30-second
clock window and bounded replay cache reject reused requests. Requests cannot
select executable paths, commands, environment names, working directories or files.
Only fixture, Claude SDK and Codex adapters are registered. A request contains its
prompt, constrained model name, timeout and at most one provider-specific credential.

Generate keys locally with restrictive permissions, then provision them out of band
(or use your secret manager); do not commit private material:

```sh
umask 077
openssl genpkey -algorithm ED25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
kubectl -n fitness create secret generic opengym-coach-signing --from-file=private.pem
kubectl -n fitness create configmap opengym-coach-verification --from-file=public.pem
# Build/publish --target runner; set all three image references to verified digests.
kubectl apply -k kubernetes-coach
```

Protect/delete the local private-key copy according to your secret-management
practice. To rotate, stop the API/runner, replace both key resources, and restart
both together. Mounted key updates alone do not reload the runner's verifier.
For a different API UID/GID, adjust the pod fsGroup and the runner's socket group
alongside Secret readability; keep runner UID distinct from the API's UID.

The runner admits one request at a time, with no job queue. It caps the request at
1 MiB, response at 4 MiB, execution at five minutes, incoming body time at five
seconds and connections at eight. Busy, missing, invalid or disconnected runners
fail the Coach job; the API never falls back to local execution. Each request gets
a fresh worker process group and private temporary HOME. The group is killed on
completion, timeout, client disconnect or shutdown; scratch is removed. Runtime
stderr is not returned because it may echo credentials. No request/prompt/token is
logged by the runner. tmpfs and memory/CPU limits bound its resource use.

The runner and installed runtime share a UID and container. They are **not** a
hostile multi-tenant sandbox: a malicious runtime can inspect runner memory, other
runner files and the credential supplied for its current job. Only trusted runtime
packages belong in this image. The container mount boundary protects API files;
the runner's public verification key cannot authorize new requests. A compromised
runner can still make network calls and falsify its response. Apply workload egress
controls separately; the API continues to validate proposals and require approval.

Claude API keys and setup tokens are job-scoped. Codex supports API keys, with a
fresh CODEX_HOME per job. Existing persistent Codex OAuth/login caches are **not**
mounted or migrated: reconnect with an API key for this deployment. This avoids
sharing one account's refresh cache across profiles. Direct HTTPS providers need
no runner and keep their existing credential flow.

Codex's runtime sandbox may require unprivileged user namespaces permitted by the
host kernel/runtime. Do not add privileges, disable seccomp or use its sandbox-bypass
flags to work around an incompatible host; use a supported host or HTTP provider.
A fixture test proves protocol/process/mount isolation, not that a paid provider
or its sandbox works on every Kubernetes runtime. Test the selected provider in
staging before switching production traffic.

Run `CONTAINER_RUNTIME=podman sh scripts/ci/coach-runner-smoke.sh API_IMAGE RUNNER_IMAGE`
with an API image and `runner-fixture` image built from this commit. It makes a signed
fixture invocation from a restricted API container, checks the worker's UID and
private HOME, and verifies `/data` and the signing key are absent in the worker.
Unit tests also cover signature tampering/replay, schema restrictions and limits.
