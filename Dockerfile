# The project uses a Bun canary (see packageManager in package.json).
FROM oven/bun:canary
# The harness reads the mounted skills checkout with git.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY prompts ./prompts
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
