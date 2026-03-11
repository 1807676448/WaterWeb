#!/usr/bin/env bash
set -e

# Relay K230 RTSP stream to local MediaMTX for web playback.
# Example:
#   bash tools/k230_rtsp_relay.sh rtsp://192.168.1.88:8554/test device_k230_001

if [ $# -lt 2 ]; then
  echo "Usage: $0 <k230_rtsp_url> <device_id> [mediamtx_host]"
  exit 1
fi

K230_URL="$1"
DEVICE_ID="$2"
MEDIAMTX_HOST="${3:-127.0.0.1}"
TARGET_URL="rtsp://${MEDIAMTX_HOST}:8554/live/${DEVICE_ID}"

echo "[relay] from: ${K230_URL}"
echo "[relay] to  : ${TARGET_URL}"

ffmpeg \
  -rtsp_transport tcp \
  -i "${K230_URL}" \
  -an \
  -c:v copy \
  -f rtsp \
  -rtsp_transport tcp \
  "${TARGET_URL}"
