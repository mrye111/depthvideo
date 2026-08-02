# 票 #18：其他深度模型调研（能否优化生成效果）

> 调研对象：Hugging Face `onnx-community` 组织全部 depth 相关仓（经 hf-mirror API，本机网络无法直连 HF）、ModelScope 同名镜像、各模型官方 GitHub 仓、transformers.js 4.2.0 本地源码。
> 方法：HF/ModelScope API 枚举 + config/ONNX 文件头核验 + GitHub 仓许可证/发布核实 + transformers.js 源码契约分析。
> 调研日期：2026-08-02。

## 结论速览

**可以加，首选 `depth-anything-v2-large-ONNX` 的 q4f16 档位作为「高质量」选项**：与现架构完全同族（`depth_anything` 类、同一 pipeline、自带 preprocessor_config、I/O 契约一致），接入风险最低；230MB 一次性下载后走 Cache API，ModelScope 已同步全部量化档位；代价是 CC-BY-NC（按 #7 先例加警示）+ 单帧推理显著变慢（参数量 0.3B 级）。

| 候选 | ONNX 可得性 | ModelScope | 许可证 | 体积（最小可用档） | 对本工具的效果 | 结论 |
|---|---|---|---|---|---|---|
| **DA V2 Large** | ✅ onnx-community 官方 | ✅ 全档位 | CC-BY-NC-4.0 | q4f16 230MB / q4 307MB / fp16 640MB | 相对深度质量明确优于 small（同族更大模型），零接入风险 | **推荐加入（高质量档）** |
| DA V3 Small | ✅ onnx-community 官方 | ✅ | Apache-2.0 | fp32 100MB | 论文摘要自述细节/泛化**与 DA2 持平**；单目场景非质变；且 fp32 比 fp16 慢、缺 preprocessor_config（需移植） | 可留作观察，非首选 |
| DA V3 Base | ✅ | ✅ | Apache-2.0 | fp32 393MB | 同上 | 观察 |
| DA V3 Large | ✅ | ✅ | ⚠️ 标签 apache 但上游 DA3-LARGE 实为 **CC-BY-NC-4.0**（见 Gaps） | fp32 1.3GB | 体积超限 | 不加 |
| DA3MONO-LARGE | ❌ 无 ONNX（任何来源） | — | Apache-2.0 | — | 官方定位「单目几何精度优于 DA2 系」，是最对口的方向 | 跟踪，等 ONNX |
| Apple Depth Pro | ✅ onnx-community 官方 | ✅ | apple-ascl（宽松） | q4 712MB / fp16 1.8GB | 锐度顶级但多尺度裁剪推理极慢（V100 级 GPU 约 0.3s/帧），视频逐帧不现实 | 不加 |
| Metric3D（v1 small/large/giant2） | ✅ onnx-community 官方 | ✅ | ⚠️ 仓标 cc0-1.0（上游实为自定义研究许可，见 Gaps） | fp16 72MB 起 | 度量深度（绝对尺度），本工具只看相对深度，增益不对口 | 不加 |
| Sapiens-depth 0.3b/0.6b | ✅ onnx-community 官方 | ✅ | ⚠️ 无标；上游 Meta Sapiens 为自定义非商用许可 | fp16 610MB 起 | 人体任务预训练，通用场景深度不对口 | 不加 |
| CHMv2（DINOv3 ViT-L + DPT head） | ✅ onnx-community 官方 | ✅ | ⚠️ 上游 facebookresearch/dinov3 为自定义许可（NOASSERTION，需复核） | q4 291MB | ViT-L 级笨重，定位不优于 DA 系 | 不加 |
| Distill Any Depth | ⚠️ 仅第三方社区 ONNX（FuryTMP/yuvraj108c 等，无官方） | ❌ 均 404 | MIT（上游） | — | 宣称蒸馏小模型超 Large 教师，但权重渠道不合规且质量未经官方验证 | 不可用（ModelScope 约束） |
| Video-Depth-Anything | ⚠️ 仅第三方固定分辨率 ONNX（512×288） | ❌ 404 | Apache-2.0（上游） | — | 时序一致性最对口，但多帧滑窗模型，塞不进单帧 pipeline，需自研 ORT 管线 | 中期方向，见专节 |
| DepthCrafter / Marigold | ❌ | — | — | — | 扩散模型，浏览器实时无望 | 一句话排除 |
| ZoeDepth / MiDaS / GLPN / DPT 老模型 | 部分（transformers.js 有类） | — | — | — | 精度全面不如 DA V2 | 一句话排除 |

