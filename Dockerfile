# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.19.0
ARG RUST_VERSION=1.98.1
FROM docker.io/library/node:${NODE_VERSION}-bookworm-slim AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
# The server pages need no Tauri CLI or Playwright; drop them (and native binaries) from the install.
RUN node -e "const fs=require('fs');const p=require('./package.json');const l=require('./package-lock.json');for(const d of ['@tauri-apps/cli','playwright']){delete p.devDependencies[d];delete l.packages[''].devDependencies[d];}for(const k of Object.keys(l.packages))if(/^node_modules\/(@tauri-apps\/|playwright(-core)?$)/.test(k))delete l.packages[k];fs.writeFileSync('package.json',JSON.stringify(p));fs.writeFileSync('package-lock.json',JSON.stringify(l))" \
    && npm ci --no-audit --no-fund
COPY app ./app
RUN npm run build:server

FROM docker.io/library/rust:${RUST_VERSION}-bookworm AS backend
WORKDIR /src
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/
# Dependency preparation may use the network; compilation is offline and locked.
# Fetch crates for this Linux target only, not the Windows/macOS desktop crates.
RUN mkdir -p src-tauri/src/bin && printf 'fn main() {}\n' > src-tauri/src/main.rs \
    && printf 'fn main() {}\n' > src-tauri/src/bin/server.rs \
    && printf 'fn main() {}\n' > src-tauri/src/bin/test_host.rs \
    && cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target "$(rustc -vV | sed -n 's/^host: //p')"
COPY src-tauri/src ./src-tauri/src
COPY app/weave/server-auth.* ./app/weave/
COPY src-tauri/build.rs ./src-tauri/build.rs
COPY --from=frontend /src/dist ./dist
RUN cargo build --offline --locked --release --manifest-path src-tauri/Cargo.toml --no-default-features --features server --bin weave-server \
    && strip src-tauri/target/release/weave-server

FROM docker.io/library/debian:bookworm-slim AS runtime
RUN groupadd --gid 10001 weave && useradd --uid 10001 --gid weave --no-create-home weave \
    && mkdir /data /workspaces && chown weave:weave /data /workspaces
COPY --from=backend /src/src-tauri/target/release/weave-server /usr/local/bin/weave-server
COPY --from=frontend /src/node_modules/dictionary-en/license /usr/share/doc/weave/dictionary-en.txt
COPY --from=frontend /src/node_modules/dictionary-en-gb/license /usr/share/doc/weave/dictionary-en-gb.txt
USER 10001:10001
EXPOSE 8765
STOPSIGNAL SIGTERM
ENTRYPOINT ["weave-server"]
CMD ["--host", "0.0.0.0", "--port", "8765", "--workspaces", "/workspaces", "--data", "/data"]
