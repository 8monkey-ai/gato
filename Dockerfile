# syntax=docker/dockerfile:1
# package.json names a Bun canary. Docker Hub tags canaries only as "canary", so the digest fixes the build.
# The build stage runs natively and cross-compiles, because Bun can hang under QEMU.
FROM --platform=$BUILDPLATFORM oven/bun:canary@sha256:f6f46d24250e279c40e6946b81c78a3afa8b7d5910514a5d760b742203c36238 AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY prompts ./prompts
COPY src ./src
RUN bun run build --target=bun-linux-${TARGETARCH}

# The binary contains the Bun runtime, so the image needs no Bun installation.
FROM gcr.io/distroless/cc-debian12
COPY --from=build /app/dist/gato /gato
# The uid of the "bun" user in oven/bun, so existing data mounts stay writable.
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["/gato"]
