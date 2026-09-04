# PHP validation image for the mandatory Rust FFI adapter.
FROM php:8.5-cli-bookworm@sha256:19667d836740e24a3ba340532c7349ab59bb961b86f20e3c85a58150644e5e55

RUN apt-get update \
 && apt-get install -y --no-install-recommends git libffi-dev unzip \
 && docker-php-ext-install ffi \
 && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2@sha256:4d71c3c2109c61d5415544264b59ad4087e4c5b7244481723664138fd36d5040 \
     /usr/bin/composer /usr/bin/composer

WORKDIR /workspace
