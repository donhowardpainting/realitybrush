import type { Game } from '../game';

interface Track { kind: 'stick' | 'look' | 'btn'; code?: string; x: number; y: number; ox: number; oy: number; el?: HTMLElement }

const STICK_R = 58;
/** Screen pixels of thumb travel -> mouse-pixel equivalents. */
const LOOK_GAIN = 2.6;

/**
 * On-screen controls: a floating left thumb-stick, drag-to-look anywhere on the right, and a
 * small cluster of buttons. Dragging a thumb that is holding SPRAY keeps aiming, so painting a
 * long stroke is one continuous gesture.
 */
export class TouchControls {
  private root: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private tracks = new Map<number, Track>();

  constructor(private game: Game) {
    this.root = document.getElementById('touch')!;
    this.root.innerHTML = `
      <div class="t-stick"><i></i></div>
      <button class="t-btn t-fire" data-code="Mouse0"><span>SPRAY</span></button>
      <button class="t-btn t-jump" data-code="Space"><span>JUMP</span></button>
      <button class="t-btn t-pulse" data-code="Mouse2"><span>PULSE</span></button>
      <button class="t-btn t-bomb" data-code="KeyE"><span>BOMB</span></button>
      <button class="t-btn t-pause" data-code="Escape"><span>II</span></button>`;
    this.stick = this.root.querySelector('.t-stick')!;
    this.knob = this.stick.querySelector('i')!;
    const opts = { passive: false } as AddEventListenerOptions;
    this.root.addEventListener('touchstart', (e) => this.start(e), opts);
    this.root.addEventListener('touchmove', (e) => this.move(e), opts);
    this.root.addEventListener('touchend', (e) => this.end(e), opts);
    this.root.addEventListener('touchcancel', (e) => this.end(e), opts);
  }

  show(on: boolean) {
    this.root.classList.toggle('hidden', !on);
    if (!on) this.reset();
  }

  private reset() {
    const inp = this.game.input;
    for (const t of this.tracks.values()) if (t.code) { inp.release(t.code); t.el?.classList.remove('on'); }
    this.tracks.clear();
    inp.touchX = inp.touchY = 0; inp.touchSprint = false;
    this.stick.classList.remove('on');
  }

  private start(e: TouchEvent) {
    e.preventDefault();
    const inp = this.game.input;
    inp.noteTouch();
    for (const t of Array.from(e.changedTouches)) {
      const btn = (t.target as HTMLElement).closest?.('.t-btn') as HTMLElement | null;
      if (btn) {
        const code = btn.dataset.code!;
        inp.press(code);
        btn.classList.add('on');
        this.tracks.set(t.identifier, { kind: 'btn', code, x: t.clientX, y: t.clientY, ox: t.clientX, oy: t.clientY, el: btn });
        if (code === 'Mouse0') inp.rumble(0, 0, 20);
      } else if (t.clientX < window.innerWidth * 0.42 && ![...this.tracks.values()].some((k) => k.kind === 'stick')) {
        this.tracks.set(t.identifier, { kind: 'stick', x: t.clientX, y: t.clientY, ox: t.clientX, oy: t.clientY });
        this.stick.style.left = t.clientX + 'px'; this.stick.style.top = t.clientY + 'px';
        this.knob.style.transform = 'translate(-50%, -50%)';
        this.stick.classList.add('on');
      } else {
        this.tracks.set(t.identifier, { kind: 'look', x: t.clientX, y: t.clientY, ox: t.clientX, oy: t.clientY });
      }
    }
  }

  private move(e: TouchEvent) {
    e.preventDefault();
    const inp = this.game.input;
    for (const t of Array.from(e.changedTouches)) {
      const k = this.tracks.get(t.identifier);
      if (!k) continue;
      const dx = t.clientX - k.x, dy = t.clientY - k.y;
      k.x = t.clientX; k.y = t.clientY;
      if (k.kind === 'stick') {
        let sx = k.x - k.ox, sy = k.y - k.oy;
        const l = Math.hypot(sx, sy);
        if (l > STICK_R) { sx *= STICK_R / l; sy *= STICK_R / l; }
        const m = Math.min(1, l / STICK_R);
        // small dead zone, then a gentle curve so slow walking is easy
        const g = m < 0.12 ? 0 : (m - 0.12) / 0.88;
        const rawX = k.x - k.ox, rawY = k.y - k.oy;
        inp.touchX = l > 0 ? (rawX / l) * g : 0;
        inp.touchY = l > 0 ? (-rawY / l) * g : 0;
        inp.touchSprint = l > STICK_R * 1.55;
        this.knob.style.transform = `translate(calc(-50% + ${sx}px), calc(-50% + ${sy}px))`;
      } else if (k.kind === 'look' || k.code === 'Mouse0') {
        inp.mouseDX += dx * LOOK_GAIN;
        inp.mouseDY += dy * LOOK_GAIN;
      }
    }
  }

  private end(e: TouchEvent) {
    e.preventDefault();
    const inp = this.game.input;
    for (const t of Array.from(e.changedTouches)) {
      const k = this.tracks.get(t.identifier);
      if (!k) continue;
      this.tracks.delete(t.identifier);
      if (k.kind === 'stick') { inp.touchX = inp.touchY = 0; inp.touchSprint = false; this.stick.classList.remove('on'); }
      else if (k.code) { inp.release(k.code); k.el?.classList.remove('on'); }
    }
  }
}
