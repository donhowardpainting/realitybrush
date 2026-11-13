import * as THREE from 'three';
import { Physics } from './core/physics';
import { Input } from './core/input';
import { AudioSys } from './core/audio';
import { Stage, Quality } from './render/stage';
import { Materials } from './render/materials';
import { Particles } from './render/particles';
import { PaintWorld, timeUniform } from './paint/paintable';
import { Paint, PAINTS, PAINT_ORDER } from './paint/types';
import { Gun } from './paint/gun';
import { Player } from './player/player';
import { Dynamics } from './systems/dynamics';
import { Growth } from './systems/growth';
import { PowerSys } from './systems/power';
import { Zones, Checkpoint } from './systems/zones';
import { Hud } from './ui/hud';
import { TouchControls } from './ui/touch';
import { Builder } from './world/builder';
import { buildWorld, LevelDef } from './world/level';

const FIXED = 1 / 60;
const SAVE_KEY = 'reality-brush-save-v1';
const SETTINGS_KEY = 'reality-brush-settings-v1';
const ALL = new Set<Paint>(PAINT_ORDER);

interface Save { cp: string; seen: string[]; unlocked: Paint[]; time: number; splats: number; bounces: number; done: boolean }
export interface Flags { test: boolean; bake: boolean; quality?: Quality }

export class Game {
  stage: Stage;
  physics: Physics;
  input: Input;
  audio = new AudioSys();
  mats: Materials;
  paint: PaintWorld;
  glow: Particles;
  drops: Particles;
  player!: Player;
  gun!: Gun;
  dynamics!: Dynamics;
  growth!: Growth;
  power!: PowerSys;
  zones!: Zones;
  hud!: Hud;
  touchUi!: TouchControls;
  level!: LevelDef;
  builder!: Builder;

  time = 0;
  state: 'loading' | 'menu' | 'playing' | 'paused' | 'ending' = 'loading';
  mode: 'story' | 'sandbox' = 'story';
  seen = new Set<string>();
  private unlockedStory = new Set<Paint>();
  private listeners = new Map<string, ((data?: any) => void)[]>();
  private acc = 0;
  private last = 0;
  private storyStarted = false;
  private storyCp: Checkpoint | null = null;
  private barsT = 0;
  private finaleT = -1;
  private slowT = 0;
  private hintQueue: { t: number; html: string } | null = null;
  playTime = 0;
  ended = false;
  settings = { sens: 1, vol: 0.8, quality: 'high' as Quality };
  fps = 60;

