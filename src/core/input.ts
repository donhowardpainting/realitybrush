/** Keyboard + mouse state. Tests drive the same state through `press`/`release`. */
export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /** When true the game accepts input without pointer lock (automated tests). */
  virtual = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      this.press(e.code);
    });
    window.addEventListener('keyup', (e) => this.release(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => { if (this.locked) this.press('Mouse' + e.button); });
    window.addEventListener('mouseup', (e) => this.release('Mouse' + e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // guard against the occasional huge spurious delta browsers emit
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.keys.clear();
      this.onLockChange?.(this.locked);
    });
  }

  onLockChange?: (locked: boolean) => void;

  lock() {
    if (this.virtual) { this.locked = true; this.onLockChange?.(true); return; }
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
  }
  unlock() {
    if (this.virtual) { this.locked = false; this.keys.clear(); this.onLockChange?.(false); return; }
    document.exitPointerLock();
  }

  press(code: string) { this.keys.add(code); this.pressed.add(code); }
  release(code: string) { this.keys.delete(code); }
  down(code: string) { return this.keys.has(code); }
  hit(code: string) { return this.pressed.has(code); }
  endFrame() { this.pressed.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; }
}
