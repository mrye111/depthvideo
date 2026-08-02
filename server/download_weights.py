"""运镜权重下载器（requests + Range 断点续传）。

huggingface_hub 1.26.0 在本机对 hf-mirror 的 HEAD 元数据请求失败（原因未查明，
requests/httpx 直连同 URL 均 200），故自实现下载：文件清单固定（24 个，与
https://huggingface.co/chancharikm/qwen2.5-vl-7b-cam-motion 一致），逐文件
断点续传，重复执行幂等。

用法：python -m server.download_weights
环境变量：MOTION_MODEL_PATH（默认 server/weights/qwen25-vl-7b-cam-motion）
          HF_ENDPOINT（默认 https://hf-mirror.com）
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import requests

REPO = 'chancharikm/qwen2.5-vl-7b-cam-motion'
FILES = [
    '.gitattributes', 'README.md', 'added_tokens.json', 'all_results.json',
    'chat_template.json', 'config.json', 'eval_results.json', 'generation_config.json',
    'merges.txt', 'model-00001-of-00004.safetensors', 'model-00002-of-00004.safetensors',
    'model-00003-of-00004.safetensors', 'model-00004-of-00004.safetensors',
    'model.safetensors.index.json', 'preprocessor_config.json', 'special_tokens_map.json',
    'tokenizer.json', 'tokenizer_config.json', 'train_results.json', 'trainer_state.json',
    'training_args.bin', 'training_eval_loss.png', 'training_loss.png', 'vocab.json',
]

ROOT = Path(__file__).resolve().parent
TARGET = Path(os.environ.get('MOTION_MODEL_PATH') or (ROOT / 'weights' / 'qwen25-vl-7b-cam-motion'))
ENDPOINT = os.environ.get('HF_ENDPOINT', 'https://hf-mirror.com').rstrip('/')
CHUNK = 1 << 20  # 1MB


def human(n: float) -> str:
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or u == 'GB':
            return f'{n:.1f}{u}'
        n /= 1024
    return f'{n:.1f}GB'


def remote_size(url: str) -> int | None:
    try:
        r = requests.head(url, allow_redirects=True, timeout=30)
        if r.ok and r.headers.get('content-length'):
            return int(r.headers['content-length'])
    except requests.RequestException:
        pass
    return None


def download_one(name: str) -> None:
    url = f'{ENDPOINT}/{REPO}/resolve/main/{name}'
    dst = TARGET / name
    part = TARGET / (name + '.part')
    dst.parent.mkdir(parents=True, exist_ok=True)

    want = remote_size(url)
    if dst.exists() and (want is None or dst.stat().st_size == want):
        print(f'  跳过（已完整） {name}')
        return

    have = part.stat().st_size if part.exists() else 0
    headers = {'Range': f'bytes={have}-'} if have else {}
    if have and want is not None and have >= want:
        part.replace(dst)
        print(f'  完成（续接收尾） {name}')
        return

    t0 = time.time()
    got = have
    with requests.get(url, headers=headers, stream=True, timeout=60) as r:
        if have and r.status_code == 200:
            # 服务端不支持续传：重来
            got = 0
            mode = 'wb'
        else:
            r.raise_for_status()
            mode = 'ab' if have else 'wb'
        total = want if want is not None else int(r.headers.get('content-length') or 0) + have
        with open(part, mode) as f:
            for chunk in r.iter_content(CHUNK):
                if not chunk:
                    continue
                f.write(chunk)
                got += len(chunk)
                if total:
                    pct = got / total * 100
                    speed = got / max(1e-6, time.time() - t0)
                    print(f'\r  {name} {pct:5.1f}% {human(got)}/{human(total)} {human(speed)}/s', end='', flush=True)
    if want is not None and got != want:
        raise RuntimeError(f'{name} 大小不符：{got} != {want}（下次运行继续）')
    part.replace(dst)
    print(f'\r  完成 {name}（{human(got)}）' + ' ' * 20)


def main() -> None:
    print(f'目标目录: {TARGET}')
    print(f'下载端点: {ENDPOINT}')
    for name in FILES:
        for attempt in range(5):
            try:
                download_one(name)
                break
            except Exception as e:  # noqa: BLE001
                print(f'\n  失败（第 {attempt + 1} 次）{name}: {e}')
                time.sleep(3 * (attempt + 1))
        else:
            sys.exit(f'放弃：{name} 多次失败')
    print('全部完成。')


if __name__ == '__main__':
    main()
