/**
 * 转场时间轴：逐帧概率曲线 + 阈值线 + 切点刻度 + 镜头分段着色。
 * 交互：点击分段选中并定位预览视频；播放头跟随/拖动 scrub（pointer 事件）。
 */
export type TimelineShot = { index: number; startFrame: number; endFrame: number; startSec: number; endSec: number };
export type TimelineBound = { frame: number; prob: number };

const ACCENT = '#7c6cf0';
const TH = 0.5;

export class Timeline {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private probs: Float32Array | null = null;
  private bounds: TimelineBound[] = [];
  private shots: TimelineShot[] = [];
  private fps = 25;
  private currentSec = 0;
  private selected = -1;
  private scrubbing = false;
  private dragged = false;
  private onSeek: (sec: number) => void = () => {};
  private onSelect: (index: number) => void = () => {};
  private lastSeekEmit = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'crosshair';
  }

  setHandlers(h: { onSeek?: (sec: number) => void; onSelect?: (index: number) => void }): void {
    if (h.onSeek) this.onSeek = h.onSeek;
    if (h.onSelect) this.onSelect = h.onSelect;
  }

  setData(probs: Float32Array | null, bounds: TimelineBound[], shots: TimelineShot[], fps: number): void {
    this.probs = probs;
    this.bounds = bounds;
    this.shots = shots;
    this.fps = fps;
    this.selected = -1;
    this.currentSec = 0;
    this.render();
  }

  setCurrentTime(sec: number): void {
    if (this.scrubbing) return;
    this.currentSec = sec;
    this.render();
  }

  setSelected(index: number): void {
    this.selected = index;
    this.render();
  }

  private get nFrames(): number {
    if (this.probs) return this.probs.length;
    const last = this.shots[this.shots.length - 1];
    return last ? last.endFrame + 1 : 1;
  }

  private xToSec(clientX: number): number {
    const r = this.canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return ratio * (this.nFrames / this.fps);
  }

  private secToX(sec: number, w: number): number {
    return (sec * this.fps * w) / this.nFrames;
  }

  private pointerDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    this.scrubbing = true;
    this.dragged = false;
    this.scrubTo(e, true);
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.scrubbing) return;
    this.dragged = true;
    this.scrubTo(e, false);
  }

  private pointerUp(e: PointerEvent): void {
    const wasDrag = this.dragged;
    this.scrubbing = false;
    this.dragged = false;
    if (!wasDrag) {
      // 纯点击：选中所在分段并定位到段首
      const sec = this.xToSec(e.clientX);
      const idx = this.shots.findIndex((s) => sec >= s.startSec && sec < s.endSec);
      if (idx >= 0) {
        this.selected = idx;
        this.onSelect(idx);
        this.onSeek(this.shots[idx].startSec + 0.001);
      }
      this.render();
    }
  }

  private scrubTo(e: PointerEvent, immediate: boolean): void {
    const sec = this.xToSec(e.clientX);
    this.currentSec = sec;
    const now = performance.now();
    if (immediate || now - this.lastSeekEmit > 40) {
      this.lastSeekEmit = now;
      this.onSeek(sec);
    }
    this.render();
  }

  render(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 880;
    const cssH = 88;
    if (this.canvas.width !== Math.round(cssW * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.canvas.style.height = `${cssH}px`;
    }
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 分段底色（交替 + 选中高亮）
    const styles = getComputedStyle(this.canvas);
    const bandA = 'rgba(124,108,240,0.06)';
    const bandB = 'rgba(124,108,240,0.13)';
    const bandSel = 'rgba(124,108,240,0.28)';
    for (let i = 0; i < this.shots.length; i++) {
      const s = this.shots[i];
      const x0 = this.secToX(s.startSec, w);
      const x1 = this.secToX(s.endSec, w);
      ctx.fillStyle = i === this.selected ? bandSel : i % 2 === 0 ? bandA : bandB;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }

    // 概率曲线
    if (this.probs && this.probs.length > 1) {
      const n = this.probs.length;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = h - this.probs[i] * (h * 0.82) - h * 0.06;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = styles.color || ACCENT;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 阈值线
    const thY = h - TH * (h * 0.82) - h * 0.06;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = 'rgba(128,128,128,0.7)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(0, thY);
    ctx.lineTo(w, thY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 切点刻度
    ctx.fillStyle = ACCENT;
    for (const b of this.bounds) {
      const x = this.secToX(b.frame / this.fps, w);
      ctx.fillRect(x - dpr, thY - 7 * dpr, 2 * dpr, 14 * dpr);
    }

    // 播放头
    const px = this.secToX(this.currentSec, w);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, 6 * dpr, 4 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
  }
}