  constructor(canvas: HTMLCanvasElement, public flags: Flags) {
    this.input = new Input(canvas);
    this.input.virtual = flags.test;
    // phones and tablets start on the lighter preset unless the player has chosen otherwise
    if (this.input.touch) this.settings.quality = 'low';
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* ignore */ }
    if (flags.quality) this.settings.quality = flags.quality;
    this.stage = new Stage(canvas, this.settings.quality);
    this.stage.coarse = this.input.touch;
    if (this.input.touch) this.stage.setQuality(this.settings.quality);
    document.body.classList.toggle('touch', this.input.touch);
    document.body.dataset.device = this.input.device;
    this.input.onDevice = (d) => { document.body.dataset.device = d; };
    this.physics = new Physics();
    this.mats = new Materials();
    this.paint = new PaintWorld(this.physics, this.stage.scene);
    this.glow = new Particles(5000, true);
    this.drops = new Particles(2500, false);
    this.stage.scene.add(this.glow.points, this.drops.points);
    window.addEventListener('resize', () => this.stage.resize());
    // browsers may refuse an immediate re-lock after Esc; a click on the view always recovers
    canvas.addEventListener('click', () => { if (this.state !== 'playing') return; if (!this.input.locked) this.input.lock(); else this.input.capture(); });
  }

  get unlocked(): Set<Paint> { return this.mode === 'sandbox' ? ALL : this.unlockedStory; }

  async init(progress: (f: number, text?: string) => void) {
    this.hud = new Hud(this);
    this.touchUi = new TouchControls(this);
    this.dynamics = new Dynamics(this);
    this.power = new PowerSys(this);
    this.zones = new Zones(this);
    this.player = new Player(this);
    this.gun = new Gun(this);
    this.growth = new Growth(this);
    this.builder = new Builder(this);
    progress(0.15, 'Raising the city…');
    await new Promise((r) => setTimeout(r, 0));
    this.level = buildWorld(this, this.builder);
    progress(0.35, 'Baking light…');
    await this.builder.finalize((f) => progress(0.35 + f * 0.6), this.flags.bake);
    this.physics.world.step();

    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing') this.pause();
    };
    this.applySettings();

    const save = this.loadSave();
    if (save) {
      for (const s of save.seen) this.seen.add(s);
      for (const p of save.unlocked) this.unlockedStory.add(p);
      this.playTime = save.time;
      this.paint.splatCount = save.splats;
      this.player.stats.bounces = save.bounces;
      this.ended = save.done;
      this.level.restoreState(this.seen);
      for (const p of this.unlockedStory) this.zones.removePickup(p);
      for (const sh of this.zones.shards) if (this.seen.has('shard:' + sh.i)) this.zones.hideShard(sh.i);
      for (const u of this.zones.upgrades) if (this.seen.has('upgrade:' + u.id)) this.zones.hideUpgrade(u.id);
      this.storyCp = this.zones.checkpoints.find((c) => c.id === save.cp) ?? null;
      this.stage.restore = this.stage.restoreTarget = this.restoreLevel();
    }
    this.paint.settle();
    this.hud.refreshUnlocked();
    this.hud.setSelected(this.gun.selected);
    progress(1, 'Ready');
    this.state = 'menu';
    this.stage.fade = 1; this.stage.fadeTarget = 0;
    const auto = sessionStorage.getItem('rb-auto');
    sessionStorage.removeItem('rb-auto');
    if (auto) this.hud.showClick('A tool that should not exist', () => this.start(auto as any));
    else this.hud.showMain();
    document.getElementById('menu')!.classList.remove('hidden');
    this.last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  /* ---------------------------------------------------------------- events */

  on(ev: string, fn: (data?: any) => void) {
    let l = this.listeners.get(ev);
    if (!l) this.listeners.set(ev, (l = []));
    l.push(fn);
  }

  emit(ev: string, data?: any) {
    const persistent = /^(zone|pickup|power|socket|mass|finale|grow|shard|log|upgrade)/.test(ev);
    const first = persistent && !this.seen.has(ev);
    if (persistent && this.mode === 'story') this.seen.add(ev);
    for (const f of this.listeners.get(ev) ?? []) f(data);
    if (!first || this.mode !== 'story') return;
    const title = this.level.titles[ev];
    if (title) this.cinematic(title[0], title[1]);
    const r = this.restoreLevel();
    if (r > this.stage.restoreTarget + 0.001) {
      this.stage.restoreTarget = r;
      this.stage.skyPulse = 0.6;
      this.audio.setRestore(r);
    }
    this.refreshObjective(true);
    if (ev === 'finale') this.finale();
    this.save();
  }

  private restoreLevel(): number {
    let r = 0;
    for (const [ev, v] of Object.entries(this.level.restoreAt)) if (this.seen.has(ev)) r = Math.max(r, v);
    return r;
  }

  cinematic(main: string, sub: string) {
    this.hud.title(main, sub);
    this.stage.barsTarget = 1;
    this.barsT = 4.2;
    this.audio.sting();
  }

  currentObjective(): string {
    if (this.mode === 'sandbox') return 'Sandbox';
    return this.objectiveNow()?.text ?? 'Reality rewritten. The city is yours.';
  }

  /** The objective after the furthest one reached (tolerates sequence breaks). */
  private objectiveNow() {
    const list = this.level.objectives;
    let i = list.length - 1;
    while (i >= 0 && !this.seen.has(list[i].until)) i--;
    return list[i + 1];
  }

  private refreshObjective(withHint = false) {
    if (this.mode === 'sandbox') { this.hud.objective(this.input.device === 'kbm' ? 'TEST RANGE — every pigment unlocked. C spawns a crate. Experiment.' : 'TEST RANGE — every pigment unlocked. Experiment.', PAINTS[Paint.Yellow].css); return; }
    const o = this.objectiveNow();
    if (!o) { this.hud.objective('Reality rewritten. The city is yours.', '#52ffe0'); return; }
    this.hud.objective(o.text, o.color ?? '#ffffff');
    if (withHint && o.hint) this.hintQueue = { t: 2.2, html: o.hint };
  }

  /* ---------------------------------------------------------------- progression */

  unlock(p: Paint) {
    const info = PAINTS[p];
    if (this.mode === 'story') this.unlockedStory.add(p);
    this.hud.refreshUnlocked(p);
    this.gun.select(p, true);
    this.audio.unlock();
    this.stage.pulse(info.hex, 0.3);
    this.glow.burst(this.player.pos, null, info.color, 80, 8, 0.09, 1.2, 1, 1.5);
    this.hud.toast(`PIGMENT ACQUIRED — ${info.name}`, info.css);
    this.emit('pickup:' + info.key);
  }

  onCheckpoint(cp: Checkpoint) {
    if (this.mode === 'story' && cp.id !== 'sandbox') { this.storyCp = cp; this.save(); }
  }

  respawn() {
    const cp = this.zones.current ?? this.zones.checkpoints[0];
    this.player.teleport(cp.pos, cp.yaw);
    this.player.gravScale = 1;
    this.stage.fade = 1; this.stage.fadeTarget = 0;
    this.audio.respawn();
    this.emit('respawn');
  }

  /** Put loose props near the player back where they started (soft-lock escape hatch). */
  resetProps(radius = 70) {
    for (const d of this.dynamics.bodies) {
      if (d.captured) continue;
      if (d.home.distanceTo(this.player.pos) < radius) this.dynamics.respawn(d);
    }
    this.level.resetProps?.();
  }

  get shardCount(): number { let n = 0; for (const e of this.seen) if (e.startsWith('shard:')) n++; return n; }

  collectShard(i: number) {
    this.emit('shard:' + i);
    this.audio.unlock();
    this.input.rumble(0.4, 0.6, 160);
    this.stage.pulse(0x7fffe8, 0.18);
    this.glow.burst(this.player.pos, null, new THREE.Color(0x7fffe8), 50, 6, 0.08, 1, -1, 1.6);
    this.hud.toast(`ECHO SHARD ${this.shardCount} / ${this.zones.shards.length}`, '#7fffe8');
    this.hud.refreshShards();
  }

  private countSeen(prefix: string): number { let n = 0; for (const e of this.seen) if (e.startsWith(prefix)) n++; return n; }
  get logCount(): number { return this.countSeen('log:'); }
  get upgradeCount(): number { return this.countSeen('upgrade:'); }
  hasUpgrade(id: string): boolean { return this.seen.has('upgrade:' + id); }

  readLog(i: number) {
    const lg = this.zones.logs[i];
    const first = !this.seen.has('log:' + i);
    this.emit('log:' + i);
    if (first && this.mode === 'story') { this.audio.checkpoint(); this.hud.refreshShards(); }
    this.hud.showLog(lg.title, lg.text);
  }

  grantUpgrade(id: string) {
    const u = this.zones.upgrades.find((x) => x.id === id)!;
    this.emit('upgrade:' + id);
    this.audio.unlock();
    this.input.rumble(0.8, 0.8, 220);
    this.stage.pulse(0xffb43a, 0.3);
    this.glow.burst(this.player.pos, null, new THREE.Color(0xffb43a), 80, 8, 0.09, 1.2, 1, 1.8);
    this.hud.toast(`BRUSH UPGRADE — ${u.name}`, '#ffb43a');
    this.hud.hint(u.desc, 8);
    this.hud.refreshShards();
  }

  /** World position the current objective points at, if any. */
  waypoint(): [number, number, number] | null {
    if (this.mode !== 'story') return null;
    return this.objectiveNow()?.at ?? null;
  }

  private finale() {
    this.ended = true;
    this.finaleT = 0;
    this.stage.restoreTarget = 1;
    this.stage.skyPulse = 1.6;
    this.stage.pulse(0xffffff, 0.9);
    this.audio.finale();
    this.audio.setRestore(1);
    this.player.gravScale = -0.25; // the tower lets go of you: rise out of the shaft and see the city
    this.player.vel.y = 2;
    this.player.grounded = false;
    for (const d of this.dynamics.bodies) if (!d.captured) { d.p.fill(Paint.Purple); this.paint.markDirty(d.p); }
    this.cinematic('REALITY REWRITTEN', 'THE GRAVITY CORE IS AWAKE');
  }

  /* ---------------------------------------------------------------- save */

  hasSave(): boolean { return !!localStorage.getItem(SAVE_KEY); }
  private loadSave(): Save | null {
    try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); return s && s.cp ? s : null; } catch { return null; }
  }
  saveSummary(): string {
    const s = this.loadSave();
    if (!s) return '';
    const cp = this.zones.checkpoints.find((c) => c.id === s.cp);
    return `${cp?.title ?? 'Checkpoint'} · ${s.unlocked.length}/5 pigments${s.done ? ' · complete' : ''}`;
  }
  save() {
    if (this.mode !== 'story' || !this.storyCp || this.flags.test && !(window as any).__rbAllowSave) return;
    const s: Save = {
      cp: this.storyCp.id, seen: [...this.seen], unlocked: [...this.unlockedStory], time: this.playTime,
      splats: this.paint.splatCount, bounces: this.player.stats.bounces, done: this.ended,
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  }

  applySettings(qualityChanged = false) {
    this.player.sensitivity = this.settings.sens;
    this.audio.setVolume(this.settings.vol);
    if (qualityChanged) this.stage.setQuality(this.settings.quality);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
  }

  /* ---------------------------------------------------------------- state */

  start(kind: 'new' | 'continue' | 'sandbox') {
    this.audio.init();
    if (kind === 'new' && (this.storyStarted || this.hasSave() || this.seen.size > 0)) {
      localStorage.removeItem(SAVE_KEY);
      sessionStorage.setItem('rb-auto', 'new');
      location.reload();
      return;
    }
    if (kind === 'sandbox') {
      this.mode = 'sandbox';
      const cp = this.zones.checkpoints.find((c) => c.id === 'sandbox')!;
      this.zones.activate(cp, true);
      this.player.teleport(cp.pos, cp.yaw);
      this.stage.restoreTarget = Math.max(this.stage.restoreTarget, 0.55);
      this.audio.setRestore(0.55);
    } else {
      this.mode = 'story';
      this.storyStarted = true;
      const cp = this.storyCp ?? this.zones.checkpoints.find((c) => c.id === 'start')!;
      this.storyCp = cp;
      this.zones.activate(cp, true);
      this.player.teleport(cp.pos, cp.yaw);
      this.stage.restoreTarget = this.restoreLevel();
      this.audio.setRestore(this.stage.restoreTarget);
      if (this.unlockedStory.size === 0) { this.unlockedStory.add(Paint.Purple); this.zones.removePickup(Paint.Purple); }
      if (kind === 'new') this.hintQueue = { t: 1.5, html: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move &nbsp;·&nbsp; <kbd>LMB</kbd> spray &nbsp;·&nbsp; <kbd>Space</kbd> jump' };
      this.save();
    }
    this.player.gravScale = 1;
    if (this.input.touch && !this.flags.test) {
      // best effort: phones play far better full-screen and sideways
      try { (document.documentElement.requestFullscreen?.() as Promise<void> | undefined)?.then(() => (screen.orientation as any)?.lock?.('landscape')?.catch?.(() => {}))?.catch?.(() => {}); } catch { /* unsupported */ }
    }
    this.hud.refreshUnlocked();
    this.hud.refreshShards();
    if (!this.unlocked.has(this.gun.selected) && this.gun.selected !== Paint.None) this.gun.select([...this.unlocked][0] ?? Paint.None, true);
    this.hud.setSelected(this.gun.selected);
    this.refreshObjective(kind !== 'new');
    this.stage.fade = 1; this.stage.fadeTarget = 0;
    this.resume();
  }

  resume() {
    this.hud.hideMenu();
    this.hud.show(true);
    this.state = 'playing';
    if (this.player.gravScale < 0) this.player.gravScale = 1;
    this.touchUi.show(this.input.touch);
    this.input.lock();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.touchUi.show(false);
    if (this.input.locked) this.input.unlock();
    this.audio.spray(false, this.gun.selected);
    this.hud.showPause();
    document.getElementById('menu')!.classList.remove('hidden');
  }

  /* ---------------------------------------------------------------- loop */

  private loop(now: number) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps += (1 / Math.max(dt, 0.001) - this.fps) * 0.05;
    // safety net for weak GPUs: fall back to the performance preset if the frame rate stays low
    if (this.state === 'playing' && this.settings.quality === 'high' && !this.flags.test) {
      this.slowT = this.fps < 27 ? this.slowT + dt : 0;
      if (this.slowT > 6) {
        this.slowT = 0;
        this.settings.quality = 'low';
        this.applySettings(true);
        this.hud.toast('PERFORMANCE MODE ENABLED — change it back in the pause menu', '#ffd21f');
      }
    }
    this.frame(dt);
    this.stage.render();
  }

  frame(dt: number) {
    const playing = this.state === 'playing';
    this.input.poll(dt);
    if (!playing) this.menuNav();
    if (playing) {
      this.player.frame(dt);
      this.gun.frame(dt);
      if (this.input.hit('KeyR')) this.respawn();
      if (this.input.hit('KeyC') && this.mode === 'sandbox') this.level.spawnCrate?.();
      if (this.input.hit('Escape') && !this.input.captured) this.pause();
      this.acc += dt;
      let steps = 0;
      while (this.acc >= FIXED && steps < 4) { this.fixed(FIXED); this.acc -= FIXED; steps++; }
      if (steps === 4) this.acc = 0;
      this.input.endFrame();
      if (this.mode === 'story' && !this.ended) this.playTime += dt;
    } else this.input.endFrame();

    timeUniform.value += dt;
    this.paint.update(dt);
    this.paint.syncVisuals();
    this.growth.frame(dt);
    const scale = this.stage.renderer.getPixelRatio() * window.innerHeight * 0.9;
    this.glow.update(dt, scale);
    this.drops.update(dt, scale);
    const cam = this.stage.camera;
    if (this.state === 'menu') {
      const mc = this.level.menuCam, t = timeUniform.value * 0.05;
      cam.position.set(mc.pos.x + Math.sin(t) * 2.5, mc.pos.y + Math.sin(t * 0.7) * 0.6, mc.pos.z + Math.cos(t) * 1.5);
      cam.lookAt(mc.look);
    } else this.player.updateCamera(cam, playing ? this.acc / FIXED : 1, dt);
    for (const a of this.builder.animators) a(dt, timeUniform.value);
    this.level.frame(dt, timeUniform.value);
    if (this.barsT > 0 && (this.barsT -= dt) <= 0) this.stage.barsTarget = 0;
    if (this.hintQueue && playing && (this.hintQueue.t -= dt) <= 0) { this.hud.hint(this.hintQueue.html, 9); this.hintQueue = null; }
    if (this.finaleT >= 0 && playing) {
      this.finaleT += dt;
      if (this.finaleT > 9.5) {
        this.finaleT = -1;
        this.save();
        this.state = 'ending';
        this.touchUi.show(false);
        this.input.unlock();
        this.hud.showEnding({ time: this.playTime, splats: this.paint.splatCount, bounces: this.player.stats.bounces, shards: this.shardCount, shardTotal: this.zones.shards.length, logs: this.logCount, logTotal: this.zones.logs.length, upgrades: this.upgradeCount });
        document.getElementById('menu')!.classList.remove('hidden');
      }
    }
    this.stage.update(dt, cam.position);
    this.audio.update(dt);
    this.hud.update(dt);
  }

  /** Drive whatever menu is open from a gamepad. */
  private menuNav() {
    const m = this.input.menu;
    if (!m.up && !m.down && !m.accept && !m.back) return;
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('#menu:not(.hidden) button.mb'));
    if (!btns.length) return;
    let i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (m.down) i = (i + 1) % btns.length;
    else if (m.up) i = (i - 1 + btns.length) % btns.length;
    if (i < 0) i = 0;
    btns[i].focus();
    if (m.accept) btns[i].click();
    else if (m.back && this.state === 'paused') this.resume();
  }

  fixed(dt: number) {
    this.time += dt;
    this.power.fixedUpdate(dt);
    this.dynamics.fixedUpdate(dt);
    this.growth.fixedUpdate(dt);
    this.player.fixedUpdate(dt);
    this.gun.fixedUpdate(dt);
    this.physics.world.step();
    this.zones.update(dt);
    this.level.fixed?.(dt);
  }

  /** Headless stepping for automated tests: advances the simulation without rendering. */
  simulate(seconds: number) {
    const n = Math.round(seconds / FIXED);
    for (let i = 0; i < n; i++) {
      this.player.frame(FIXED);
      this.gun.frame(FIXED);
      this.fixed(FIXED);
      this.input.endFrame();
      this.paint.update(FIXED);
      this.player.updateCamera(this.stage.camera, 1, FIXED);
      this.stage.camera.updateMatrixWorld(true);
    }
    this.paint.syncVisuals();
  }
}
