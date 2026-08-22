# Hermetic test-runner image. The lifecycle smoke rewires agent configs in
# whatever HOME it sees, so it is container-or-CI only; the unit suite is
# HOME-safe by its own temp-dir design, and the container adds defense in
# depth plus a Linux-parity run. Podman-compatible by construction:
# fully-qualified image ref, ARG-before-FROM, no BuildKit-only syntax.
# The DENO_VERSION default is pinned to .dvmrc (test/docker.test.ts guards
# the pair); the test:docker task passes it explicitly either way.
ARG DENO_VERSION=2.9.5
FROM docker.io/denoland/deno:${DENO_VERSION}

# Daemon pid discovery shells `ps`; the base image lacks procps.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
ENV DENO_NO_UPDATE_CHECK=1

# Manifests first so dependency layers cache across source edits. `deno ci`
# matches the CI install exactly: frozen lock, clean tree, scripts off.
COPY .dvmrc deno.json deno.lock package.json ./
RUN deno ci

COPY . .

# The proxy's own runtime graph, which `deno ci` never sees: it caches the workspace
# imports, while the proxy's bin entrypoint pulls its own tree (citty and friends).
# The floated-spawn test executes a real `--cached-only` launch under --network=none,
# so that tree has to be in the image's cache while there is still a network.
RUN deno run -P=cli scripts/warm-proxy-cache.ts

CMD ["deno", "task", "test"]
