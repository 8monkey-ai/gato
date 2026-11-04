FROM oven/bun:1.4.4

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY prompts ./prompts

# The data folder must be mounted at /data. The image creates no /data, so a missing mount stops startup.
ENV GATO_DATA_DIR=/data
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
