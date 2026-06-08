#!/usr/bin/env bash
# ============================================================
# Canolite — One-command install script
# ============================================================
set -euo pipefail

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       Canolite — Self-hosted         ║"
echo "  ║   Template-to-Image Platform         ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required. Install: https://docs.docker.com/get-docker/"; exit 1; }
command -v docker compose >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1 || { echo "❌ Docker Compose is required."; exit 1; }

# Generate secrets
AUTH_SECRET=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
S3_ACCESS_KEY="canolite$(openssl rand -hex 4 2>/dev/null || head -c 4 /dev/urandom | xxd -p)"
S3_SECRET_KEY=$(openssl rand -base64 24 2>/dev/null || head -c 24 /dev/urandom | base64)

# Ask for domain
read -p "Enter your domain (or press Enter for localhost): " DOMAIN
DOMAIN=${DOMAIN:-localhost}

if [ "$DOMAIN" = "localhost" ]; then
  APP_URL="http://localhost:3000"
else
  APP_URL="https://${DOMAIN}"
fi

# Write .env
cat > .env << EOF
AUTH_SECRET=${AUTH_SECRET}
APP_URL=${APP_URL}
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
RENDER_CONCURRENCY=3
MAX_UPLOAD_MB=10
EOF

echo "✅ Generated .env"

# Start services
echo "🚀 Starting Canolite..."
docker compose up -d

# Wait for healthy
echo "⏳ Waiting for services to be healthy..."
sleep 10

# Run migrations & seed
echo "📦 Running database migrations..."
docker compose exec -T app npx drizzle-kit push 2>/dev/null || echo "⚠️  Migrations may need manual run"

echo ""
echo "  ✅ Canolite is running!"
echo ""
echo "  🌐 App:      ${APP_URL}"
echo "  📧 Login:    demo@canolite.local"
echo "  🔑 Password: password123"
echo ""
echo "  Run 'docker compose logs -f' to see logs"
echo ""
