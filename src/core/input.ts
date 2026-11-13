export type Device = 'kbm' | 'touch' | 'pad';

/** Standard-mapping gamepad buttons -> the same codes the keyboard/mouse path uses. */
const PAD_MAP: Record<number, string> = {
  0: 'Space',     // A / Cross      jump
  1: 'KeyQ',      // B / Circle     solvent
  2: 'KeyE',      // X / Square     paint bomb
  6: 'Mouse2',    // LT             kinetic pulse
  7: 'Mouse0',    // RT             spray
  9: 'Escape',    // Start          pause
  10: 'ShiftLeft', // L3            sprint
  11: 'KeyF',     // R3             kinetic pulse
};
const DEAD = 0.16;
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

/**
 * One input surface for keyboard + mouse, gamepads and touch. Every device ends up as the same
 * button codes plus analog move/look values, so gameplay code never asks which device is in use.
 */
export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  /** Look delta for this frame in mouse-pixel equivalents. */
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  /** True while gameplay should accept input. */
  locked = false;
  /** Automated tests: no pointer lock needed. */
  virtual = false;
  /** Touch-first device. */
  touch: boolean;
  device: Device = 'kbm';
  /** Analog movement from stick / touch joystick (x = right, y = forward). */
  stickX = 0;
  stickY = 0;
  touchX = 0;
  touchY = 0;
  touchSprint = false;
  private hard = false;
  private padPrev: boolean[] = [];
  private padSprint = false;
  private menuRepeat = 0;
  /** Menu navigation events produced by the gamepad this frame. */
  menu = { up: false, down: false, accept: false, back: false };
  onLockChange?: (locked: boolean) => void;
  onDevice?: (d: Device) => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.touch = (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) && window.matchMedia('(pointer: coarse)').matches;
    if (this.touch) this.device = 'touch';
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      this.setDevice('kbm');
      this.press(e.code);
    });
    window.addEventListener('keyup', (e) => this.release(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      if ((e as any).sourceCapabilities?.firesTouchEvents) return;
      if (this.locked) { this.setDevice('kbm'); this.press('Mouse' + e.button); }
    });
    window.addEventListener('mouseup', (e) => this.release('Mouse' + e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.hard) return;
      // guard against the occasional huge spurious delta browsers emit
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      const now = document.pointerLockElement === canvas;
      if (now) { this.hard = true; if (!this.locked) { this.locked = true; this.onLockChange?.(true); } }
      else if (this.hard) { this.hard = false; this.locked = false; this.keys.clear(); this.onLockChange?.(false); }
    });
  }

  private setDevice(d: Device) {
    if (d === this.device) return;
    this.device = d;
    this.onDevice?.(d);
  }
  noteTouch() { this.setDevice('touch'); }

  /** Whether the mouse is captured (as opposed to a touch/gamepad session without capture). */
  get captured() { return this.hard; }

  /**
   * Begin accepting gameplay input. Mouse players get pointer lock; touch and gamepad sessions
   * (and browsers without the API) simply start — nothing to capture.
   */
  lock() {
    const soft = this.virtual || this.touch || this.device === 'pad' || typeof this.canvas.requestPointerLock !== 'function';
    if (!soft) {
      try {
        const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => {});
      } catch { /* fall through to a soft start */ }
    }
    if (soft && !this.locked) { this.locked = true; this.onLockChange?.(true); }
  }

  /** Capture the mouse during a session that started without it (e.g. began on a gamepad). */
  capture() {
    if (this.hard || this.touch || this.virtual || typeof this.canvas.requestPointerLock !== 'function') return;
    try { (this.canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* ignore */ }
  }

  unlock() {
    if (this.hard) { document.exitPointerLock(); return; }
    if (!this.locked) return;
    this.locked = false; this.keys.clear(); this.stickX = this.stickY = this.touchX = this.touchY = 0;
    this.onLockChange?.(false);
  }

  press(code: string) { this.keys.add(code); this.pressed.add(code); }
  release(code: string) { this.keys.delete(code); }
  down(code: string) { return this.keys.has(code); }
  hit(code: string) { return this.pressed.has(code); }

  /** Strafe axis, -1..1. */
  moveX(): number {
    const k = (this.down('KeyD') || this.down('ArrowRight') ? 1 : 0) - (this.down('KeyA') || this.down('ArrowLeft') ? 1 : 0);
    return Math.max(-1, Math.min(1, k + this.stickX + this.touchX));
  }
  /** Forward axis, -1..1. */
  moveZ(): number {
    const k = (this.down('KeyW') || this.down('ArrowUp') ? 1 : 0) - (this.down('KeyS') || this.down('ArrowDown') ? 1 : 0);
    return Math.max(-1, Math.min(1, k + this.stickY + this.touchY));
  }
  sprinting(): boolean {
    return this.down('ShiftLeft') || this.down('ShiftRight') || this.padSprint || this.touchSprint;
  }

  /** Poll gamepads. Call once per frame before gameplay reads input. */
  poll(dt: number, lookSpeed = 1) {
    this.menu.up = this.menu.down = this.menu.accept = this.menu.back = false;
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected && p.buttons.length >= 10) { pad = p; break; }
    if (!pad) { this.stickX = this.stickY = 0; this.padSprint = false; return; }
    const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0), rx = dz(pad.axes[2] ?? 0), ry = dz(pad.axes[3] ?? 0);
    const b = pad.buttons.map((x) => x.pressed || x.value > 0.4);
    const any = b.some(Boolean) || lx || ly || rx || ry;
    if (any) this.setDevice('pad');

    // menus: d-pad / stick to move, A to accept, B / Start to back out
    this.menuRepeat -= dt;
    const upNow = b[12] || ly < -0.6, downNow = b[13] || ly > 0.6;
    if ((upNow || downNow) && this.menuRepeat <= 0) { this.menu.up = upNow; this.menu.down = downNow; this.menuRepeat = 0.22; }
    if (!upNow && !downNow) this.menuRepeat = 0;
    this.menu.accept = b[0] && !this.padPrev[0];
    this.menu.back = (b[1] && !this.padPrev[1]) || (b[9] && !this.padPrev[9]);

    if (this.locked) {
      this.stickX = lx; this.stickY = -ly;
      // response curve: fine aim near the centre, fast turns at the rim
      const curve = (v: number) => Math.sign(v) * (0.35 * Math.abs(v) + 0.65 * v * v);
      const rate = 1250 * lookSpeed * dt;
      this.mouseDX += curve(rx) * rate;
      this.mouseDY += curve(ry) * rate * 0.72;
      for (const [i, code] of Object.entries(PAD_MAP)) {
        const n = +i;
        if (b[n] && !this.padPrev[n]) this.press(code);
        else if (!b[n] && this.padPrev[n]) this.release(code);
      }
      if (b[4] && !this.padPrev[4]) this.wheel -= 1; // LB: previous pigment
      if (b[5] && !this.padPrev[5]) this.wheel += 1; // RB: next pigment
      // L3 toggles sprint until the stick is released
      if (b[10] && !this.padPrev[10]) this.padSprint = true;
      if (Math.hypot(lx, ly) < 0.3) this.padSprint = false;
    } else { this.stickX = this.stickY = 0; }
    this.padPrev = b;
  }

  /** Controller vibration, where supported. */
  rumble(strong: number, weak: number, ms: number) {
    if (this.device === 'pad') {
      const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
      for (const p of pads) {
        const act = (p as any)?.vibrationActuator;
        if (act?.playEffect) act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch?.(() => {});
      }
    } else if (this.device === 'touch' && ms >= 20) {
      try { navigator.vibrate?.(Math.min(40, ms)); } catch { /* unsupported */ }
    }
  }

  endFrame() { this.pressed.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; }
}
