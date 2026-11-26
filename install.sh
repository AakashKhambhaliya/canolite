#!/usr/bin/env bash
# ============================================================
# Canolite — one-command installer
#
#   curl -fsSL https://raw.githubusercontent.com/AakashKhambhaliya/canolite/main/install.sh | bash
#
# Optional overrides (env vars):
#   DOMAIN=canolite.example.com        # use https://DOMAIN as the public URL
#   APP_URL=https://canolite.example.com
#   PORT=3000                          # host port to expose (default 3000)
#   CANOLITE_DIR=/opt/canolite         # install location (default ~/canolite)
#   ADMIN_EMAIL=you@example.com        # auto-create admin (skip setup wizard)
#   ADMIN_PASSWORD=change-me
#   CANOLITE_SETUP_TOKEN=...           # setup wizard token (generated if unset)
#
# Video support requires ffmpeg/ffprobe. The Docker image installs them for you
# (roughly +80 MB). Non-Docker/manual installs should install ffmpeg and set
# FFMPEG_PATH / FFPROBE_PATH if the binaries are not on PATH.
# ============================================================
set -euo pipefail

REPO_URL="https://github.com/AakashKhambhaliya/canolite.git"
INSTALL_DIR="${CANOLITE_DIR:-$HOME/canolite}"
PORT_GIVEN="${PORT:-}"
PORT="${PORT:-3000}"

green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$1"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$1" >&2; }

echo ""
blue "  ╔══════════════════════════════════════╗"
blue "  ║   Canolite — self-hosted installer   ║"
blue "  ╚══════════════════════════════════════╝"
echo ""

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

# --- git ---
if ! command -v git >/dev/null 2>&1; then
  yellow "→ Installing git..."
  if   command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -y && $SUDO apt-get install -y git
  elif command -v dnf     >/dev/null 2>&1; then $SUDO dnf install -y git
  elif command -v yum     >/dev/null 2>&1; then $SUDO yum install -y git
  elif command -v apk     >/dev/null 2>&1; then $SUDO apk add --no-cache git
  else red "Please install git and re-run."; exit 1; fi
fi

# --- docker ---
if ! command -v docker >/dev/null 2>&1; then
  yellow "→ Docker not found. Installing via get.docker.com..."
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker 2>/dev/null || true
fi

# Pick a working docker invocation (handle group permissions right after install).
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
  else
    red "Cannot talk to the Docker daemon. Is it running?"; exit 1
  fi
fi

# Compose v2 plugin or legacy binary.
if $DOCKER compose version >/dev/null 2>&1; then
  COMPOSE="$DOCKER compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="${SUDO:+$SUDO }docker-compose"
else
  red "Docker Compose not found. Install Docker Compose v2 and re-run."; exit 1
fi

# --- source ---
if [ -d "$INSTALL_DIR/.git" ]; then
  blue "→ Updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || true
else
  blue "→ Cloning Canolite into $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# Read one KEY's value from an existing .env (last occurrence wins).
env_get() {
  if [ -f .env ]; then sed -n "s/^$1=//p" .env | tr -d '\r' | tail -n 1; fi
}

# Re-running this script is the documented update path, so values from a
# previous run are kept unless overridden on the command line.
if [ -z "$PORT_GIVEN" ] && [ -n "$(env_get PORT)" ]; then
  PORT="$(env_get PORT)"
fi
if [ -z "${APP_URL:-}" ] && [ -z "${DOMAIN:-}" ] && [ -n "$(env_get APP_URL)" ]; then
  APP_URL="$(env_get APP_URL)"
fi

# --- public URL ---
if [ -z "${APP_URL:-}" ]; then
  if [ -n "${DOMAIN:-}" ]; then
    APP_URL="https://${DOMAIN}"
  else
    IP="$(curl -fsS https://api.ipify.org 2>/dev/null || curl -fsS https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
    APP_URL="http://${IP:-localhost}:${PORT}"
  fi
fi

# --- setup token ---
# The first-run setup wizard asks for this so nobody else can claim a freshly
# started, publicly reachable instance. Keep the one from a previous run.
SETUP_TOKEN="${CANOLITE_SETUP_TOKEN:-}"
if [ -z "$SETUP_TOKEN" ]; then
  SETUP_TOKEN="$(env_get CANOLITE_SETUP_TOKEN)"
fi
if [ -z "$SETUP_TOKEN" ]; then
  SETUP_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

# --- env for compose ---
# Only the keys this script manages are rewritten. Everything else an operator
# put in .env (MEDIA_ACCESS=private, DATABASE_URL, ...) is carried over —
# truncating the file on update silently reverted private media to public.
# The new file is created under umask 077 (never world-readable, even
# briefly) and moved into place in one step.
MANAGED_KEYS="APP_URL|PORT|CANOLITE_SETUP_TOKEN"
if [ -n "${ADMIN_EMAIL:-}" ]; then MANAGED_KEYS="${MANAGED_KEYS}|ADMIN_EMAIL"; fi
if [ -n "${ADMIN_PASSWORD:-}" ]; then MANAGED_KEYS="${MANAGED_KEYS}|ADMIN_PASSWORD"; fi
ENV_TMP="$(umask 077 && mktemp .env.XXXXXX)"
(
  umask 077
  {
    echo "APP_URL=${APP_URL}"
    echo "PORT=${PORT}"
    if [ -n "${ADMIN_EMAIL:-}" ]; then echo "ADMIN_EMAIL=${ADMIN_EMAIL}"; fi
    if [ -n "${ADMIN_PASSWORD:-}" ]; then echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}"; fi
    echo "CANOLITE_SETUP_TOKEN=${SETUP_TOKEN}"
    if [ -f .env ]; then grep -v -E "^(${MANAGED_KEYS})=" .env || true; fi
  } > "$ENV_TMP"
)
chmod 600 "$ENV_TMP"
mv -f "$ENV_TMP" .env
green "→ Wrote .env (APP_URL=${APP_URL})"

# --- run ---
# Prefer the prebuilt image; fall back to building from source (e.g. on arm64
# or if the image isn't published/public yet).
blue "→ Fetching Canolite..."
if $COMPOSE pull --quiet 2>/dev/null; then
  green "  Using prebuilt image."
  $COMPOSE up -d
else
  yellow "  Prebuilt image unavailable — building from source (downloads Chromium, a few minutes)..."
  $COMPOSE up -d --build
fi

echo ""
green "  ✅ Canolite is starting!"
echo ""
echo "     URL:    ${APP_URL}"
echo "     Setup:  open the URL and create your admin account (one-time wizard)"
echo "     Token:  ${SETUP_TOKEN}"
echo "             (the setup wizard asks for it; it is also saved in ${INSTALL_DIR}/.env)"
echo ""
echo "     Logs:   cd ${INSTALL_DIR} && ${COMPOSE} logs -f"
echo "     Stop:   cd ${INSTALL_DIR} && ${COMPOSE} down"
echo "     Update: curl -fsSL ${REPO_URL%.git}/raw/main/install.sh | bash"
echo ""
if [ -z "${DOMAIN:-}" ]; then
  yellow "  Tip: put a reverse proxy (Caddy/Nginx) in front and re-run with"
  yellow "       DOMAIN=your-domain.com for HTTPS."
fi
