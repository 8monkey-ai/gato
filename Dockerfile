# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY prompts ./prompts
COPY src ./src
# Configuration comes only from the environment, so the binary must not read .env or bunfig.toml.
RUN bun build src/main.ts --compile --minify --sourcemap --bytecode \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile gato

# The binary contains the Bun runtime, so the image needs no Bun installation.
FROM gcr.io/distroless/cc-debian12
COPY --from=build /app/gato /gato
# The uid of the "bun" user in oven/bun, so existing data mounts stay writable.
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["/gato"]
