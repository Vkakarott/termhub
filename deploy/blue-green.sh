#!/usr/bin/env bash
# Blue/green deploy for termhub.
#
# Builds and starts the inactive color, waits for it to report healthy, then
# switches the proxy nginx vhost to it and retires the previously active
# container after a grace period. Any failure before the nginx switch
# (build, health check, or a bad nginx config) leaves the previously active
# container serving traffic — there is no window where nothing answers
# requests. Open terminal WebSockets pinned to the old container reconnect
# (to the new one) when it is finally stopped.
#
# Usage:
#   bash deploy/blue-green.sh              # deploy: build + switch to the inactive color
#   bash deploy/blue-green.sh --rollback   # switch back to the other (stopped) color
#
# Env vars (all have production defaults for jarvis; override for local runs):
#   ENV_FILE         .env passed to docker compose (default: .env)
#   STATE_FILE       records the active color; its directory also holds the
#                    rendered vhost + backup (default: /mnt/hd2tb/projetos/termhub/active-color)
#   PROXY_CONF       nginx vhost file to render in place (default: /mnt/hd2tb/proxy/nginx/conf.d/termhub.dev.conf)
#   PROXY_CONTAINER  nginx container name (default: proxy-nginx)
#   DRY_RUN          when 1, print the command sequence instead of running it (default: 0)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${ENV_FILE:-.env}"
STATE_FILE="${STATE_FILE:-/mnt/hd2tb/projetos/termhub/active-color}"
PROXY_CONF="${PROXY_CONF:-/mnt/hd2tb/proxy/nginx/conf.d/termhub.dev.conf}"
PROXY_CONTAINER="${PROXY_CONTAINER:-proxy-nginx}"
DRY_RUN="${DRY_RUN:-0}"
VHOST_TEMPLATE="$REPO_ROOT/deploy/nginx/termhub.dev.conf.tmpl"
STATE_DIR="$(dirname "$STATE_FILE")"

# The commit this build comes from, baked into the web bundle and shown in the chat's header: it is
# what tells a screen apart from a cached one without anybody guessing. Empty outside a checkout,
# where the bundle falls back to its build time.
VITE_BUILD_SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"
export VITE_BUILD_SHA

COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.proxy.yml --profile prod)

log() {
  echo "[blue-green] $*"
}

# run <description> <cmd...>: executes <cmd...>, or under DRY_RUN just prints it.
run() {
  local desc="$1"
  shift
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: $desc"
    printf ' +'
    printf ' %q' "$@"
    printf '\n'
  else
    log "$desc"
    "$@"
  fi
}

# Make sure the directory that holds the state file (and the rendered
# vhost/backup, see switch_proxy) exists before anything tries to write to it.
run "ensure state dir exists" mkdir -p "$STATE_DIR"

# Source of truth, in order: (1) which container the live nginx vhost points
# at — that's what's actually serving traffic; (2) the last color this
# script wrote; (3) docker ps, as a last resort (e.g. before the vhost or
# state file exist at all). Prints blue / green / legacy / none.
#
# Anchored to the directive that names the container (and comment lines
# stripped first) so a color name mentioned in a comment elsewhere in the file
# can never be mistaken for the active one.
#
# Two spellings are accepted. The template renders `set $upstream_app
# <container>;` and proxies through that variable, because a `proxy_pass` with
# the host spelled out creates an implicit nginx server group named
# `host:port`, which shadows the resolver and pins the upstream to the IP it
# had when the config was loaded. A vhost rendered before that change still
# says `proxy_pass http://termhub-app-<color>:3000`, so that form is read too
# — the first deploy after the change reads exactly such a file.
detect_active() {
  local match stripped

  if [ -f "$PROXY_CONF" ]; then
    stripped="$(grep -vE '^[[:space:]]*#' "$PROXY_CONF" 2>/dev/null || true)"
    match="$(grep -oE 'set[[:space:]]+\$upstream_app[[:space:]]+termhub-app-(blue|green)|proxy_pass[[:space:]]+https?://termhub-app-(blue|green)' <<<"$stripped" | grep -oE '(blue|green)$' | head -n1 || true)"
    if [ -n "$match" ]; then
      echo "$match"
      return
    fi
    if grep -qE 'set[[:space:]]+\$upstream_app[[:space:]]+termhub-app;|proxy_pass[[:space:]]+https?://termhub-app:3000' <<<"$stripped"; then
      echo legacy
      return
    fi
  fi

  if [ -f "$STATE_FILE" ]; then
    match="$(cat "$STATE_FILE" 2>/dev/null || true)"
    if [ -n "$match" ]; then
      echo "$match"
      return
    fi
  fi

  local names
  names="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
  if grep -qx 'termhub-app-blue' <<<"$names"; then
    echo blue
  elif grep -qx 'termhub-app-green' <<<"$names"; then
    echo green
  elif grep -qx 'termhub-app' <<<"$names"; then
    echo legacy
  else
    echo none
  fi
}

# A color container running but NOT the one nginx currently serves is a
# leftover from an earlier interrupted run. Stop it before doing anything
# else — never build/recreate over it blindly, and never treat it as if it
# were the serving container.
cleanup_leftover() {
  local active="$1"
  local names other
  names="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
  for other in blue green; do
    if [ "$other" != "$active" ] && grep -qx "termhub-app-$other" <<<"$names"; then
      log "leftover: termhub-app-$other is running but nginx currently serves '$active'"
      run "stop leftover app-$other" "${COMPOSE[@]}" stop "app-$other"
    fi
  done
}

