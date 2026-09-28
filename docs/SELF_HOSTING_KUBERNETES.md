# Self-hosting openGym on Kubernetes

Example manifests for a small cluster, contributed from a K3s setup with the Gateway API and
cert-manager. Read [SELF_HOSTING.md](SELF_HOSTING.md) first: the passkey requirement (HTTPS,
`RP_ID`, `ORIGIN`), the settings in `.env.example` and the backup advice apply here unchanged.

openGym is pretty simple — a frontend and an API backend. The API keeps everything in plain JSON
files on a volume. The Docker Compose file also has a third container that downloads the exercise
media once; here that is an initContainer. There are only a few resources to create:

- 2 PVCs: `opengym-data` (users, passkeys, workouts, uploads — **back this one up**) and
  `opengym-media` (the exercise images, downloaded again if lost).
- 1 Deployment running the API and the web container in a single pod, for simplicity. It stays at
  one replica with the `Recreate` strategy: the API's data is files on a `ReadWriteOnce` volume,
  and two API processes must never write them at once.
- An HTTPRoute (the example uses the Gateway API; an Ingress to the `opengym` Service on port 80
  works as well), plus a cert-manager Certificate for the hostname.

```bash
git clone https://github.com/DuarteSantos8/openGym   # or https://gitlab.com/DuarteSantos8/opengym — same repo
cd openGym
# In kubernetes/deployment.yaml, set RP_ID and ORIGIN in spec.template.spec.containers[api].env
# to your hostname, and the hostname in kubernetes/httproute.yaml.
kubectl apply -k kubernetes/
```

Notes:

- **Hardened images (K8S-03).** This manifest expects API/web images built from this
  branch. The fork's `:edge` references are integration defaults, not proof that these
  images already exist; build and publish both from the same commit, verify them, then
  replace the two references with their immutable digests before applying. Do not use
  upstream `1.3.9`: its web entrypoint writes configuration to the root filesystem.
- **Restricted admission.** `fitness` is intended to be a dedicated namespace and now
  enforces the Restricted Pod Security standard. Check for unrelated workloads before
  applying that policy to an existing shared namespace. All containers drop capabilities,
  forbid privilege escalation and use runtime seccomp with read-only root filesystems.
  No ServiceAccount token is mounted. The API runs as 1000:1000; web runs as 101:101 on
  port 8080 (the Service still exposes port 80); the media initializer runs as 1000:1000.
  Separate size-bounded `emptyDir` mounts provide each container's temporary space.
- **Volume ownership.** The CSI driver must support `fsGroup: 1000` for fresh writable
  volumes. Existing root-owned 0600 secrets need a deliberate offline ownership migration:
  stop all writers, take and verify a backup, then use a trusted maintenance environment
  outside this restricted workload to give API data UID/GID 1000 without broadening its
  secret-file permissions. Preserve private upload/Coach directories. Validate read/write
  access as UID 1000 before restarting. `fsGroup` alone does not establish ownership of
  every existing private file; root-squash/unsupported drivers need driver-specific setup.
- **Optional CLI Coach.** Apply `kubernetes-coach` instead of the base to add the
  separately isolated nonroot runner. It has no `/data` mount; the API sends signed,
  bounded requests over a Unix socket. Provision keys and build the runner first:
  [runner setup and security model](COACH_RUNNER.md). Direct HTTP providers need no
  runner. Codex persistent OAuth caches require migration to job-scoped API keys.
- **Smoke check.** Build matching images and run
  `sh scripts/ci/container-hardening-smoke.sh API_IMAGE WEB_IMAGE` (or set
  `CONTAINER_RUNTIME=podman`). It tests nonroot, zero-capability, read-only containers,
  nginx-to-API proxying and an authenticated state save/read. Live Restricted admission,
  CSI ownership handling and your gateway still need validation in a disposable cluster.

- The manifests create and use the `fitness` namespace (`kubernetes/namespace.yaml`, set on every
  resource by `kubernetes/kustomization.yaml`; rename it in both), and a Gateway
  called `eg` in `envoy-gateway-system` with an `https` listener; change both to match your
  cluster. The Gateway has to terminate TLS; this was tested with
  [Envoy Gateway](https://gateway.envoyproxy.io) and [cert-manager](https://cert-manager.io).
- The images are the fork's `ghcr.io/kquinsland01/opengym-api` and `opengym-web`. The AI
  Coach with an API key works on that same API image; the Claude and Codex sign-in providers
  use the separate `runner` build target and optional overlay
  (see [COACH_RUNNER.md](COACH_RUNNER.md)).
- Pin the API and web to verified digests from the same commit before deployment. To update,
  read the release notes, validate both images, and change both references together.
- Settings are environment variables on the `api` container, named as in `.env.example`. Keep
  secrets such as the push keys in a Kubernetes Secret and load them with `envFrom`.
- **Client addresses.** The web container overwrites `X-Forwarded-For` with the address it was
  reached from (see `web/nginx.conf.template`), and behind a Gateway that is the gateway's pod,
  not the visitor. So the sign-in throttle, which counts attempts per address, acts on the whole
  instance at once, and the activity log records the gateway's address. `TRUST_PROXY` is left
  off because it would not change that: the API would read the same gateway address from the
  header — and any pod that reaches port 3000 directly could put its own address there. Getting
  real visitor addresses needs the gateway to preserve them (for example
  `externalTrafficPolicy: Local` on its LoadBalancer Service) and to set a header of its own that
  overwrites whatever a client sent; pass that through with `CF_CONNECTING_IP` on the `web`
  container (as `.env.example` describes for Cloudflare), turn on `TRUST_PROXY=1` on the `api`
  container, and add a NetworkPolicy so only the web container's pod reaches port 3000.

## Existing NFS ownership (1001:1002)

The rack deployment's existing API secret/db/VAPID files are mode 0600 owned by
UID 1001/GID 1002, and its media directories also use 1001:1002. They are independent
volumes: do not assume one ownership change covers both. Retain API ownership by
setting the API container `runAsUser: 1001`, `runAsGroup: 1002` and pod `fsGroup: 1002`.
Set the media initializer to 1001:1002 independently. For the runner overlay set its
`runAsGroup: 1002` so the socket and key group permissions match; keep its distinct
UID 1100. The images work with numeric UID overrides and need no `/etc/passwd` edit.
Web only reads media and retains UID 101; verify directory traversal/read access.

Alternatively, stop all API writers and media initializers, back up and verify both
volumes, and perform an offline NFS-server-side ownership migration to the manifest's
1000:1000 defaults. Preserve 0600 secrets and private-directory modes; do not chmod
them world/group-readable as a workaround. Root-squash often prevents in-pod chown.
Validate read/write as the chosen API UID, media initialization as its chosen UID,
and web media reads before restarting. Fresh PVC provisioning and existing-volume
access are separate staging checks. Keep the prior deployment and backup available
for rollback; UID changes do not alter data formats.
