# CameraBench 微调版 Qwen2.5-VL-7B 服务端接入调研

> 调研对象：GitHub `sy77777en/CameraBench`（推理/评测代码，浅克隆实读）、HF 权重仓 `chancharikm/qwen2.5-vl-7b-cam-motion`（API 实查）、HF 数据集 `syCen/CameraBench`（test.jsonl 全文下载统计）。
> 方法：初稿由 research 子代理凭模型知识产出（方向性评估 + Gaps 表），全部 8 个 Gaps 已由主会话联网一手核实回填（HF API 经 hf-mirror、GitHub API、仓源码、数据集 jsonl 统计）。
> 调研日期：2026-08-02。

## 结论速览

| 问题 | 结论（已核实） | 来源 |
|---|---|---|
| 权重形态 | **全量微调**（LLaMA-Factory full），4 片 safetensors 共 **15.46GB**；tokenizer/processor/chat_template 齐全，**无需基座** | HF API blobs |
| 抽帧协议 | **均匀 fps=8.0** 采样（模型卡明示 "trained on 8.0 FPS / Recommended FPS for optimal inference"；模型名含 `_fps8`） | 模型卡代码 |
| 二分类打分 | prompt：`Does this video show "{描述}"?` → greedy 1 token → softmax 取 **Yes token 概率** | 模型卡代码 |
| 自然语言描述 | prompt：`Describe the camera motion in this video.` → max_new_tokens=128 | 模型卡代码 |
| 运镜标签集 | **34 个标签**，四类：运动原语 16（dolly/truck/pedestal/pan/tilt/roll/zoom/arc 各双向）+ 跟拍 7 + 抖动 4 + 速度/运动程度 8（见 §3） | test.jsonl 1071 条统计 |
| v1 建议维度 | 推拉 / 摇 / 升降 / 环绕 / 变焦 / 静态 / 抖动 / 速度（8 维，覆盖高频标签） | §3 频次表 |
| 4bit 装载 | bnb nf4 标准配置，权重 ≈5–6GB，16GB 卡余量充足；**无官方量化版**（仓内仅 bf16 全量） | HF API + 通用经验 |
| Blackwell | torch ≥2.7 + cu128；attention 用 **sdpa**（flash-attn 最新 v2.8.3.post1 wheel 仍无 sm_120 标注，列为可选试切） | flash-attn releases |
| 许可证 | 代码/数据集仓 **CC BY 4.0**（LICENSE 实读）；权重 tag `other`（随项目按 CC BY 4.0 对待，**需署名**）；基座 Apache-2.0 | GitHub LICENSE |
| 备选变体 | 同作者另有 **32B / 72B** cam-motion 权重（16GB 卡装不下，仅记录） | CameraBench README |

## 1. 权重形态与下载（已核实）

- `chancharikm/qwen2.5-vl-7b-cam-motion`：LLaMA-Factory **全量微调**（tags: `llama-factory`, `full`；`base_model: Qwen/Qwen2.5-VL-7B-Instruct`）。
- 文件（共 15.46GB）：`model-0000{1..4}-of-00004.safetensors`（4.63/4.65/4.59/1.58GB）+ `model.safetensors.index.json`；`config.json` / `preprocessor_config.json` / `tokenizer.json` / `tokenizer_config.json` / `chat_template.json` / `generation_config.json` 齐全；另附 `all_results.json` / `eval_results.json`（训练评测结果）与 loss 曲线图。
- **基座无需单独下载**；模型卡 demo 里 processor 从基座加载（`AutoProcessor.from_pretrained("Qwen/Qwen2.5-VL-7B-Instruct")`），仓内也自带，两者皆可。
- 下载：`HF_ENDPOINT=https://hf-mirror.com huggingface-cli download chancharikm/qwen2.5-vl-7b-cam-motion`（**不在 ModelScope**，已实测 404）。
- 训练元信息（模型名）：`bal_imb_cap_full_lr2e-4_epoch10.0_freezevisTrue_fps8`——冻结视觉塔、fps=8 训练。

## 2. 推理协议（模型卡原文核实）

**抽帧**：video message 带 `"fps": 8.0`，均匀重采样；配 `process_vision_info(..., return_video_kwargs=True)` 传入 processor。

**用法一：二分类打分（运镜标签主路径）**
```python
question = f"Does this video show \"{text_description}\"?"
# messages: video(fps=8.0) + text(question)
outputs = model.generate(**inputs, max_new_tokens=1, do_sample=False,
                         output_scores=True, return_dict_in_generate=True)
probs = torch.softmax(outputs.scores[0], dim=-1)
score = probs[0, processor.tokenizer.encode("Yes")[0]].item()  # P(Yes)
```
逐标签各问一次即得该标签置信度（v1 取 8 维 → 每镜头 8 次短生成，吞吐可接受；可用 `t2v_metrics.VQAScore(model='qwen2.5-vl-7b', checkpoint=...)` 封装，官方推荐路径，但其包需从 GitHub fork 安装）。

