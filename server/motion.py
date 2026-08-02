"""运镜分析模型：Qwen2.5-VL-7B cam-motion（CameraBench 全量微调），4bit 装载。

协议均摘自模型卡（票 #25 报告 §2）：
- 抽帧 fps=8.0（模型按 8fps 训练）
- 打分：prompt `Does this video show "{描述}"?` → greedy 1 token → Yes 概率
- 描述：`Describe the camera motion in this video.` → 自由生成

装载：bitsandbytes nf4 + sdpa（Blackwell sm_120 避开 flash-attn wheel 坑）。
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL_PATH = Path(os.environ.get('MOTION_MODEL_PATH') or (ROOT / 'weights' / 'qwen25-vl-7b-cam-motion'))

# v1 8 维标签（test.jsonl 高频维度；每维候选描述用于二分类打分）
LABEL_DIMS: dict[str, list[tuple[str, str]]] = {
    'dolly': [
        ('dolly-in', 'the camera moving forward'),
        ('dolly-out', 'the camera moving backward'),
    ],
    'pan': [
        ('pan-left', 'the camera panning to the left'),
        ('pan-right', 'the camera panning to the right'),
    ],
    'pedestal': [
        ('pedestal-up', 'the camera moving up'),
        ('pedestal-down', 'the camera moving down'),
    ],
    'arc': [
        ('arc-CW', 'the camera arcing clockwise around the subject'),
        ('arc-CCW', 'the camera arcing counterclockwise around the subject'),
    ],
    'zoom': [
        ('zoom-in', 'the camera zooming in'),
        ('zoom-out', 'the camera zooming out'),
    ],
    'static': [('static', 'the camera being completely static')],
    'shaking': [
        ('no-shaking', 'no camera shaking at all'),
        ('minimal-shaking', 'minimal camera shaking'),
        ('unsteady', 'unsteady camera movement'),
        ('very-unsteady', 'very unsteady camera movement'),
    ],
    'speed': [
        ('slow-speed', 'slow camera movement'),
        ('regular-speed', 'regular speed camera movement'),
        ('fast-speed', 'fast camera movement'),
    ],
}

DESCRIBE_PROMPT = 'Describe the camera motion in this video.'

_model = None
_processor = None
_lock = threading.Lock()
_load_error: str | None = None


def is_loaded() -> bool:
    return _model is not None


def load_error() -> str | None:
    return _load_error


def _build():
    import torch
    from transformers import AutoProcessor, BitsAndBytesConfig, Qwen2_5_VLForConditionalGeneration

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type='nf4',
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        str(MODEL_PATH),
        quantization_config=bnb,
        device_map='auto',
        attn_implementation='sdpa',
    )
    processor = AutoProcessor.from_pretrained(str(MODEL_PATH))
    return model, processor


def ensure_loaded(blocking: bool = False) -> bool:
    """后台装载一次；blocking=True 时同步等待。返回当前是否已装载。"""
    global _model, _processor, _load_error
    if _model is not None:
        return True

    def work():
        global _model, _processor, _load_error
        import time

        # 后台模式重试 10 次（权重可能仍在下载）；blocking（analyze 触发）只试一次
        attempts = 10 if not blocking else 1
        for attempt in range(attempts):
            with _lock:
                if _model is not None:
                    return
                try:
                    print(f'[motion] 开始装载模型（4bit nf4 + sdpa，第 {attempt + 1} 次）...', flush=True)
                    m, p = _build()
                    _processor = p
                    _model = m
                    _load_error = None
                    print('[motion] 模型装载完成', flush=True)
                    return
                except Exception as e:  # noqa: BLE001
                    _load_error = f'{type(e).__name__}: {e}'
                    print(f'[motion] 装载失败: {_load_error}', flush=True)
            time.sleep(60)  # 权重可能仍在下载，周期性重试

    if blocking:
        work()
    else:
        threading.Thread(target=work, daemon=True).start()
    return _model is not None


def _messages(frames, question: str):
    return [
        {
            'role': 'user',
            'content': [
                {'type': 'video', 'video': frames, 'sample_fps': 8.0},
                {'type': 'text', 'text': question},
            ],
        }
    ]


def _to_pil(frames):
    """numpy RGB 帧 → PIL（qwen_vl_utils 的 video 列表元素必须是 PIL/路径/URL）"""
    from PIL import Image

    return [f if hasattr(f, 'convert') else Image.fromarray(f) for f in frames]


def _generate_inputs(frames, question: str):
    from qwen_vl_utils import process_vision_info

    messages = _messages(_to_pil(frames), question)
    text = _processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    images, videos, video_kwargs = process_vision_info(messages, return_video_kwargs=True)
    # transformers v5：processor 的 fps 只收标量；process_vision_info 返回每视频一个元素的列表
    kwargs = dict(video_kwargs)
    if isinstance(kwargs.get('fps'), (list, tuple)) and len(kwargs['fps']) == 1:
        kwargs['fps'] = kwargs['fps'][0]
    inputs = _processor(
        text=[text], images=images, videos=videos, padding=True, return_tensors='pt', **kwargs
    )
    return inputs.to(_model.device)


def score_yes(frames, description: str) -> float:
    """P(Yes) for `Does this video show "{description}"?`（模型卡打分协议原文）。"""
    import torch

    question = f'Does this video show "{description}"?'
    inputs = _generate_inputs(frames, question)
    with torch.inference_mode():
        outputs = _model.generate(
            **inputs,
            max_new_tokens=1,
            do_sample=False,
            output_scores=True,
            return_dict_in_generate=True,
        )
    probs = torch.softmax(outputs.scores[0].float(), dim=-1)
    yes_id = _processor.tokenizer.encode('Yes')[0]
    return float(probs[0, yes_id].item())


def describe(frames) -> str:
    inputs = _generate_inputs(frames, DESCRIBE_PROMPT)
    import torch

    with torch.inference_mode():
        out = _model.generate(**inputs, max_new_tokens=128)
    trimmed = out[0][inputs['input_ids'].shape[1]:]
    return _processor.batch_decode([trimmed], skip_special_tokens=True)[0].strip()


def analyze(frames) -> dict:
    """逐维候选打分取 argmax + 一句话描述。"""
    if not ensure_loaded(blocking=True):
        raise RuntimeError(f'模型未装载：{_load_error or "装载中/失败"}')
    labels: dict[str, dict] = {}
    for dim, candidates in LABEL_DIMS.items():
        best_label, best_prob = None, -1.0
        for tag, desc in candidates:
            p = score_yes(frames, desc)
            if p > best_prob:
                best_label, best_prob = tag, p
        labels[dim] = {'label': best_label, 'prob': round(best_prob, 4)}
    return {'labels': labels, 'description': describe(frames)}
