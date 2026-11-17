# File-server throughput: BBR + HTTP/2 vs CUBIC + HTTP/3

Large media (4K video especially) is served by Caddy's `file_server` straight
from disk (PRD §3). The disk is rarely the bottleneck. What usually limits a
single stream is congestion control on a long or slightly lossy route between
the server and the viewer. That shows up as buffering even when the uplink
has plenty of spare capacity.

By default the stack runs Caddy's stock protocols (`h1 h2 h3`) and the
kernel's default congestion control (usually CUBIC). This doc covers an
**optional** switch for when throughput becomes a problem: serving over
**TCP (HTTP/1.1 + HTTP/2) with BBR** and turning **QUIC/HTTP/3** off. The
config for it ships commented out in [Caddyfile](../Caddyfile) and
[docker-compose.yml](../docker-compose.yml).

## The comparison

| | TCP + BBR (h1/h2) | QUIC + CUBIC (h3) |
|---|---|---|
| Where congestion control runs | Linux kernel, per network namespace | Inside the application (Caddy uses quic-go) |
| Algorithm | BBR (once enabled on the host/container) | CUBIC-style; Caddy has no option to change it |
| Reaction to random packet loss | Models bandwidth and RTT, so isolated loss barely slows it | Loss-based: every loss cuts the sending window, so throughput collapses on long, lossy routes |
| Single-stream throughput on a long fixed line | High, close to the available bandwidth | Limited per connection, often far below the line rate |
| Where it shines | Bulk transfers and video streaming over fixed lines | Unreliable mobile networks, faster connection setup, no head-of-line blocking |
| Extra host requirements | Load `tcp_bbr` and set it as the default (below) | UDP 443 open, larger UDP socket buffers (quic-go warns at startup if it can't raise them) |

HTTP/3 has a *different* congestion controller, not a faster one. For
streaming large files to clients on fixed lines, TCP with BBR generally does
better. Pinning Caddy to `protocols h1 h2` puts every client on TCP, where BBR
applies. BBR without the protocol switch only helps clients that happen to
use TCP.

## Why kernel BBR doesn't help QUIC

BBR in the Linux kernel is a TCP congestion control module. QUIC runs over
UDP, and the QUIC library implements its own congestion control in user
space. Setting `net.ipv4.tcp_congestion_control=bbr` has no effect on
HTTP/3 connections. If HTTP/3 stays on, browsers that discover it (via the
`Alt-Svc` header) switch to it and keep the slow, loss-sensitive behavior.

## Why the container's setting is the one that matters

With Docker's default bridge networking, each container has its own network
namespace, and `tcp_congestion_control` is a per-namespace setting. Caddy's
client-facing TCP connections live in the Caddy container's namespace, so
**the container's value** decides how they behave. The host's own value only
covers connections the host itself makes.

The host still has two jobs:

1. **Load the `tcp_bbr` kernel module.** Containers share the host kernel and
   can't load modules. If `tcp_bbr` isn't loaded, setting `bbr` inside the
   container fails, and once the compose `sysctls` entry below is enabled
   **the Caddy container won't start at all**.
2. **Make BBR the host default.** On recent kernels a new network namespace
   copies the host's congestion control when it's created, so a recreated
   container usually picks up BBR anyway. The compose file also sets it
   explicitly to remove any doubt.

## Enabling it

Measure first (see [Verify](#verify)) so you have a baseline to compare
against.

### Host (once)

```bash
# Load the module now and at every boot
sudo modprobe tcp_bbr
echo tcp_bbr | sudo tee /etc/modules-load.d/bbr.conf

# Make BBR (with the fq qdisc) the default
printf 'net.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\n' \
  | sudo tee /etc/sysctl.d/99-bbr.conf
sudo sysctl --system
```

`default_qdisc=fq` only applies to network interfaces created after it's set,
so an existing NIC keeps its old qdisc until the next reboot. That's fine:
on modern kernels BBR paces its own sending, so `fq` is a small improvement,
not a requirement.

### Container ([docker-compose.yml](../docker-compose.yml))

Uncomment the `sysctls` entry on the `caddy` service:

```yaml
services:
  caddy:
    sysctls:
      net.ipv4.tcp_congestion_control: bbr
```

The `443:443/udp` mapping can stay. Once HTTP/3 is off nothing listens on
it, so you can also drop it and stop forwarding UDP 443 on the router.

### Caddy ([Caddyfile](../Caddyfile))

Uncomment the global options block at the top of the Caddyfile. `protocols`
is a server option, so it has to live in that bare `{ }` block before any
site block:

```caddy
{
	servers {
		protocols h1 h2
	}
}
```

This applies to the whole listener, not just `/f/*`, so the Next.js app is
also served over HTTP/1.1 + HTTP/2 only. That's harmless. Caddy also stops
sending the `Alt-Svc` header that advertises HTTP/3.

### Apply

```bash
docker compose up -d --force-recreate caddy   # picks up sysctls, ports and the Caddyfile
```

For a Caddyfile-only change, a reload without recreating the container is
enough:

```bash
docker compose exec -w /etc/caddy caddy caddy reload
```

## Verify

```bash
# Should print: bbr
docker compose exec caddy cat /proc/sys/net/ipv4/tcp_congestion_control

# Single-stream download speed (bytes/s) from a client machine, before vs after
curl -o /dev/null -s -w '%{http_version} %{speed_download}\n' \
  "https://$DOMAIN/f/<file-id>/<name>.mp4"
```

In the browser, the dev tools Network tab (Protocol column) should show `h2`.
Browsers cache the HTTP/3 hint for a while, so restart the browser or use a
private window before checking.

If the container still reports `cubic`, the protocol change alone only moves
clients onto the same slow TCP. Check that `tcp_bbr` is loaded on the host
(`lsmod | grep tcp_bbr`) and recreate the container.

## Cloudflare Tunnel deployments

Under [docker-compose.tunnel.yml](../docker-compose.tunnel.yml), viewers'
connections terminate at Cloudflare's edge, and Caddy only talks plain HTTP
to `cloudflared` over the local bridge network. Neither the Caddy protocol
setting nor Caddy's BBR affects the viewer-facing leg there. If the
`sysctls` entry is enabled in the base file, the overlay inherits it, so the
host still needs `tcp_bbr` loaded or the Caddy container won't start.

## Reverting

Comment the two blocks back out and run
`docker compose up -d --force-recreate caddy`. The host-level BBR settings
can stay; they don't affect anything that depends on HTTP/3.
