FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY prompts ./prompts
COPY tsconfig.json ./
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
