#!/usr/bin/env bash
# ============================================================
# MediaMTX 一键安装脚本 (Linux amd64)
# 在云服务器上运行: bash deploy/setup_mediamtx.sh
# ============================================================
set -e

MEDIAMTX_VERSION="1.11.3"
INSTALL_DIR="/opt/mediamtx"
CONFIG_SOURCE="$(dirname "$0")/../mediamtx.yml"

echo "=== MediaMTX 安装脚本 ==="

# 1. 下载 MediaMTX
if [ ! -f "/tmp/mediamtx.tar.gz" ]; then
  echo "[1/4] 下载 MediaMTX v${MEDIAMTX_VERSION}..."
  wget -q --show-progress -O /tmp/mediamtx.tar.gz \
    "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
fi

# 2. 解压安装
echo "[2/4] 安装到 ${INSTALL_DIR}..."
sudo mkdir -p "${INSTALL_DIR}"
sudo tar xzf /tmp/mediamtx.tar.gz -C "${INSTALL_DIR}"
sudo chmod +x "${INSTALL_DIR}/mediamtx"

# 3. 复制配置文件
echo "[3/4] 复制配置文件..."
if [ -f "${CONFIG_SOURCE}" ]; then
  sudo cp "${CONFIG_SOURCE}" "${INSTALL_DIR}/mediamtx.yml"
  echo "  已复制: ${CONFIG_SOURCE} -> ${INSTALL_DIR}/mediamtx.yml"
else
  echo "  警告: 未找到 ${CONFIG_SOURCE}, 使用默认配置"
fi

# 4. 创建 systemd 服务
echo "[4/4] 创建 systemd 服务..."
sudo tee /etc/systemd/system/mediamtx.service > /dev/null << 'EOF'
[Unit]
Description=MediaMTX RTSP Server
After=network.target

[Service]
Type=simple
ExecStart=/opt/mediamtx/mediamtx /opt/mediamtx/mediamtx.yml
Restart=always
RestartSec=5
User=root
WorkingDirectory=/opt/mediamtx

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mediamtx
sudo systemctl start mediamtx

echo ""
echo "=== 安装完成! ==="
echo "  RTSP:     rtsp://$(hostname -I | awk '{print $1}'):8554"
echo "  WebRTC:   http://$(hostname -I | awk '{print $1}'):8889"
echo "  HLS:      http://$(hostname -I | awk '{print $1}'):8888"
echo "  API:      http://127.0.0.1:9997"
echo ""
echo "  管理命令:"
echo "    sudo systemctl status mediamtx"
echo "    sudo systemctl restart mediamtx"
echo "    sudo journalctl -u mediamtx -f"
