# hubd — files-first coordination hub (MCP server). Zero runtime dependencies.
# Glama (and anyone) builds this to run the MCP server in an isolated container.
#
# Default transport is stdio (the MCP standard; one owner per container).
# For a shared HTTP endpoint, set the env vars shown below at `docker run` time —
# no rebuild needed (index.mjs switches to HTTP when HUBD_HTTP_PORT is set).
FROM node:22-alpine

WORKDIR /app

# hubd has NO npm dependencies, so there is nothing to `npm install`.
# Copy only what the published package ships (mirrors package.json "files").
COPY package.json README.md LICENSE HARVEST.md ./
COPY hub ./hub
COPY prompts ./prompts
COPY docs ./docs

# Hub data lives outside the image so it survives container restarts when a
# volume is mounted at /data. Without a volume the hub is ephemeral (fine for
# Glama's build/security test and for a stateless demo).
ENV HUBD_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

# stdio MCP (default). To serve MCP over HTTP instead:
#   docker run -e HUBD_HTTP_PORT=8787 -e HUBD_HTTP_HOST=0.0.0.0 \
#              -e HUBD_TOKEN=<secret-16+-chars> -p 8787:8787 hubd
ENTRYPOINT ["node", "hub/index.mjs"]
