"""冒烟脚本：验证运镜分析服务端到端（需服务已在 127.0.0.1:8788 运行）。

用法：
  python -m server.smoke [视频路径]
  - 不传视频时使用仓库内 e2e 样片（.recon/e2e/transitions.mp4，缺失则用 ffmpeg 现生成）
断言：/health modelLoaded=true；上传 → /analyze 返回 labels（8 维）+ 非空 description。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://127.0.0.1:8788'

SAMPLE = ROOT / '.recon' / 'e2e' / 'transitions.mp4'


def ensure_sample() -> Path:
    if SAMPLE.exists():
        return SAMPLE
    ff = ROOT / '.recon' / 'bin' / 'ffmpeg.exe'
    if not ff.exists():
        sys.exit('样片缺失且无 ffmpeg：请传入视频路径参数')
    SAMPLE.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            str(ff), '-y',
            '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
            '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25',
            '-filter_complex',
            '[0:v]trim=0:1,setpts=PTS-STARTPTS[v0];[1:v]trim=0:1,setpts=PTS-STARTPTS[v1];'
            '[v0][v1]concat=n=2:v=1:a=0[out]',
            '-map', '[out]', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast',
            str(SAMPLE),
        ],
        check=True, capture_output=True,
    )
    return SAMPLE


def main() -> None:
    video = Path(sys.argv[1]) if len(sys.argv) > 1 else ensure_sample()
    print(f'样片: {video}')

    h = requests.get(f'{BASE}/health', timeout=5).json()
    print('health:', h)
    assert h.get('modelLoaded') is True, f'模型未装载：{h}'

    with open(video, 'rb') as f:
        up = requests.post(f'{BASE}/videos', files={'file': (video.name, f, 'video/mp4')}, timeout=120).json()
    print('upload:', up)
    assert up.get('videoId'), up

    # 分析前 1.0s 区间（样片第一段）
    res = requests.post(
        f'{BASE}/analyze',
        json={'videoId': up['videoId'], 'startSec': 0.0, 'endSec': 1.0},
        timeout=600,
    ).json()
    print('analyze:', json.dumps(res, ensure_ascii=False, indent=1)[:1200])
    labels = res.get('labels') or {}
    assert len(labels) >= 8, f'维度不足：{list(labels)}'
    for dim, v in labels.items():
        assert v.get('label') and 0 <= v.get('prob', -1) <= 1, f'{dim} 异常：{v}'
    assert res.get('description'), 'description 为空'
    print('\nSMOKE PASS')


if __name__ == '__main__':
    main()