**用法二：自然语言描述**
```python
{"type": "text", "text": "Describe the camera motion in this video."}
model.generate(**inputs, max_new_tokens=128)
```

**装载（Blackwell 安全组合）**：
```python
Qwen2_5_VLForConditionalGeneration.from_pretrained(
    path, quantization_config=BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True),
    attn_implementation="sdpa", device_map="auto")
```
显存预算（16GB）：权重 4bit ≈5–6GB + 视觉塔 ≈1GB + KV/帧激活（fps=8 短视频段）≈2–4GB，合计 ~9–12GB，余量充足。

## 3. 运镜标签体系（test.jsonl 1071 条实统计）

schema：`{"Video": url, "labels": [...], "caption": "...", "path": ...}`。完整标签表（按频次）：

| 类别 | 标签（频次） |
|---|---|
| 运动程度 | regular-speed 940、complex-motion 852、no-motion 187、minor-motion 32 |
| 抖动 | no-shaking 422、minimal-shaking 299、unsteady 197、very-unsteady 56 |
| 推拉 | dolly-in 205、dolly-out 71 |
| 摇 | pan-left 105、pan-right 93 |
| 横移 | truck-right 96、truck-left 67 |
| 升降 | pedestal-down 77、pedestal-up 63 |
| 俯仰 | tilt-up 69、tilt-down 52 |
| 环绕 | arc-CCW 62、arc-CW 60 |
| 变焦 | zoom-in 54、zoom-out 49 |
| 翻滚 | roll-CCW 51、roll-CW 42 |
| 跟拍 | side-tracking 68、pan-tracking 44、aerial-tracking 37、tail-tracking 36、lead-tracking 26、tilt-tracking 14、arc-tracking 12 |
| 静态/速度 | static 97、slow-speed 79、fast-speed 52 |

**v1 建议取 8 维**（覆盖高频且对创作最有语义）：dolly（推/拉）、pan（摇）、pedestal（升降）、arc（环绕）、zoom（变焦）、static（静态）、抖动（no/minimal/unsteady/very-unsteady 四态）、速度（slow/regular/fast）。跟拍 7 类与横移/俯仰/翻滚留作 v2 增量。

## 4. 许可证（已核实）

- 代码/数据集仓 `sy77777en/CameraBench`：**CC BY 4.0**（LICENSE 原文实读）——商用可，**须署名**。
- 权重仓 license tag 为 `other`（模型卡未另附条款），按项目统一许可 CC BY 4.0 对待；署名 CameraBench 作者。
- 基座 Qwen2.5-VL-7B-Instruct：**Apache-2.0**。
- 结论：无 NC 障碍；README/关于页需署名 CameraBench + Qwen。

## 5. Blackwell（sm_120）部署组合

- torch **≥2.7 + cu128**（sm_120 首个稳定支持组合），driver ≥ R570；Windows 下 bitsandbytes 支持差，**建议 WSL2/Linux**。
- attention 固定 **sdpa**；flash-attn 截至 v2.8.3.post1（2026-06-10）官方 wheel 按 torch/cu 组合分发、无 sm_120 标注，列可选试切项（不合适则回 sdpa）。
- vLLM 不引入（本 effort 已定）；如后续要吞吐，cu128 构建的 vLLM ≥0.9 再评估。

## Gaps 回填记录与遗留

已回填（初稿 8 项全部）：① 权重形态（全量 15.46GB）② 抽帧协议（fps=8.0）③ prompt 原文与解析（§2）④ 标签清单（§3，34 标签全表）⑤ 官方量化版（无）⑥ 许可证（CC BY 4.0 / other / Apache-2.0）⑦ flash-attn 现状（无 sm_120 标注 wheel）⑧ 基座依赖（仓内自带，无需补齐）。

遗留（不阻塞实现票）：
- `eval_results.json` / `all_results.json`（仓内自带评测分数）未逐项摘录——实现票做基线自测时可对照。
- 32B/72B 变体的 4bit 可行性未评估（16GB 卡本就装不下，纯记录）。
- 长视频策略（>30s 镜头怎么抽：fps=8 下 token 预算与 `max_pixels` 上限）需实现票实测定——初步建议按镜头切段后 fps=8 抽，超长镜头先等间隔降帧。

## 来源

- 权重仓：https://huggingface.co/chancharikm/qwen2.5-vl-7b-cam-motion （文件清单/license tag/模型卡代码）
- 代码仓：https://github.com/sy77777en/CameraBench （LICENSE、README；32B/72B 链接）
- 数据集：https://huggingface.co/datasets/syCen/CameraBench （test.jsonl 1071 条标签统计）
- 基座：https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct （Apache-2.0）
- flash-attn releases：https://github.com/Dao-AILab/flash-attention/releases （v2.8.3.post1 assets）
- 论文：https://arxiv.org/abs/2504.15376
