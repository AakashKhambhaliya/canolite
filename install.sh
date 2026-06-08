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
# ============================================================
set -euo pipefail

REPO_URL="https://github.com/AakashKhambhaliya/canolite.git"
INSTALL_DIR="${CANOLITE_DIR:-$HOME/canolite}"
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

# --- public URL ---
if [ -z "${APP_URL:-}" ]; then
  if [ -n "${DOMAIN:-}" ]; then
    APP_URL="https://${DOMAIN}"
  else
    IP="$(curl -fsS https://api.ipify.org 2>/dev/null || curl -fsS https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
    APP_URL="http://${IP:-localhost}:${PORT}"
  fi
fi

# --- env for compose ---
{
  echo "APP_URL=${APP_URL}"
  echo "PORT=${PORT}"
  [ -n "${ADMIN_EMAIL:-}" ]    && echo "ADMIN_EMAIL=${ADMIN_EMAIL}"
  [ -n "${ADMIN_PASSWORD:-}" ] && echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}"
} > .env
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
echo ""
echo "     Logs:   cd ${INSTALL_DIR} && ${COMPOSE} logs -f"
echo "     Stop:   cd ${INSTALL_DIR} && ${COMPOSE} down"
echo "     Update: curl -fsSL ${REPO_URL%.git}/raw/main/install.sh | bash"
echo ""
if [ -z "${DOMAIN:-}" ]; then
  yellow "  Tip: put a reverse proxy (Caddy/Nginx) in front and re-run with"
  yellow "       DOMAIN=your-domain.com for HTTPS."
fi
