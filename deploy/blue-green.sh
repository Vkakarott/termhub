#!/usr/bin/env bash
# Blue/green deploy for termhub.
#
# Builds and starts the inactive color, waits for it to report healthy, then
# switches the proxy nginx vhost to it and retires the previously active
# container. Any failure before the nginx switch (build, health check, or a
# bad nginx config) leaves the previously active container serving traffic —
# there is no window where nothing answers requests.
#
# Usage:
#   bash deploy/blue-green.sh              # deploy: build + switch to the inactive color
#   bash deploy/blue-green.sh --rollback   # switch back to the other (stopped) color
#
# Env vars (all have production defaults for jarvis; override for local runs):
#   ENV_FILE         .env passed to docker compose (default: .env)
#   STATE_FILE       records the active color (default: /mnt/hd2tb/projetos/termhub/active-color)
#   PROXY_CONF       nginx vhost file to render (default: /mnt/hd2tb/proxy/nginx/conf.d/termhub.dev.conf)
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

# Prints blue / green / legacy / none. blue/green take priority over the
# legacy single container; legacy is only reported when neither is running.
detect_active() {
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

# Polls the target's healthcheck for up to 40 x 5s. On failure, prints the
# target's last 100 log lines, stops only the target (the previously active
# container is never touched), and exits 1.
wait_healthy() {
  local target="$1"
  local container="termhub-app-$target"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: poll up to 40x5s: docker inspect --format '{{.State.Health.Status}}' $container"
    return 0
  fi

  local i st
  for i in $(seq 1 40); do
    st="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "starting")"
    log "attempt $i: $container = $st"
    if [ "$st" = "healthy" ]; then
      return 0
    fi
    sleep 5
  done

  log "$container did not become healthy in time; last 100 log lines:"
  docker logs --tail=100 "$container" || true
  "${COMPOSE[@]}" stop "app-$target"
  log "stopped app-$target; the previously active container keeps serving"
  exit 1
}

# Renders the vhost template for $target, tests it with nginx -t, and reloads
# nginx on success. On failure, restores the previous conf from the .bak
# taken right before the switch and exits 1 — the previous vhost (and thus
# the previously active container) keeps serving.
switch_proxy() {
  local target="$1"
  local container="termhub-app-$target"
  local rendered="$PROXY_CONF.new"
  local backup="$PROXY_CONF.bak"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: sed 's/__APP_HOST__/$container/' $VHOST_TEMPLATE > $rendered"
    log "DRY_RUN: cp $PROXY_CONF $backup"
    log "DRY_RUN: mv $rendered $PROXY_CONF"
    log "DRY_RUN: docker exec $PROXY_CONTAINER nginx -t"
    log "DRY_RUN: docker exec $PROXY_CONTAINER nginx -s reload"
    return 0
  fi

  log "rendering vhost for $container"
  sed "s/__APP_HOST__/$container/" "$VHOST_TEMPLATE" > "$rendered"
  cp "$PROXY_CONF" "$backup"
  mv "$rendered" "$PROXY_CONF"

  if ! docker exec "$PROXY_CONTAINER" nginx -t; then
    log "nginx -t failed for $container; restoring previous vhost"
    mv "$backup" "$PROXY_CONF"
    exit 1
  fi

  log "reloading nginx"
  docker exec "$PROXY_CONTAINER" nginx -s reload
}

# 5s grace period, then stops (color) or stops+removes (legacy) the
# previously active container. Colors are only stopped, never removed, so a
# rollback is a plain `docker start`.
retire_old() {
  local old="$1"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: sleep 5 (grace period before retiring $old)"
  else
    log "grace period: sleeping 5s before retiring $old"
    sleep 5
  fi

  case "$old" in
    blue | green)
      run "stop app-$old (kept for rollback)" "${COMPOSE[@]}" stop "app-$old"
      ;;
    legacy)
      run "stop legacy termhub-app" docker stop termhub-app
      run "remove legacy termhub-app" docker rm termhub-app
      ;;
    none)
      log "no previously active container to retire"
      ;;
  esac
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
  case "$active" in
    blue) target=green ;;
    *) target=blue ;;
  esac
  log "active: $active, target: $target"

  run "build + start app-$target" "${COMPOSE[@]}" up -d --build --no-deps "app-$target"
  wait_healthy "$target"
  switch_proxy "$target"
  retire_old "$active"
  write_state "$target"

  log "active: $target, retired: $active"
}

rollback() {
  local current target target_container

  if [ -f "$STATE_FILE" ]; then
    current="$(cat "$STATE_FILE")"
  else
    current="$(detect_active)"
  fi

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
  run "stop app-$current (previously active)" "${COMPOSE[@]}" stop "app-$current"
  write_state "$target"

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
