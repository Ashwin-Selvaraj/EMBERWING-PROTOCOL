#!/usr/bin/env bash
# One-shot provisioning script for a fresh Oracle Cloud Always Free VM
# (Ubuntu 22.04/24.04). Run this ON THE VM after SSHing in, from inside
# a clone of this repo. It installs Node, ffmpeg, and pm2, installs
# dependencies, and starts both processes (server.js + listener.js)
# under pm2 so they survive reboots and crashes.
#
# Usage: bash scripts/oracle-setup.sh
set -euo pipefail

echo "==> Updating apt and installing ffmpeg, git, curl"
sudo apt update
sudo apt install -y ffmpeg git curl

echo "==> Installing Node.js 20.x (NodeSource)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
node -v
npm -v

echo "==> Installing pm2 globally"
sudo npm install -g pm2

echo "==> Installing project dependencies"
npm install

if [ ! -f .env ]; then
  echo "==> No .env found — copying .env.example. EDIT IT before starting the app:"
  echo "    nano .env"
  cp .env.example .env
  echo "Run this script again after filling in .env, or start manually:"
  echo "    pm2 start ecosystem.config.js"
  exit 0
fi

echo "==> Starting server.js + listener.js under pm2"
pm2 start ecosystem.config.js
pm2 save

echo "==> Configuring pm2 to auto-start on VM reboot"
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -n 1 | sudo bash || true

echo "==> Done. Useful commands:"
echo "    pm2 status         # see both processes"
echo "    pm2 logs           # tail logs from both"
echo "    pm2 logs embr-listener   # just the pump.fun watcher"
echo "    pm2 restart all    # after editing .env or pulling new code"
