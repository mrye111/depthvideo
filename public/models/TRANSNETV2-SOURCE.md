# TransNet V2（浏览器补丁版 ONNX）

- 原始模型：TransNet V2 — https://github.com/soCzech/TransNetV2 （MIT License）
- ONNX 转换来源：https://huggingface.co/elya5/transnetv2 （MIT License，base: Sn4kehead/TransNetV2）
- 本文件 `transnetv2-webgpu.onnx` 在上述 ONNX 基础上做了两处等价改写（数值逐值复验一致），以兼容 onnxruntime-web WebGPU 后端：
  1. 48 个 Conv 的 SAME padding 外置为显式 Pad 节点（WebGPU Conv3D 不支持内嵌 padding）；
  2. 3 个 kernel [1,2,2] 的 3D AveragePool 改写为 Reshape(C×D) → 2D pool → Reshape（WebGPU 不支持 >2D 的 NHWC 池化）。
- 手术脚本与验证数据见工单 #24 记录；使用本模型须同时遵守上述两处的 MIT 许可条款（保留版权与许可声明）。

MIT License 原文见 https://github.com/soCzech/TransNetV2/blob/master/LICENSE
