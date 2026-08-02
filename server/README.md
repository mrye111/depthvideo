# 运镜分析服务（server/）

本地 GPU 运镜分析服务：配合「镜头分析」页面（/shots.html）使用，提供逐镜头运镜标签 + 一句话描述。模型为 CameraBench 全量微调的 Qwen2.5-VL-7B（`chancharikm/qwen2.5-vl-7b-cam-motion`），4bit 量化运行。

## 快速开始

- Windows：`server\start.bat`
- Linux/WSL2/macOS：`bash server/start.sh`
- 或手动：`python -m venv server/.venv && server/.venv/Scripts/python -m pip install -r server/requirements.txt && server/.venv/Scripts/python -m server`

首次启动会自动：建虚拟环境 → 装依赖（~3-6GB，含 torch cu128）→ 下载权重（**15.46GB**，经 hf-mirror，`server/download_weights.py` 断点续传，中断后重跑同一命令继续）。

服务地址：`http://127.0.0.1:8788`（仅绑回环；端口用 `MOTION_PORT` 覆盖）。

## 环境要求

- GPU：NVIDIA，显存 ≥16GB（4bit 权重 ≈5-6GB + 激活余量；本机 RTX 5070 Ti 16GB 实测）
- **Blackwell（sm_120 / RTX 50 系）**：torch ≥2.7 + cu128（requirements 已带 cu128 index）；driver ≥ R570；attention 固定 sdpa（flash-attn 官方 wheel 尚无 sm_120 标注，要试自行切换 `motion.py` 的 `attn_implementation`）
- Windows 原生需 bitsandbytes ≥0.45（原生 Windows 支持）；若装载失败，**推荐 WSL2**（Ubuntu 下 bnb 最稳，仓库路径经 `/mnt/d/...` 访问）
- Python 3.12+

## API（与 spec #26 契约一致）

| 端点 | 说明 |
|---|---|
| `GET /health` | `{ status, modelLoaded[, loadError] }` |
| `POST /videos` | multipart 视频 → `{ videoId, durationSec, fps }`（同文件复用 id） |
| `POST /analyze` | `{ videoId, startSec, endSec }` → `{ labels, description }` |

`labels` 为 8 维（dolly/pan/pedestal/arc/zoom/static/shaking/speed），每维 `{ label, prob }`（候选二分类打分取 argmax，协议见 `motion.py` 头注）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MOTION_MODEL_PATH` | `server/weights/qwen25-vl-7b-cam-motion` | 权重目录 |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 权重下载端点 |
| `MOTION_FPS` | `8.0` | 抽帧率（模型按 8fps 训练，勿随意改） |
| `MOTION_MAX_FRAMES` | `64` | 单镜头最大帧数（token 预算） |
| `MOTION_PORT` | `8788` | 服务端口 |

## 冒烟验证

服务运行后：`server/.venv/Scripts/python -m server.smoke [视频路径]`（不传则用内置样片），断言 /health + 上传 + 8 维标签 + 非空描述。

## 许可与署名

- 模型与代码库：CameraBench（[CC BY 4.0](https://github.com/sy77777en/CameraBench)，需署名）— Chancharik Mitra et al.
- 基座：Qwen2.5-VL-7B-Instruct（Apache-2.0）
- 转场检测（前端）：TransNet V2（MIT）