## 推荐方案：V2-Large q4f16 作为第三档「高质量」模型

- **仓**：[onnx-community/depth-anything-v2-large-ONNX](https://huggingface.co/onnx-community/depth-anything-v2-large-ONNX)（ModelScope 同名已同步全部 5 个量化档位，含 `model_q4f16.onnx_data` 230MB）。
- **许可证**：CC-BY-NC-4.0（HF tag 确认），按 #7 先例在选项旁加非商用警示（UI 已有 base 的警示机制，可复用）。
- **接入改动量**：
  1. `MODEL_OPTIONS` 增加一项 large（dtype 建议 `q4f16`，体积/速度平衡；代码中 dtype 联合类型目前只有 `'fp16' | 'fp32'`，需扩 `'q4f16' | 'q4'`）。
  2. NC 警示联动逻辑对 large 同样生效（现逻辑按 model key 判断，加 key 即可）。
  3. 缓存管理（`probeAllCached`）无需改动，Cache API 按 URL 自然生效；但 230MB 会显著占用配额，`清理缓存` 按钮已覆盖。
- **预期**：单帧推理时间明显上升（0.3B 级参数 vs small 的 0.025B），WebGPU 中端显卡估计 3–8×；导出同样时长视频的总耗时同步放大。质量提升方向：边缘细节、薄结构、远距离层次（同族大模型的一般性增益，无需另引基准）。
- **dtype 档位说明**：`q4f16`（4bit 权重 + fp16 激活）是 WebGPU 上的甜点；`q4`（4bit+fp32 激活）更慢；`fp16` 640MB 对浏览器下载偏重但质量最保真，可作为可选。

## 备选观察：Depth Anything V3（Small/Base）

- [ByteDance-Seed/Depth-Anything-3](https://github.com/ByteDance-Seed/Depth-Anything-3)（2025-11 发布，arXiv 2511.10647）：DINOv2/ViT-S/B + DualDPT depth-ray 头。DA3-SMALL 许可证 Apache-2.0（官方 README 模型表）；onnx-community 已出 [v3-small](https://huggingface.co/onnx-community/depth-anything-v3-small)（100MB fp32）/ [v3-base](https://huggingface.co/onnx-community/depth-anything-v3-base)（393MB fp32）/ v3-large（1.3GB），ModelScope 均已同步。
- **关键预期管理**：论文摘要原文「achieves a level of detail and generalization **on par with** Depth Anything 2」——单目深度细节与 DA2 同级，DA3 的 SOTA 主要在多视图几何/位姿任务。对本工具（单帧相对深度）不是质变；官方单目专用 DA3MONO-LARGE 反而没有 ONNX。
- **接入风险（已源码级核实）**：
  - ✅ ONNX 输入名 `pixel_values`、输出名 `predicted_depth`（下载 v3-small model.onnx 提取字符串确认），与 `DepthEstimationPipeline._call` 契约一致；`model_type: "depth_anything"`，4.2.0 已注册该类。
  - ❌ 仓内**没有 preprocessor_config.json**：`pipelines.js` 以 `expected_files.includes('preprocessor_config.json')` 决定是否加载 processor（`utils/model_registry/get_processor_files.js` 仅在该文件存在时返回之），缺失则 `pipe.processor = null`，调用即 TypeError。
  - 绕过方案（代码改动 ~3 行）：`pipe.processor = await AutoProcessor.from_pretrained('onnx-community/depth-anything-v2-small-ONNX')`（V2 的 DPTImageProcessor：518、ImageNet 归一化、14 对齐，与 DA3 预处理一致）。
  - ⚠️ 仅 fp32 档：WebGPU fp32 推理比 fp16 慢（估计 1.5–2×），下载体积也翻倍于 V2-small fp16（100MB vs 48MB）。
- 结论：技术验证价值大于实用价值。若要做，建议作为「实验档」跟在 V2-Large 之后，先跑通 processor 移植再评估画质。

## 时序一致性专节

当前帧间闪烁靠 IIR 平滑（k≤0.85）缓解，属后处理。模型侧的两条路：

1. **Video-Depth-Anything**（[CVPR 2025 Highlight，Apache-2.0](https://github.com/DepthAnything/Video-Depth-Anything)，ViT-S 28.4M）：原理上最对口（任意长视频、一致性好）。但 ① 官方只有 .pth；② 仅有第三方固定 512×288 分辨率 ONNX（FuryTMP，HF-only，ModelScope 404）；③ 多帧滑窗架构（重叠关键帧融合），塞不进单帧 depth-estimation pipeline，需自研 onnxruntime-web 滑窗管线 + 自托管权重。工作量远超「换个 model id」。
2. **DA3-Streaming**（DA3 仓内子项目，滑窗流式）：同样多帧架构，且无 ONNX，跟踪即可。

近期现实路径仍是 IIR 平滑；中期若需求方把「时序一致性」提为正式目标，再开独立票评估自研 VDA 管线（权重自托管需同时决策）。

## 逐项核实记录（一手来源）

- onnx-community depth 仓清单（12 个）：HF API `author=onnx-community&search=depth`（经 hf-mirror）。
- ModelScope 可用性：`GET /api/v1/models/{ns}/{name}` 返回 200 —— v3-small/base/large、v2-large(-ONNX)、DepthPro-ONNX、sapiens-depth-0.3b/0.6b、metric3d-vit-small、dinov3-vitl16-chmv2-dpt-head-ONNX 全部在；FuryTMP/yuvraj108c 的 Distill/VDA ONNX 均返回 10010205001（不存在）。
- V2-Large 档位体积：HF API blobs（q4f16 230MB / q4 307MB / quantized 455MB / fp16 640MB / fp32 1.27GB），ModelScope 文件列表一致。
- 许可证：V2 small=apache-2.0、base/large=cc-by-nc-4.0（HF tag）；DA3-SMALL/BASE=apache-2.0、DA3-LARGE/GIANT=CC BY-NC 4.0（官方 README 模型表）；DepthPro=apple-ascl（HF tag）；VDA=Apache-2.0（GitHub API）；Distill-Any-Depth=MIT（GitHub API）。
- DepthPro 用法与输出：onnx-community/DepthPro-ONNX README（AutoModelForDepthEstimation + 自带 preprocessor_config，输出含 focallength_px）。
- transformers.js 4.2.0 深度模型类（node_modules 实查）：chmv2、depth_anything、depth_pro、dpt、glpn、metric3d、metric3dv2、sapiens；无 depth_anything_v3 专用类（DA3 复用 depth_anything 类）。
- pipeline 三契约（node_modules 实查）：`pipelines.js` 按 model_type 匹配模型类；`depth-estimation.js _call` 走 `processor → model(inputs) → predicted_depth`；`get_processor_files.js` 仅在 preprocessor_config.json 存在时加载 processor。

## Gaps（未一手核实，需人工复核）

- DA3 论文单目深度具体数值表（AbsRel/δ1）：仅取到摘要「on par with DA2」与 README「significantly outperforms DA2 for monocular depth」两处表述，倾向以前者为准，数值未摘录。
- onnx-community/depth-anything-v3-large 的 HF tag 标 apache-2.0，与上游 DA3-LARGE 的 CC BY-NC 4.0 矛盾；许可证应以上游为准。
- metric3d-vit-* 的 cc0-1.0 标签与上游自定义研究许可的关系未核实。
- DINOv3 / CHMv2 权重的确切许可条款（GitHub NOASSERTION）。
- DA3-SMALL ONNX 实跑验证（processor 移植后输出是否正常）未做——属实现票范畴。
