# Toolchain image for the Rust shared-core validation job.
#
# The digest deliberately names an amd64 image.  Release builds should add
# one image digest per target architecture rather than allowing a moving tag.
FROM rust:1.90-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f

ARG WASM_BINDGEN_VERSION=0.2.126

ENV CARGO_HOME=/cargo-home \
    CARGO_TERM_COLOR=always \
    PATH=/opt/wasm-bindgen/bin:${PATH}

# wasm-bindgen's version must match the wasm-bindgen crate resolved in
# ffi/Cargo.lock.  Keep this install in the image so the build cannot silently
# select a newer CLI from a developer's PATH.
RUN rustup target add wasm32-unknown-unknown \
 && cargo install --locked --version "${WASM_BINDGEN_VERSION}" \
      wasm-bindgen-cli --root /opt/wasm-bindgen

RUN rustup component add rustfmt clippy

WORKDIR /workspace
