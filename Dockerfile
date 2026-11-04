FROM oven/bun:1.4.4

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY prompts ./prompts

RUN mkdir /data && chown bun:bun /data
VOLUME /data
ENV GATO_DATA_DIR=/data
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