# Polls the target's healthcheck for up to 40 x 5s. Fails fast if the
# container isn't even running (crashed on start) instead of waiting out
# the full timeout. On failure, prints the target's last 100 log lines,
# stops only the target (the previously active container is never touched),
# and exits 1.
wait_healthy() {
  local target="$1"
  local container="termhub-app-$target"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: poll up to 40x5s (fail fast if not running): docker inspect --format '{{.State.Health.Status}}' $container"
    return 0
  fi

  local i st running
  for i in $(seq 1 40); do
    running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo false)"
    if [ "$running" != "true" ]; then
      log "attempt $i: $container is not running; failing fast"
      break
    fi
    st="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo starting)"
    log "attempt $i: $container = $st"
    if [ "$st" = "healthy" ]; then
      return 0
    fi
    sleep 5
  done

  log "$container did not become healthy; last 100 log lines:"
  docker logs --tail=100 "$container" || true
  "${COMPOSE[@]}" stop "app-$target"
  log "stopped app-$target; the previously active container keeps serving"
  exit 1
}

# Renders the vhost template for $target, tests it with nginx -t, and
# reloads nginx on success. The rendered file and backup live in
# $STATE_DIR (not conf.d) so no stray .new/.bak ever sits next to the
# vhosts nginx's *.conf include glob loads; PROXY_CONF itself is only ever
# overwritten in place with cp (mv would not be atomic across directories).
# On failure, restores PROXY_CONF from the backup and exits 1 — the
# previous vhost (and thus the previously active container) keeps serving.
switch_proxy() {
  local target="$1"
  local container="termhub-app-$target"
  local rendered="$STATE_DIR/termhub.dev.conf.new"
  local backup="$STATE_DIR/termhub.dev.conf.bak"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: sed 's/__APP_HOST__/$container/' $VHOST_TEMPLATE > $rendered"
    log "DRY_RUN: cp $PROXY_CONF $backup"
    log "DRY_RUN: cp $rendered $PROXY_CONF"
    log "DRY_RUN: docker exec $PROXY_CONTAINER nginx -t"
    log "DRY_RUN: docker exec $PROXY_CONTAINER nginx -s reload"
    return 0
  fi

  log "rendering vhost for $container"
  sed "s/__APP_HOST__/$container/" "$VHOST_TEMPLATE" > "$rendered"
  cp "$PROXY_CONF" "$backup"
  cp "$rendered" "$PROXY_CONF"

  if ! docker exec "$PROXY_CONTAINER" nginx -t; then
    log "nginx -t failed for $container; restoring previous vhost"
    cp "$backup" "$PROXY_CONF"
    exit 1
  fi

  log "reloading nginx"
  docker exec "$PROXY_CONTAINER" nginx -s reload
}

# 30s grace period (lets in-flight requests and long-lived terminal
# WebSockets on the old container drain/reconnect), then stops (color) or
# renames+stops (legacy) the previously active container. Colors are only
# stopped, never removed, so a rollback is a plain `docker start`; legacy is
# renamed to termhub-app-legacy and stopped (not removed) so a manual
# rollback to it stays possible after the very first run.
retire_old() {
  local old="$1"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: sleep 30 (grace period before retiring $old)"
  else
    log "grace period: sleeping 30s before retiring $old"
    sleep 30
  fi

  case "$old" in
    blue | green)
      run "stop app-$old (kept for rollback)" "${COMPOSE[@]}" stop "app-$old"
      ;;
    legacy)
      run "rename legacy termhub-app -> termhub-app-legacy" docker rename termhub-app termhub-app-legacy
      run "stop termhub-app-legacy (kept for manual rollback)" docker stop termhub-app-legacy
      ;;
    none)
      log "no previously active container to retire"
      ;;
  esac

  # A termhub-app-legacy left over from an earlier first-run deploy is no
  # longer needed once a later deploy has succeeded; clean it up quietly.
  if [ "$old" != "legacy" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY_RUN: docker rm -f termhub-app-legacy (if present)"
    else
      docker rm -f termhub-app-legacy >/dev/null 2>&1 || true
    fi
  fi
}

write_state() {
  local target="$1"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: echo $target > $STATE_FILE"
  else
    echo "$target" > "$STATE_FILE"
  fi
}

deploy() {
  local active target
  active="$(detect_active)"
  cleanup_leftover "$active"

  case "$active" in
    blue) target=green ;;
    *) target=blue ;;
  esac
  log "active: $active, target: $target"

  run "build + start app-$target" "${COMPOSE[@]}" up -d --build --no-deps "app-$target"
  wait_healthy "$target"
  switch_proxy "$target"
  write_state "$target"
  retire_old "$active"

  log "active: $target, retired: $active"
}

rollback() {
  local current target target_container
  current="$(detect_active)"
  cleanup_leftover "$current"

  case "$current" in
    blue) target=green ;;
    green) target=blue ;;
    *)
      log "cannot rollback: current active color is '$current' (expected blue or green; no stopped color to roll back to)"
      exit 1
      ;;
  esac
  target_container="termhub-app-$target"

  if [ "$DRY_RUN" != "1" ]; then
    if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$target_container"; then
      log "cannot rollback: $target_container does not exist (no stopped color to roll back to)"
      exit 1
    fi
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$target_container"; then
      log "cannot rollback: $target_container is already running"
      exit 1
    fi
  fi

  log "rolling back: current: $current, target: $target"

  run "start $target_container" docker start "$target_container"
  wait_healthy "$target"
  switch_proxy "$target"
  write_state "$target"
  run "stop app-$current (previously active)" "${COMPOSE[@]}" stop "app-$current"

  log "active: $target, stopped: $current"
}

case "${1:-}" in
  --rollback)
    rollback
    ;;
  "")
    deploy
    ;;
  *)
    echo "Usage: $0 [--rollback]" >&2
    exit 1
    ;;
esac
