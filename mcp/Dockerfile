FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0 AS build

WORKDIR /build/mcp
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY mcp/src ./src
COPY mcp/webpack.config.cjs ./
COPY fret-electron/app/parser /build/fret-electron/app/parser
COPY fret-electron/support /build/fret-electron/support
COPY fret-electron/analysis /build/fret-electron/analysis
RUN npm run build

FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0 AS backends
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
ADD --checksum=sha256:f571fff5f82a85727b9cae68f8305d69b67e0c3ee56098f97fad5dca27516f81 https://github.com/kind2-mc/kind2/releases/download/v2.2.0/kind2-v2.2.0-linux-x86_64.tar.gz /tmp/kind2.tar.gz
ADD --checksum=sha256:76f797c849ae1487ce08840321d3334720434e0eb1a23e1bd755c3818ffb7265 https://github.com/Z3Prover/z3/releases/download/z3-4.14.1/z3-4.14.1-x64-glibc-2.35.zip /tmp/z3.zip
ADD --checksum=sha256:e352f632b47ae583ce2a1831b57a069462e4fafba2b2e613e6c7e1ffcfe5541f https://raw.githubusercontent.com/kind2-mc/kind2/v2.2.0/LICENSE.rst /tmp/Kind2-LICENSE.rst
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && mkdir /backends && tar -xzf /tmp/kind2.tar.gz -C /backends \
    && unzip -p /tmp/z3.zip z3-4.14.1-x64-glibc-2.35/bin/z3 > /backends/z3 \
    && unzip -p /tmp/z3.zip z3-4.14.1-x64-glibc-2.35/LICENSE.txt > /backends/Z3-LICENSE.txt \
    && chmod 755 /backends/kind2 /backends/z3

FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0 AS runtime

ENV NODE_ENV=production MCP_FRET_HOST=0.0.0.0 MCP_FRET_PORT=8004 MCP_FRET_ANALYSIS_DIR=/var/lib/fret-mcp
WORKDIR /opt/fret-mcp
RUN apt-get update && apt-get install -y --no-install-recommends libgmp10 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/fret-mcp && chown node:node /var/lib/fret-mcp
COPY --from=backends /backends/kind2 /backends/z3 /usr/local/bin/
COPY --from=backends /backends/Z3-LICENSE.txt ./Z3-LICENSE.txt
COPY --from=backends /tmp/Kind2-LICENSE.rst ./Kind2-LICENSE.rst
RUN kind2 --version && z3 --version
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /build/mcp/dist ./dist
COPY LICENSE.pdf ./LICENSE.pdf
USER node
EXPOSE 8004
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const c=require('node:net').connect({host:'127.0.0.1',port:Number(process.env.MCP_FRET_PORT)},()=>c.end());c.on('error',()=>process.exit(1));c.setTimeout(3000,()=>{c.destroy();process.exit(1)});"
CMD ["node", "dist/server.cjs"]
