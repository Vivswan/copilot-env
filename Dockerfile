# Hermetic test-runner image: the throwaway HOME the lifecycle smoke needs.
#   fully-qualified ref, ARG before FROM, no BuildKit-only syntax  -> builds under Podman too
#   DENO_VERSION default                                           -> tracks .dvmrc; test/docker.test.ts guards the pair
ARG DENO_VERSION=2.9.5
FROM docker.io/denoland/deno:${DENO_VERSION}

# Daemon pid discovery shells `ps`; the base image lacks procps.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

# The suite runs as the image's unprivileged `deno` user, as it does on a
# developer machine: the 0600-permission checks mean nothing as root. The
# tree, the dependency cache, and HOME are its own.
RUN mkdir -p /home/deno /work && chown deno:deno /home/deno /work
WORKDIR /work
USER deno
ENV DENO_NO_UPDATE_CHECK=1 HOME=/home/deno

# Manifests first so dependency layers cache across source edits. `deno ci`
# matches the CI install exactly: frozen lock, clean tree, scripts off.
COPY --chown=deno:deno .dvmrc deno.json deno.lock package.json ./
RUN deno ci

COPY --chown=deno:deno . .

# The floated-spawn test launches the proxy `--cached-only` under --network=none, so its
# dependency tree (which `deno ci` never resolves) must be cached while there is a network.
RUN deno run -P=cli scripts/warm-proxy-cache.ts

CMD ["deno", "task", "test"]
