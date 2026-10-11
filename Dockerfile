# Hermetic test-runner image: the throwaway HOME the lifecycle smoke needs.
#   fully-qualified ref, ARG before FROM, no BuildKit-only syntax  -> builds under Podman too
#   BUN_VERSION has no default   -> .bun-version is the only pin; `bun run test:docker` passes it
#   DENO_VERSION has no default  -> the SIDECAR_DENO_VERSION line of copilot-env.config is the only pin; same
ARG BUN_VERSION
FROM docker.io/oven/bun:${BUN_VERSION}
ARG DENO_VERSION

# Daemon pid discovery shells `ps` (procps); deno's installer needs curl and unzip.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl procps unzip \
  && rm -rf /var/lib/apt/lists/*

# The suite runs as the image's unprivileged `bun` user, as it does on a
# developer machine: the 0600-permission checks mean nothing as root. The
# tree, the dependency cache, and HOME are its own.
RUN mkdir -p /home/bun /work && chown bun:bun /home/bun /work
WORKDIR /work
USER bun
ENV HOME=/home/bun DENO_INSTALL=/home/bun/.deno DENO_NO_UPDATE_CHECK=1
ENV PATH=/home/bun/.deno/bin:$PATH

# The proxy daemon still runs under deno (the sidecar the binary downloads), so the image
# carries the pinned one for scripts/warm-proxy-cache.ts and the lifecycle tests. Run from a
# downloaded file, not `curl | sh`: a failed download then fails the build. CI=1 keeps the
# installer out of rc files.
RUN curl -fsSL -o /tmp/deno-install.sh https://deno.land/install.sh \
  && CI=1 sh /tmp/deno-install.sh "v${DENO_VERSION}" \
  && rm /tmp/deno-install.sh \
  && deno --version

# Manifests first so the dependency layer caches across source edits; the frozen lockfile
# matches the CI install exactly.
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .

# The floated-spawn test launches the proxy `--cached-only` under --network=none, so its
# dependency tree (which `bun install` never resolves) must be cached while there is a network.
RUN bun scripts/warm-proxy-cache.ts

CMD ["bun", "run", "test", "--e2e"]
