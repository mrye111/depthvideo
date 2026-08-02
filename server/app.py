"""FastAPI 应用：/health、/videos、/analyze（契约与 spec #26 逐字段一致）。"""
from __future__ import annotations

import hashlib
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import frames, motion

app = FastAPI(title='depthvideo motion service', docs_url=None, redoc_url=None)

# CORS：仅 localhost/127.0.0.1 任意端口源（本站页面）
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r'https?://(localhost|127\.0\.0\.1)(:\d+)?',
    allow_methods=['GET', 'POST', 'OPTIONS'],
    allow_headers=['*'],
)

TMP = Path(tempfile.gettempdir()) / 'depthvideo-motion'
TMP.mkdir(parents=True, exist_ok=True)

_videos: dict[str, Path] = {}
_videos_lock = threading.Lock()


class AnalyzeReq(BaseModel):
    videoId: str
    startSec: float
    endSec: float


@app.get('/health')
def health() -> dict:
    err = motion.load_error()
    return {
        'status': 'ok',
        'modelLoaded': motion.is_loaded(),
        **({'loadError': err} if err and not motion.is_loaded() else {}),
    }


@app.post('/videos')
async def upload_video(file: UploadFile) -> dict:
    # 边收边算指纹（前 8MB + 文件大小），同一文件复用同一 videoId
    h = hashlib.sha256()
    buf = bytearray()
    size = 0
    while chunk := await file.read(1 << 20):
        if size < (8 << 20):
            h.update(chunk)
        buf.extend(chunk)
        size += len(chunk)
    h.update(str(size).encode())
    video_id = h.hexdigest()[:16]
    with _videos_lock:
        path = _videos.get(video_id)
        if path is None or not path.exists():
            suffix = Path(file.filename or 'video.mp4').suffix or '.mp4'
            path = TMP / f'{video_id}{suffix}'
            path.write_bytes(bytes(buf))
            _videos[video_id] = path
    meta = frames.probe_meta(str(_videos[video_id]))
    return {'videoId': video_id, **meta}


@app.post('/analyze')
def analyze(req: AnalyzeReq) -> dict:
    with _videos_lock:
        path = _videos.get(req.videoId)
    if path is None or not path.exists():
        return {'error': f'未知 videoId：{req.videoId}（请先 POST /videos）'}
    if req.endSec - req.startSec <= 0:
        return {'error': 'startSec 必须小于 endSec'}
    sampled = frames.sample_frames(str(path), req.startSec, req.endSec)
    return motion.analyze(sampled)


@app.on_event('startup')
def _startup() -> None:
    # 后台预装载模型；/health 在装载完成前返回 modelLoaded=false
    motion.ensure_loaded(blocking=False)
