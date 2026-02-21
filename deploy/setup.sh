#!/usr/bin/env bash
set -euo pipefail

# === Polymarket Maker Bot — Linux VPS Deployment ===
#
# Prerequisites:
#   - Ubuntu 22.04+ / Debian 12+
#   - Root or sudo access
#   - Node.js 20+ installed (via nvm or nodesource)
#
# Usage:
#   chmod +x deploy/setup.sh
#   sudo ./deploy/setup.sh
#

APP_DIR="/opt/polymarket-bot"
LOG_DIR="/var/log/polymarket-maker"
SERVICE_NAME="polymarket-maker"

echo "=== Polymarket Maker Bot Setup ==="

# 1. Install Node.js 20 if missing
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node -v)"

# 2. Create app user
if ! id -u polymarket &>/dev/null; then
  useradd --system --shell /bin/false --create-home polymarket
  echo "Created polymarket user"
fi

# 3. Deploy application
mkdir -p "$APP_DIR" "$LOG_DIR"
cp -r dist/ "$APP_DIR/dist/"
cp package.json package-lock.json "$APP_DIR/"

cd "$APP_DIR"
npm ci --production
chown -R polymarket:polymarket "$APP_DIR" "$LOG_DIR"

# 4. Install systemd service
cp deploy/polymarket-maker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy your .env file to $APP_DIR/.env"
echo "  2. Run: sudo systemctl start $SERVICE_NAME"
echo "  3. Check logs: journalctl -u $SERVICE_NAME -f"
echo ""
echo "PM2 alternative:"
echo "  npm install -g pm2"
echo "  cd $APP_DIR && pm2 start ecosystem.config.cjs"
echo "  pm2 save && pm2 startup"
