#!/bin/bash
# Claude Code cloud environment setup script for Omni. Paste this file, unchanged, into the
# environment's "Setup script" field on claude.ai (docs/operations/cloud-sessions.md).
#
# It installs machine tools only: it runs as root on Ubuntu before Claude Code starts, and the
# resulting filesystem is snapshotted and reused, so nothing here keeps running and no secret is
# read. Every step is idempotent. Per-session work (dockerd, the compose stack, `pnpm install`,
# migrations, Doppler env files) lives in .claude/hooks/cloud-session-start.sh.
#
# Downloads are pinned and checksum-verified. To bump one, change the version and its sha256
# from the release's published checksums.
set -euo pipefail

[ "$(uname -m)" = "x86_64" ] || {
  echo "setup.sh: only linux x86_64 is pinned" >&2
  exit 1
}

# install_tarball <url> <sha256> <tar args...>: download, verify, extract.
install_tarball() {
  local url=$1 sha256=$2 tarball
  shift 2
  tarball="$(mktemp)"
  curl -fsSL --retry 3 -o "$tarball" "$url"
  echo "$sha256  $tarball" | sha256sum -c --quiet
  tar -xf "$tarball" "$@"
  rm -f "$tarball"
}

# Node, matching .nvmrc. Installed beside the image's own Node; the SessionStart hook puts
# /opt/node24/bin first on PATH.
node_version=24.21.0
node_sha256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
if [ "$(/opt/node24/bin/node --version 2>/dev/null)" != "v$node_version" ]; then
  rm -rf /opt/node24 && mkdir -p /opt/node24
  install_tarball "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" \
    "$node_sha256" -J -C /opt/node24 --strip-components=1
fi
export PATH="/opt/node24/bin:$PATH"

# pnpm, matching package.json `packageManager`, through Node's bundled corepack. Preparing it here
# caches the download in the snapshot.
pnpm_version=12.16.1
if [ "$(pnpm --version 2>/dev/null)" != "$pnpm_version" ]; then
  corepack enable --install-directory /opt/node24/bin pnpm
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g "pnpm@$pnpm_version"
fi

# Cloudflare CLI (`cf`), for inspecting the account. `wrangler` comes from the repo's deps.
cf_version=1.0.0-beta.26
npm ls -g "cf@$cf_version" >/dev/null 2>&1 || npm install -g --silent "cf@$cf_version"

# Doppler CLI, from its GitHub release (cli.doppler.com is not on the default allowlist).
doppler_version=3.77.1
doppler_sha256=001f89a42629f9cb827cd86683c4c2dbf87c6299a8d6130643b98044bf5ed80a
if [ "$(doppler --version 2>/dev/null)" != "v$doppler_version" ]; then
  install_tarball \
    "https://github.com/DopplerHQ/cli/releases/download/$doppler_version/doppler_${doppler_version}_linux_amd64.tar.gz" \
    "$doppler_sha256" -z -C /usr/local/bin doppler
fi

# flyctl, pinned to the version .github/workflows/deploy.yml uses.
flyctl_version=0.5.1
flyctl_sha256=47803bc5dc3eb7c7a45626ff76f0082e8c5b5fb8b805efbe00469d04757e1b1b
if ! flyctl version 2>/dev/null | grep -q "v$flyctl_version "; then
  install_tarball \
    "https://github.com/superfly/flyctl/releases/download/v$flyctl_version/flyctl_${flyctl_version}_Linux_x86_64.tar.gz" \
    "$flyctl_sha256" -z -C /usr/local/bin flyctl
fi

# psql, and ICU for devtunnel (a .NET binary that aborts without it).
if ! command -v psql >/dev/null || ! ldconfig -p | grep -q libicuuc; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-client libicu74 >/dev/null
fi

# devtunnel shares a local port (e.g. `wrangler dev` on 8787) through the session's egress proxy,
# where ngrok and cloudflared do not work. Optional: its host may need allowlisting, so a failed
# download only warns.
if ! command -v devtunnel >/dev/null; then
  if curl -fsSL --retry 3 -o /usr/local/bin/devtunnel https://aka.ms/TunnelsCliDownload/linux-x64; then
    chmod +x /usr/local/bin/devtunnel
  else
    rm -f /usr/local/bin/devtunnel
    echo "warning: devtunnel not installed" >&2
  fi
fi

# Bake the compose.yml images into the snapshot so sessions start without Docker Hub, which
# rate-limits anonymous pulls (429). Keep this list in sync with compose.yml.
images=(postgres:18-alpine greenmail/standalone:2.1.5 versity/versitygw:v1.9.0)
pull_images() {
  local image attempt
  for image in "${images[@]}"; do
    for attempt in 1 2 3 4; do
      docker image inspect "$image" >/dev/null 2>&1 && break
      docker pull -q "$image" >/dev/null && break
      if [ "$attempt" -lt 4 ]; then
        sleep $((attempt * 10))
      else
        echo "warning: $image not pulled" >&2
      fi
    done
  done
}
if docker info >/dev/null 2>&1; then
  pull_images
else
  # Start dockerd only for the pulls and stop it cleanly, so the snapshot holds no running daemon.
  rm -f /var/run/docker.pid
  nohup dockerd >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  pull_images
  kill "$(cat /var/run/docker.pid)"
  while [ -e /var/run/docker.pid ]; do sleep 1; done
fi
