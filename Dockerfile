FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY prompts ./prompts
COPY src ./src
ENV NODE_ENV=production
USER bun
CMD ["bun", "src/main.ts"]
