# IPv4 and IPv6 web networking (K8S-20)

Finding K8S-20: the original template listened only on IPv4 and set
`resolver ... ipv6=off` in both API proxy locations. An AAAA-only API Service
therefore could not be resolved, and an IPv6 Service could not reach the web
listener without deployment-time edits. This is a Medium availability and
platform-compatibility finding.

The web image opens independent IPv4 and IPv6 listening sockets on `NGINX_PORT`.
nginx resolves both A and AAAA records when proxying API and media requests. The
API already listens on Node's unspecified address; ensure IPv6 is available in
the pod network. These defaults require an image built with this change; the
existing `1.3.9` manifests do not gain IPv6 support until their image is updated.

| Web environment variable | Default | Meaning |
| --- | --- | --- |
| `NGINX_IPV6` | `on` | Add `[::]:NGINX_PORT` with `ipv6only=on`, alongside IPv4. Set `off` if the host has disabled IPv6 sockets. |
| `RESOLVER_IPV6` | `on` | Resolve AAAA as well as A records for the API hostname. Set `off` when the web network cannot route IPv6 upstream addresses. |
| `RESOLVER` | `127.0.0.11` | Space-separated DNS server IP addresses; the default is Docker's embedded DNS. |
| `BACKEND` | `api` | API DNS name or IP literal, without a scheme or port. |

An IPv4-only deployment can set both switches to `off`. They are independent:
IPv4 clients can access an IPv6-only API through nginx, and IPv6 clients can
access an IPv4 API. IPv6-capable hosts with an IPv4-only Docker network can leave
the listener enabled; disable AAAA resolution if upstream names also advertise
unreachable IPv6 addresses. The image does not detect or create IPv6 routing.

`RESOLVER` accepts raw IPv6 addresses such as `fd00:10:96::a`, copied from
`/etc/resolv.conf`, and normalizes them to nginx's bracketed syntax. Use
`[fd00:10:96::a]:5353` for a nondefault DNS port; IPv4 uses `10.96.0.10:5353`.
Multiple servers can be written as `10.96.0.10 fd00:10:96::a`. `BACKEND` similarly
accepts `fd00:10:96::123` or `[fd00:10:96::123]`; put its port in `PORT`.

## Kubernetes

The supplied single-pod deployment uses `BACKEND=127.0.0.1` and therefore needs
no DNS to reach its sibling API container, even on an IPv6-only pod network.
For separate API and web Deployments, use the Service's fully qualified name:

```yaml
env:
  - name: BACKEND
    value: opengym-api.fitness.svc.cluster.local
  - name: PORT
    value: "3000"
  - name: RESOLVER
    value: "fd00:10:96::a" # Replace with this cluster's reachable DNS server.
  - name: RESOLVER_IPV6
    value: "on"
  - name: NGINX_IPV6
    value: "on"
```

Replace `cluster.local` if the cluster has another DNS domain. nginx's dynamic
resolver does not apply the pod's DNS search suffixes, so a fully qualified
Service name matters. Allow both UDP and TCP port 53 to DNS and the API port
through applicable NetworkPolicies. An IPv6-only API Service uses
`ipFamilyPolicy: SingleStack` and `ipFamilies: [IPv6]`; an IPv6-primary web
Service can use `ipFamilyPolicy: PreferDualStack` and `ipFamilies: [IPv6, IPv4]`
when the cluster supports it. Choose these at provisioning time; inspect
existing Service allocation before changing it. The examples deliberately do
not force one cluster IP family.

An ingress/Gateway, load balancer, external firewall, IPv6 route, TLS certificate,
and public AAAA record are separate requirements for public IPv6 access.
Successful in-pod IPv6 proxying does not prove external reachability. Test
`curl -6 https://your-host/api/health` from outside the cluster after publishing
AAAA; also verify ordinary IPv4 access if dual stack is intended.

## Regression check

Build `web/Dockerfile`, then run
`python3 scripts/ci/test_web_ipv6.py IMAGE`. The test uses a local DNS fixture,
an IPv6-only backend, and an IPv4 backend. It checks both listening families,
AAAA-only proxying on API and media paths, IPv6 DNS transport, literal IPv6
configuration, and the explicit IPv4-only opt-outs. It requires Podman (or
`CONTAINER_RUNTIME=docker`), Linux host networking, and IPv6 loopback. It fails
rather than silently skipping when IPv6 is unavailable.

References: [nginx listen and resolver syntax](https://nginx.org/en/docs/http/ngx_http_core_module.html),
[Kubernetes dual-stack Services](https://kubernetes.io/docs/concepts/services-networking/dual-stack/).
