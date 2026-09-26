# termhub's Postgres: the official postgres:16-alpine plus pgvector (spec 2026-09-26 §3.1).
# Same Postgres binary and libc (musl) as the image it replaces, so the existing data volume keeps
# its collations and needs no REINDEX. Built without LLVM bitcode and without -march=native so the
# image runs on any x86-64/arm64 host.
FROM postgres:16-alpine
ARG PGVECTOR_VERSION=0.8.0
RUN apk add --no-cache --virtual .build-deps git build-base \
 && git clone --branch "v${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no install \
 && rm -rf /tmp/pgvector \
 && apk del .build-deps
