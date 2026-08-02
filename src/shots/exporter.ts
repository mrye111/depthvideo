/**
 * 分析结果 JSON 导出：结构见 spec #26（video / boundaries / shots / meta）。
 * 运镜标注（motion）由后续票在分析服务接入后补充。
 */
export type ExportShot = {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  boundaryProbBefore: number | null;
};

export type ExportData = {
  video: { name: string; durationSec: number; fps: number; width: number; height: number };
  boundaries: { frame: number; timeSec: number; prob: number }[];
  shots: ExportShot[];
  meta: { transnetModel: string; generatedAt: string };
};

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function buildExport(
  file: File,
  video: { durationSec: number; fps: number; width: number; height: number },
  bounds: { frame: number; prob: number }[],
  shots: ExportShot[],
): ExportData {
  return {
    video: {
      name: file.name,
      durationSec: round3(video.durationSec),
      fps: video.fps,
      width: video.width,
      height: video.height,
    },
    boundaries: bounds.map((b) => ({ frame: b.frame, timeSec: round3(b.frame / video.fps), prob: round3(b.prob) })),
    shots: shots.map((s) => ({
      index: s.index,
      startSec: round3(s.startSec),
      endSec: round3(s.endSec),
      durationSec: round3(s.durationSec),
      boundaryProbBefore: s.boundaryProbBefore === null ? null : round3(s.boundaryProbBefore),
    })),
    meta: {
      transnetModel: 'transnetv2-webgpu.onnx (TransNet V2, MIT; browser-patched)',
      generatedAt: new Date().toISOString(),
    },
  };
}

export function downloadJson(data: ExportData, baseName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}-shots.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
