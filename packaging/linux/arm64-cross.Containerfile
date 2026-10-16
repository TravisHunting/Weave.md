# Ubuntu 22.04 (amd64) with the arm64 WebKitGTK/GTK libraries and an aarch64
# cross compiler, used by package-linux.sh --arch arm64. The arm64 development
# packages cannot be installed beside the amd64 ones that native builds need,
# so they live in this image instead of on the build machine. The pinned Rust
# and Node toolchains are not in the image: they are mounted from the build
# user's home, so arm64 and amd64 builds use the same compilers.
FROM docker.io/library/ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401
ARG DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture arm64 \
 && sed -i -E 's/^deb (http|https|mirror)/deb [arch=amd64] \1/' /etc/apt/sources.list \
 && for suite in jammy jammy-updates jammy-security; do \
      echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports $suite main restricted universe multiverse"; \
    done > /etc/apt/sources.list.d/arm64-ports.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config git ca-certificates file xz-utils dpkg-dev fakeroot \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-dev-arm64-cross \
      libayatana-appindicator3-dev:arm64 libwebkit2gtk-4.1-dev:arm64 libgtk-3-dev:arm64 librsvg2-dev:arm64 \
      libsoup-3.0-dev:arm64 libjavascriptcoregtk-4.1-dev:arm64 \
 && rm -rf /var/lib/apt/lists/*
