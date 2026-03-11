#!/usr/bin/env bash
set -e

APP_NAME="mqtt-water-quality-platform"
APP_DIR="/opt/${APP_NAME}"
SERVICE_NAME="water-quality-platform"
MEDIAMTX_SERVICE_NAME="mediamtx"
APP_USER="www-data"
MEDIAMTX_VERSION="1.11.3"

install_mediamtx_if_needed() {
  if command -v mediamtx >/dev/null 2>&1; then
    echo "MediaMTX 已安装：$(command -v mediamtx)"
    return
  fi

  local arch
  arch="$(uname -m)"
  local pkg_arch
  if [ "${arch}" = "x86_64" ]; then
    pkg_arch="amd64"
  elif [ "${arch}" = "aarch64" ]; then
    pkg_arch="arm64"
  else
    echo "不支持的架构: ${arch}，请手动安装 MediaMTX。"
    exit 1
  fi

  local package_url
  package_url="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${pkg_arch}.tar.gz"

  echo "下载并安装 MediaMTX ${MEDIAMTX_VERSION} (${pkg_arch})"
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "${tmpdir}"' RETURN
  curl -fsSL "${package_url}" -o "${tmpdir}/mediamtx.tar.gz"
  tar -xzf "${tmpdir}/mediamtx.tar.gz" -C "${tmpdir}"
  sudo install -m 755 "${tmpdir}/mediamtx" /usr/local/bin/mediamtx
  rm -rf "${tmpdir}"
  trap - RETURN
}

echo "[1/10] 创建部署目录"
sudo mkdir -p ${APP_DIR}

echo "[2/10] 同步代码到部署目录"
sudo rsync -av --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  ./ ${APP_DIR}/

echo "[3/10] 安装依赖"
cd ${APP_DIR}
sudo npm install --omit=dev

echo "[4/10] 修复目录权限"
sudo mkdir -p ${APP_DIR}/data
sudo chown -R ${APP_USER}:${APP_USER} ${APP_DIR}
sudo chmod 755 ${APP_DIR}
sudo chmod 755 ${APP_DIR}/data

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "[5/10] 首次部署，创建 .env"
  sudo cp ${APP_DIR}/.env.example ${APP_DIR}/.env
  sudo chown ${APP_USER}:${APP_USER} ${APP_DIR}/.env
  sudo chmod 640 ${APP_DIR}/.env
  echo "请编辑 ${APP_DIR}/.env 后重新执行部署。"
  exit 1
fi

echo "[6/10] 安装并重载业务 systemd 服务"
sudo cp ${APP_DIR}/deploy/systemd/water-quality-platform.service /etc/systemd/system/${SERVICE_NAME}.service

echo "[7/10] 检查并安装 MediaMTX"
install_mediamtx_if_needed

echo "[8/10] 安装并重载 MediaMTX 服务"
sudo cp ${APP_DIR}/deploy/systemd/mediamtx.service /etc/systemd/system/${MEDIAMTX_SERVICE_NAME}.service
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}
sudo systemctl enable ${MEDIAMTX_SERVICE_NAME}
sudo systemctl restart ${MEDIAMTX_SERVICE_NAME}

echo "[9/10] 安装 Nginx 反向代理配置"
sudo cp ${APP_DIR}/deploy/nginx/water-quality-platform.conf /etc/nginx/conf.d/00-${APP_NAME}.conf
sudo rm -f /etc/nginx/conf.d/${APP_NAME}.conf
if [ -f "/etc/nginx/sites-enabled/default" ]; then
  sudo rm -f /etc/nginx/sites-enabled/default
fi
if [ -f "/etc/nginx/conf.d/default.conf" ]; then
  sudo rm -f /etc/nginx/conf.d/default.conf
fi
sudo nginx -t
sudo systemctl restart nginx

echo "[10/10] 完成"
sudo systemctl status ${SERVICE_NAME} --no-pager
sudo systemctl status ${MEDIAMTX_SERVICE_NAME} --no-pager
