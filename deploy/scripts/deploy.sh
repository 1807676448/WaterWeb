#!/usr/bin/env bash
set -e

APP_NAME="mqtt-water-quality-platform"
APP_DIR="/opt/${APP_NAME}"
SERVICE_NAME="water-quality-platform"

echo "[1/7] 创建部署目录"
sudo mkdir -p ${APP_DIR}

echo "[2/7] 同步代码到部署目录"
sudo rsync -av --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  ./ ${APP_DIR}/

echo "[3/7] 安装依赖"
cd ${APP_DIR}
sudo npm install --omit=dev

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "[4/7] 首次部署，创建 .env"
  sudo cp ${APP_DIR}/.env.example ${APP_DIR}/.env
  echo "请编辑 ${APP_DIR}/.env 后重新执行部署。"
  exit 1
fi

echo "[5/7] 安装并重载 systemd 服务"
sudo cp ${APP_DIR}/deploy/systemd/water-quality-platform.service /etc/systemd/system/${SERVICE_NAME}.service
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

echo "[6/7] 安装 Nginx 反向代理配置"
sudo cp ${APP_DIR}/deploy/nginx/water-quality-platform.conf /etc/nginx/conf.d/${APP_NAME}.conf
sudo nginx -t
sudo systemctl restart nginx

echo "[7/7] 完成"
sudo systemctl status ${SERVICE_NAME} --no-pager
