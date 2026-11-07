#!/usr/bin/env bash
# Installs the systemd service for the ELEVARIQ Personal Agent. Idempotent. Does NOT enable/start unless --enable is passed.
# Usage: sudo scripts/linux/install.sh [--enable]
set -euo pipefail

APP_DIR=/opt/elevariq-personal-agent
STATE_DIR=/var/lib/elevariq-agent
CONF_DIR=/etc/elevariq-agent
SVC_USER=elevariq-agent

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
command -v node >/dev/null || { echo "node >= 22.12 is required"; exit 1; }
[ -f "$APP_DIR/dist/cli/index.js" ] || { echo "Deploy and build first: copy the repo to $APP_DIR, then 'npm ci && npm run build'"; exit 1; }

id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$STATE_DIR"
install -d -o root -g "$SVC_USER" -m 0750 "$CONF_DIR"
if [ ! -f "$CONF_DIR/agent.env" ]; then
  install -o root -g "$SVC_USER" -m 0640 "$APP_DIR/.env.example" "$CONF_DIR/agent.env"
  echo "Created $CONF_DIR/agent.env from the template. Edit it to add credentials (never commit them)."
fi
# The service user must be able to read the app but not write to it.
chown -R root:root "$APP_DIR"; chmod -R go-w "$APP_DIR"
install -m 0644 "$APP_DIR/scripts/linux/elevariq-agent.service" /etc/systemd/system/elevariq-agent.service
install -m 0644 "$APP_DIR/scripts/linux/elevariq-dashboard.service" /etc/systemd/system/elevariq-dashboard.service
systemctl daemon-reload
if [ "${1:-}" = "--enable" ]; then systemctl enable --now elevariq-agent.service; else
  echo "Installed. Start with: sudo systemctl enable --now elevariq-agent   (status: systemctl status elevariq-agent)"; fi
echo "Command center (optional, loopback only): sudo systemctl enable --now elevariq-dashboard"
echo "  then from your machine: ssh -L 4317:127.0.0.1:4317 <user>@<this-host>  and open http://127.0.0.1:4317/"
echo "Firewall: expose only SSH, e.g.  ufw default deny incoming && ufw allow OpenSSH && ufw enable"
