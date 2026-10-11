# Hermetic test-runner image: the throwaway HOME the lifecycle smoke needs.
#   fully-qualified ref, ARG before FROM, no BuildKit-only syntax  -> builds under Podman too
#   BUN_VERSION has no default   -> .bun-version is the only pin; `bun run test:docker` passes it
ARG BUN_VERSION
FROM docker.io/oven/bun:${BUN_VERSION}

# Daemon pid discovery shells `ps` (procps); the proxy float fetches from the npm registry over TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

# The suite runs as the image's unprivileged `bun` user, as it does on a
# developer machine: the 0600-permission checks mean nothing as root. The
# tree, the dependency cache, and HOME are its own.
RUN mkdir -p /home/bun /work && chown bun:bun /home/bun /work
WORKDIR /work
USER bun
ENV HOME=/home/bun

# Manifests first so the dependency layer caches across source edits; the frozen lockfile
# matches the CI install exactly.
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .

# The floated-spawn test launches the proxy from a real float under --network=none, so the float
# (the proxy's own install, resolved from the registry) must run while there is a network.
RUN bun scripts/warm-proxy-cache.ts

CMD ["bun", "run", "test", "--e2e"]
