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
  one replica with the `Recreate` strategy: the API's data is files on a `ReadWriteOncePod` volume,
  and two API processes must never write them at once. This requires a compatible CSI driver.
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

- **Single writer (K8S-02).** The data PVC requires `ReadWriteOncePod`; the media PVC can
  remain `ReadWriteOnce`. The API additionally starts under a nonblocking kernel `flock`
  on `/data/.writer.lock`. A competing process exits with status 73 before loading data.
  Never delete, rename, restore over, or replace this lock file while an instance may be
  alive: ownership belongs to its inode, not its filename. It contains no persistent
  ownership record and needs no stale-lock cleanup after a crash. Production bare-node
  launches are refused; use the image's default command or `npm start` on a Linux host
  with util-linux `flock` installed. Do not override `OPENGYM_WRITER_LOCK`.
- **Storage prerequisites.** Use Kubernetes 1.29+ and a CSI implementation with RWOP
  support and coherent filesystem locks. Verify locking across the actual mounts before
  deployment; filesystems with disabled/broken advisory locking are unsupported. RWOP
  scheduling and file locks are complementary, not a distributed database or a guarantee
  against a malfunctioning storage backend. Keep one replica and do not configure HPA.
- **Existing PVCs.** Do not apply the access-mode change blindly to a bound RWO claim.
  Take a verified backup, stop the Deployment and confirm every old pod is gone, then use
  the storage driver's documented migration/restore procedure into an RWOP claim. Preserve
  the source PV with a suitable reclaim policy during migration. Kubernetes documents the
  prerequisites and maintenance procedure in
  [migrating to ReadWriteOncePod](https://kubernetes.io/docs/tasks/administer-cluster/change-pv-access-mode-readwriteoncepod/).
  Do not weaken the claim back to RWO to work around an unsupported provisioner.
- **Node loss and recovery.** Before force-deleting an unreachable pod or force-detaching
  storage, fence the old node through the infrastructure/storage provider and prove it
  cannot still write. Let the CSI driver detach/attach normally whenever possible. Never
  remove a lock to force a second writer through. Test graceful pod deletion, SIGKILL,
  node loss and restore on disposable storage; a restart must retain accounts and state.
  A singleton rollout has downtime, and these controls do not provide HA.

- The manifests create and use the `fitness` namespace (`kubernetes/namespace.yaml`, set on every
  resource by `kubernetes/kustomization.yaml`; rename it in both), and a Gateway
  called `eg` in `envoy-gateway-system` with an `https` listener; change both to match your
  cluster. The Gateway has to terminate TLS; this was tested with
  [Envoy Gateway](https://gateway.envoyproxy.io) and [cert-manager](https://cert-manager.io).
- The images are the published `ghcr.io/duartesantos8/opengym-api` and `opengym-web`. The AI
  Coach with an API key works on that same API image; the Claude and Codex sign-in providers
  need the `coach` build target, which is not published — build it yourself (see
  [AI_COACH.md](AI_COACH.md)).
- The images are pinned to a release (`1.3.9`), the API and the web image always to the same
  one. To update, read the release notes, set the new version on both and apply again; pinning
  to `latest` instead means a restarted pod can come back on a version you never chose.
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
