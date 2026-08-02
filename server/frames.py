"""视频抽帧：PyAV 主路径（seek + 顺序解码），OpenCV 回退。

协议（票 #25 调研结论）：按 fps=8.0 均匀抽帧；超长镜头先等间隔降帧控制
token 预算（MAX_FRAMES 封顶）；区间末尾不足时重复末帧。
"""
from __future__ import annotations

import os

FPS = float(os.environ.get('MOTION_FPS', '8.0'))
MAX_FRAMES = int(os.environ.get('MOTION_MAX_FRAMES', '64'))


def target_times(start_sec: float, end_sec: float) -> list[float]:
    dur = max(0.01, end_sec - start_sec)
    n = max(1, min(MAX_FRAMES, round(dur * FPS)))
    step = dur / n
    return [start_sec + step * (i + 0.5) for i in range(n)]


def sample_frames(video_path: str, start_sec: float, end_sec: float):
    """返回 RGB24 numpy 帧列表（H×W×3 uint8）。"""
    try:
        return _sample_av(video_path, start_sec, end_sec)
    except ImportError:
        return _sample_cv(video_path, start_sec, end_sec)


def _sample_av(video_path: str, start_sec: float, end_sec: float):
    import av  # PyAV

    times = target_times(start_sec, end_sec)
    frames = []
    with av.open(video_path) as container:
        stream = container.streams.video[0]
        # 先 seek 到区间前一点，再顺序解码取目标时刻帧
        container.seek(max(0, int((start_sec - 0.5) / stream.time_base)), stream=stream, any_frame=False)
        for frame in container.decode(stream):
            t = float(frame.pts * stream.time_base)
            while times and t >= times[0] - 1e-3:
                frames.append(frame.to_ndarray(format='rgb24'))
                times.pop(0)
            if not times:
                break
    if not frames:
        raise RuntimeError('区间内未解出任何帧')
    while times:  # 区间尾部不足：重复末帧
        frames.append(frames[-1])
        times.pop(0)
    return frames


def _sample_cv(video_path: str, start_sec: float, end_sec: float):
    import cv2  # OpenCV 回退

    times = target_times(start_sec, end_sec)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError('视频无法打开')
    frames = []
    try:
        for t in times:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    finally:
        cap.release()
    if not frames:
        raise RuntimeError('区间内未解出任何帧')
    while len(frames) < len(times):
        frames.append(frames[-1])
    return frames


def probe_meta(video_path: str) -> dict:
    """时长/帧率（PyAV 主，cv2 回退）。"""
    try:
        import av

        with av.open(video_path) as container:
            stream = container.streams.video[0]
            dur = float(container.duration / 1e6) if container.duration else 0.0
            fps = float(stream.average_rate) if stream.average_rate else 0.0
            return {'durationSec': round(dur, 3), 'fps': round(fps, 3)}
    except ImportError:
        import cv2

        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        cap.release()
        dur = frames / fps if fps else 0.0
        return {'durationSec': round(dur, 3), 'fps': round(fps, 3)}
