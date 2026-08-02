@echo off
setlocal
cd /d %~dp0..
if not exist server\.venv\Scripts\python.exe (
  echo [setup] 创建虚拟环境...
  python -m venv server\.venv || exit /b 1
)
echo [setup] 安装依赖（首次约 3-6GB）...
server\.venv\Scripts\python.exe -m pip install -r server\requirements.txt || exit /b 1
if not exist server\weights\qwen25-vl-7b-cam-motion\config.json (
  echo [setup] 首次下载运镜权重（约 15.5GB，经 hf-mirror，支持断点续传）...
  server\.venv\Scripts\python.exe -m server.download_weights || exit /b 1
)
echo [run] 启动运镜分析服务：http://127.0.0.1:8788
server\.venv\Scripts\python.exe -m server
