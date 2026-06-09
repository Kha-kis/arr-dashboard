# ADR 0008: Setup Auto-Discovery Scope

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Backend maintainers
- **Supersedes:** —
- **Charter:** [3.0 charter](../3.0-charter.md) §2.3, §5.4; decision log #10

## Context

The 3.0 Setup rewrite (charter §2.3) includes service auto-detection:
the first-run flow should find what it can on the local network and
pre-fill connection forms, because manual URL + API-key entry for six
services is the worst part of first-run today.

"Detect everything" is not implementable honestly. The services
arr-dashboard connects to split into two classes:

- **Media servers ship discovery protocols.** Plex answers GDM (UDP
  broadcast on 32414) and SSDP; Jellyfin and Emby answer a UDP
  discovery datagram ("Who is JellyfinServer?" on 7359) and mDNS.
  Discovery is a supported, documented use of these protocols.
- **The *arr family ships none.** Sonarr, Radarr, Prowlarr, Lidarr, and
  Readarr have no broadcast/announce mechanism. "Detecting" them means
  port-scanning the subnet for 8989/7878/9696/8686/8787 and probing
  HTTP responses — slow, unreliable across VLANs/Docker networks, and
  indistinguishable from hostile network behavior to IDS/firewall
  tooling that self-hosters commonly run.

## Decision

Setup auto-detection covers **media servers only**:

| Service | Mechanism |
|---|---|
| Plex | GDM broadcast; SSDP fallback |
| Jellyfin | UDP discovery (port 7359); mDNS fallback |
| Emby | UDP discovery (shared lineage with Jellyfin); mDNS fallback |
| Tracearr | manual entry in 3.0; revisit if upstream adds announce/mDNS |

The *arr services (and qui, Seerr) remain **manual entry**, with the
Setup flow doing what it can honestly: URL validation, reachability
test, and API-key verification with actionable error messages on each
attempt.

Detection results are **candidates, never auto-connections**: the flow
presents "Found Plex at 192.168.x.x — connect?" and the operator
confirms each one. No credentials are guessed; detection only fills the
URL field.

## Why this shape

1. **Use protocols as designed, or not at all.** GDM/SSDP/mDNS exist
   for discovery; answering them is the server opting in. Port-scanning
   is the absence of an invitation.
2. **Candidates-not-connections keeps the trust posture.** A first-run
   flow that silently connects to everything it finds is indistinguishable
   from malware behavior; one that asks per-service is a convenience.
3. **The asymmetric outcome matches user reality.** Media-server URLs
   are the ones users least often know (containers, NAS appliances);
   *arr users overwhelmingly know their own ports because they
   configured them.

## Why not …

- **Subnet port-scan for *arr ports.** Slow (seconds-to-minutes per
  /24), fails across Docker bridge networks and VLANs where most
  self-hosters actually run, trips IDS/fail2ban, and the charter's
  scope-debate shorthand ("does this strengthen the trust layer?")
  answers itself for a feature that behaves like a network attacker.
- **Asking the host Docker daemon** (inspect containers for known
  images). Works only when arr-dashboard shares the Docker host and has
  socket access — a privilege we do not request and should not start
  requesting for a convenience feature.
- **mDNS-only for everything.** The *arrs do not announce via mDNS;
  there is nothing to listen for.
- **Deferring all detection to 3.1.** Detection of the media servers is
  low-risk and high-payoff for first-run; deferring it would gut the
  Setup rewrite's headline improvement.

## Consequences

### Positive

- First-run friction drops for the services where URLs are least known.
- The detection surface is small, protocol-blessed, and testable with
  recorded datagrams — no network-shape-dependent heuristics.
- A clear answer exists for "why didn't it find my Sonarr?" — documented
  in the Setup flow itself, not just in docs.

### Negative / trade-offs

- The flow is asymmetric (some services found, some manual), which needs
  copy that explains rather than apologizes. UX design pass required
  (charter §11 follow-up).
- Broadcast/mDNS discovery does not cross subnets; users with segmented
  networks fall back to manual entry for everything. Acceptable — that
  is also the population most likely to *prefer* manual entry.
- Docker bridge networks without host networking may block broadcast
  reception. Detection must fail silent-and-fast (short timeout) into
  the manual path, never hang the wizard.

## Follow-ups

- Bucket-A-adjacent spike: validate GDM and Jellyfin/Emby UDP discovery
  from inside a bridge-network container; if reception proves
  unreliable, document "host network or manual" in the Setup copy.
- Revisit Tracearr detection when/if upstream ships an announce
  mechanism.
- The detection module ships with recorded-datagram fixtures so CI
  covers parsing without a live network.
