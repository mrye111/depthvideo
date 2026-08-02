#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
[ -d server/.venv ] || python3 -m venv server/.venv
echo "[setup] 安装依赖（首次约 3-6GB）..."
server/.venv/bin/python -m pip install -r server/requirements.txt
if [ ! -f server/weights/qwen25-vl-7b-cam-motion/config.json ]; then
  echo "[setup] 首次下载运镜权重（约 15.5GB，经 hf-mirror，支持断点续传）..."
  server/.venv/bin/python -m server.download_weights
fi
echo "[run] 启动运镜分析服务：http://127.0.0.1:8788"
exec server/.venv/bin/python -m server
