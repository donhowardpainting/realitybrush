import type { Game } from '../game';
import * as THREE from 'three';
import { Paint, PAINTS, PAINT_ORDER } from '../paint/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const CONTROL_SETS: Record<string, [string, string][]> = {
  kbm: [
    ['<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>', 'Move &nbsp;·&nbsp; <kbd>Shift</kbd> sprint &nbsp;·&nbsp; <kbd>Space</kbd> jump'],
    ['<kbd>LMB</kbd>', 'Spray paint &nbsp;·&nbsp; <kbd>E</kbd> paint bomb'],
    ['<kbd>RMB</kbd> / <kbd>F</kbd>', 'Kinetic pulse — shove objects'],
    ['<kbd>1</kbd>–<kbd>5</kbd> / wheel', 'Select pigment &nbsp;·&nbsp; <kbd>Q</kbd> solvent'],
    ['<kbd>R</kbd>', 'Return to checkpoint &nbsp;·&nbsp; <kbd>Esc</kbd> pause'],
  ],
  pad: [
    ['<kbd>L</kbd> / <kbd>R</kbd> sticks', 'Move / look &nbsp;·&nbsp; <kbd>L3</kbd> sprint &nbsp;·&nbsp; <kbd>A</kbd> jump'],
    ['<kbd>RT</kbd>', 'Spray paint &nbsp;·&nbsp; <kbd>X</kbd> paint bomb'],
    ['<kbd>LT</kbd>', 'Kinetic pulse — shove objects'],
    ['<kbd>LB</kbd> / <kbd>RB</kbd>', 'Select pigment &nbsp;·&nbsp; <kbd>B</kbd> solvent'],
    ['<kbd>Start</kbd>', 'Pause — return to checkpoint from there'],
  ],
  touch: [
    ['Left thumb', 'Move — push past the ring to sprint'],
    ['Right thumb', 'Drag to look &nbsp;·&nbsp; hold <kbd>SPRAY</kbd> and drag to paint a stroke'],
    ['<kbd>BOMB</kbd>', 'One big splash of the selected pigment'],
    ['<kbd>PULSE</kbd>', 'Shove objects &nbsp;·&nbsp; tap a pigment to select it'],
  ],
};
const controlsHtml = (device: string) =>
  `<div class="controls">${(CONTROL_SETS[device] ?? CONTROL_SETS.kbm).map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('')}</div>`;

/** Rewrite keyboard prompts inside a hint for the device actually in use. */
function forDevice(html: string, device: string): string {
  if (device === 'kbm') return html;
  const pad = device === 'pad';
  const map: Record<string, string> = pad
    ? { LMB: 'RT', RMB: 'LT', Space: 'A', Q: 'B', E: 'X', Shift: 'L3', R: 'Start', F: 'LT' }
    : { LMB: 'SPRAY', RMB: 'PULSE', Space: 'JUMP', Q: 'SOLVENT', E: 'BOMB', F: 'PULSE' };
  return html
    .replace(/<kbd>W<\/kbd><kbd>A<\/kbd><kbd>S<\/kbd><kbd>D<\/kbd>/g, pad ? '<kbd>L-STICK</kbd>' : '<kbd>LEFT THUMB</kbd>')
    .replace(/<kbd>[1-5]<\/kbd>\s*/g, '')
    .replace(/<kbd>([^<]+)<\/kbd>/g, (m, k) => (map[k] ? `<kbd>${map[k]}</kbd>` : m));
}

export class Hud {
  private slots = new Map<Paint, HTMLElement>();
  private hintTimer = 0;
  private titleTimer = 0;
  private lastObjective = '';
  private tags = '';
  private logTimer = 0;
  private aim = '';
  private aimT = 0;
  private dir = new THREE.Vector3();

  constructor(private game: Game) {
    const bar = $('hotbar');
    const mk = (p: Paint, key: string) => {
      const d = document.createElement('div');
      d.className = 'slot locked';
      d.style.setProperty('--c', PAINTS[p].css);
      d.innerHTML = `<em>${key}</em><b></b>`;
      d.addEventListener('pointerdown', (e) => { e.preventDefault(); if (this.game.state === 'playing') this.game.gun.select(p); });
      bar.appendChild(d);
      this.slots.set(p, d);
    };
    PAINT_ORDER.forEach((p, i) => mk(p, String(i + 1)));
    mk(Paint.None, 'Q');
    this.slots.get(Paint.None)!.classList.remove('locked');
  }

  show(on: boolean) { $('hud').classList.toggle('hidden', !on); }

  refreshUnlocked(flash?: Paint) {
    for (const p of PAINT_ORDER) {
      const el = this.slots.get(p)!;
      el.classList.toggle('locked', !this.game.unlocked.has(p));
      if (p === flash) { el.classList.remove('new'); void el.offsetWidth; el.classList.add('new'); }
    }
  }

  setSelected(p: Paint) {
    for (const [k, el] of this.slots) el.classList.toggle('sel', k === p);
    const info = PAINTS[p];
    $('crosshair').style.setProperty('--c', info.css);
    const n = $('paint-name');
    n.style.setProperty('--c', info.css);
    n.querySelector('b')!.textContent = info.name;
    n.querySelector('span')!.textContent = info.verb;
  }

  objective(text: string, color = '#ffffff') {
    if (text === this.lastObjective) return;
    this.lastObjective = text;
    const o = $('objective');
    o.classList.toggle('hidden', !text);
    $('objective-text').textContent = text;
    o.style.setProperty('--oc', color);
    o.classList.remove('flash'); void o.offsetWidth; o.classList.add('flash');
  }

  /** Bottom-centre contextual hint. HTML allowed (<kbd>). */
  hint(html: string, seconds = 7) {
    const h = $('hint');
    h.innerHTML = forDevice(html, this.game.input.device);
    h.classList.add('show');
    this.hintTimer = seconds;
  }

  toast(text: string, color = '#ffffff') {
    const t = document.createElement('div');
    t.className = 'toast';
    t.style.setProperty('--tc', color);
    t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 4300);
  }

  title(main: string, sub: string, seconds = 4.5) {
    const c = $('title-card');
    c.querySelector('h2')!.textContent = main;
    c.querySelector('p')!.textContent = sub;
    c.classList.add('show');
    this.titleTimer = seconds;
  }

  loading(f: number, text?: string) {
    $('load-bar').style.width = Math.round(f * 100) + '%';
    if (text) $('load-text').textContent = text;
  }
  loadingDone() { $('loading').classList.add('out'); setTimeout(() => $('loading').classList.add('hidden'), 900); }

  update(dt: number) {
    if (this.hintTimer > 0 && (this.hintTimer -= dt) <= 0) $('hint').classList.remove('show');
    if (this.titleTimer > 0 && (this.titleTimer -= dt) <= 0) $('title-card').classList.remove('show');
    if (this.logTimer > 0 && (this.logTimer -= dt) <= 0) $('log-card').classList.remove('show');
    const pl = this.game.player;
    $('crosshair').classList.toggle('fire', this.game.input.down('Mouse0'));
    this.updateWaypoint();
    const ready = this.game.gun.bombReady;
    $('bomb-pip').style.setProperty('--f', String(Math.round(ready * 100)));
    $('bomb-pip').classList.toggle('ready', ready >= 1);
    const tags = [pl.climbing ? 'CLIMBING' : '', pl.onIce ? 'NO FRICTION' : '', pl.lowG && !pl.grounded ? 'LOW GRAVITY' : ''].filter(Boolean).join(' · ');
    if (tags !== this.tags) { this.tags = tags; $('state-tags').textContent = tags; }
    if ((this.aimT -= dt) <= 0) {
      this.aimT = 0.12;
      const aim = this.game.state === 'playing' ? this.describeAim() : '';
      if (aim !== this.aim) { this.aim = aim; $('aim-tag').textContent = aim; }
    }
  }

  /** One-line readout of whatever is under the crosshair: makes the rules discoverable. */
  private describeAim(): string {
    const g = this.game, e = g.player.eye, d = g.player.forward(this.dir);
    const h = g.physics.castRay(e.x, e.y, e.z, d.x, d.y, d.z, 45);
    const p = h ? g.paint.get(h.collider) : undefined;
    if (!p) return '';
    const r = g.power.receptors.find((x) => x.p === p);
    if (r) {
      const name = r.label || `${PAINTS[r.need].key.toUpperCase()} LOCK`;
      return r.on ? `${name} · ENERGISED` : `${name} · ${Math.min(99, Math.round((r.coverage / 0.35) * 100))}%`;
    }
    if (p.tags.has('cap')) return `STALK · ${(p.data.stalk.height as number).toFixed(1)} M`;
    if (p.dynamic) {
      const dyn = g.dynamics.byPaintable.get(p);
      if (!dyn || dyn.captured) return '';
      return `${Math.round(p.body.mass())} KG` + (dyn.lift > 0 ? ` · LIFT ${Math.round(dyn.lift * 100)}%` : '') + (dyn.icy ? ' · FRICTIONLESS' : '') + (dyn.cY > 0.05 ? ' · ELASTIC' : '');
    }
    if (p.fertile === 'vine') return 'FERTILE MOSS';
    if (p.fertile === 'stalk') return 'FERTILE SOIL';
    if (p.resist) return 'PAINT-RESISTANT';
    return '';
  }

  showLog(title: string, text: string) {
    const c = $('log-card');
    c.querySelector('b')!.textContent = title;
    c.querySelector('p')!.textContent = text;
    c.classList.add('show');
    this.logTimer = 14;
  }
  hideLog() { $('log-card').classList.remove('show'); this.logTimer = 0; }

  refreshShards() {
    const g = this.game, el = $('shards');
    const n = g.shardCount, l = g.logCount, u = g.upgradeCount;
    el.classList.toggle('hidden', g.mode !== 'story' || n + l + u === 0);
    el.textContent = `◆ ${n}/${g.zones.shards.length}   ▤ ${l}/${g.zones.logs.length}   ✦ ${u}/${g.zones.upgrades.length}`;
  }

  /** Objective marker: a diamond pinned to the goal, clamped to the screen edge when off-view. */
  private updateWaypoint() {
    const g = this.game, el = $('waypoint');
    const at = g.state === 'playing' ? g.waypoint() : null;
    if (!at) { el.classList.add('hidden'); return; }
    const cam = g.stage.camera, v = this.dir.set(at[0], at[1], at[2]);
    const dist = v.distanceTo(cam.position);
    if (dist < 3.5) { el.classList.add('hidden'); return; }
    v.applyMatrix4(cam.matrixWorldInverse);
    const behind = v.z > -0.1;
    v.applyMatrix4(cam.projectionMatrix);
    let x = v.x, y = v.y;
    if (behind) { x = -x; y = -y; }
    const off = behind || Math.abs(x) > 0.9 || Math.abs(y) > 0.82;
    if (off) { const k = Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.82, 1e-3); x /= k; y /= k; if (behind && Math.abs(x) < 0.5) x = Math.sign(x || 1) * 0.9; }
    el.classList.remove('hidden');
    el.classList.toggle('off', off);
    el.style.transform = `translate(${((x * 0.5 + 0.5) * window.innerWidth).toFixed(1)}px, ${((-y * 0.5 + 0.5) * window.innerHeight).toFixed(1)}px)`;
    const label = Math.round(dist) + ' m';
    if (el.dataset.d !== label) { el.dataset.d = label; el.querySelector('span')!.textContent = label; }
    el.style.setProperty('--c', $('objective').style.getPropertyValue('--oc') || '#fff');
  }

  /* ---------------------------------------------------------------- menus */

  private btn(label: string, sub: string, color: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'mb';
    b.style.setProperty('--bc', color);
    b.innerHTML = `${label}${sub ? `<small>${sub}</small>` : ''}`;
    b.addEventListener('click', fn);
    return b;
  }

  private settings(): HTMLElement {
    const g = this.game, s = document.createElement('div');
    s.className = 'settings';
    s.innerHTML = `
      <label>Look speed</label><input id="set-sens" type="range" min="0.3" max="2.5" step="0.05" value="${g.settings.sens}"><span id="set-sens-v">${g.settings.sens.toFixed(2)}</span>
      <label>Volume</label><input id="set-vol" type="range" min="0" max="1" step="0.05" value="${g.settings.vol}"><span id="set-vol-v">${Math.round(g.settings.vol * 100)}</span>
      <label>Graphics</label><select id="set-q"><option value="high">High — bloom, MSAA, grading</option><option value="low">Performance</option></select>`;
    setTimeout(() => {
      const sens = $<HTMLInputElement>('set-sens'), vol = $<HTMLInputElement>('set-vol'), q = $<HTMLSelectElement>('set-q');
      if (!sens) return;
      q.value = g.settings.quality;
      sens.oninput = () => { g.settings.sens = +sens.value; $('set-sens-v').textContent = (+sens.value).toFixed(2); g.applySettings(); };
      vol.oninput = () => { g.settings.vol = +vol.value; $('set-vol-v').textContent = String(Math.round(+vol.value * 100)); g.applySettings(); };
      q.onchange = () => { g.settings.quality = q.value as 'high' | 'low'; g.applySettings(true); };
    });
    return s;
  }

  hideMenu() { $('menu').classList.add('hidden'); }

  showMain() {
    const g = this.game, m = $('menu');
    m.className = '';
    m.innerHTML = `<div class="menu-inner"><h1 class="logo">REALITY <span>BRUSH</span></h1><p class="tagline">Rewrite the world</p><div class="btns"></div>${controlsHtml(g.input.device)}</div><div class="foot">A TOOL THAT SHOULD NOT EXIST</div>`;
    const b = m.querySelector('.btns')!;
    if (g.hasSave()) b.appendChild(this.btn('Continue', g.saveSummary(), 'var(--green)', () => g.start('continue')));
    b.appendChild(this.btn('New Game', 'Three districts · one impossible tool', 'var(--purple)', () => g.start('new')));
    b.appendChild(this.btn('Sandbox', 'Every pigment unlocked · free experimentation', 'var(--yellow)', () => g.start('sandbox')));
    m.querySelector('.menu-inner')!.appendChild(this.settings());
  }

  showPause() {
    const g = this.game, m = $('menu');
    m.className = 'center';
    m.innerHTML = `<div class="menu-inner"><h3>PAUSED</h3><p class="tagline">${g.mode === 'sandbox' ? 'Sandbox — test range' : g.currentObjective()}</p><div class="btns"></div>${controlsHtml(g.input.device)}</div>`;
    const b = m.querySelector('.btns')!;
    b.appendChild(this.btn('Resume', '', 'var(--green)', () => g.resume()));
    b.appendChild(this.btn('Return to checkpoint', '', 'var(--blue)', () => { g.respawn(); g.resume(); }));
    if (g.mode === 'sandbox') {
      b.appendChild(this.btn('Reset sandbox objects', '', 'var(--yellow)', () => { g.resetProps(); g.resume(); }));
      b.appendChild(this.btn('Back to story', '', 'var(--purple)', () => g.start(g.hasSave() ? 'continue' : 'new')));
    } else {
      b.appendChild(this.btn('Reset nearby objects', 'Puts loose props back where they started', 'var(--yellow)', () => { g.resetProps(); g.resume(); }));
      b.appendChild(this.btn('Sandbox', 'Your story progress is kept', 'var(--yellow)', () => g.start('sandbox')));
    }
    b.appendChild(this.btn('Restart story', 'Erases progress', 'var(--red)', () => g.start('new')));
    m.querySelector('.menu-inner')!.appendChild(this.settings());
    // everything found so far, readable again
    const notes = g.zones.logs.filter((l) => g.seen.has('log:' + l.i));
    const ups = g.zones.upgrades.filter((u) => g.seen.has('upgrade:' + u.id));
    if (g.mode === 'story' && notes.length + ups.length > 0) {
      const d = document.createElement('details');
      d.className = 'notes';
      d.innerHTML = `<summary>Finds — ${g.shardCount}/${g.zones.shards.length} shards · ${notes.length}/${g.zones.logs.length} notes · ${ups.length}/${g.zones.upgrades.length} upgrades</summary>`
        + ups.map((u) => `<p><b>✦ ${u.name}</b>${u.desc}</p>`).join('') + notes.map((l) => `<p><b>${l.title}</b>${l.text}</p>`).join('');
      m.querySelector('.menu-inner')!.appendChild(d);
    }
  }

  showClick(text: string, fn: () => void) {
    const m = $('menu');
    m.className = 'center';
    m.innerHTML = `<div class="menu-inner"><h1 class="logo">REALITY <span>BRUSH</span></h1><p class="tagline">${text}</p><div class="btns"></div></div>`;
    m.querySelector('.btns')!.appendChild(this.btn('Begin', '', 'var(--purple)', fn));
  }

  showEnding(stats: { time: number; splats: number; bounces: number; shards: number; shardTotal: number; logs: number; logTotal: number; upgrades: number }) {
    const g = this.game, m = $('menu');
    const mm = Math.floor(stats.time / 60), ss = Math.floor(stats.time % 60);
    m.className = 'center ending';
    m.innerHTML = `<div class="menu-inner"><h1 class="logo">REALITY <span>REWRITTEN</span></h1>
      <p class="lead">The gravity core is singing again. Colour is pouring back into the city, street by street — and the brush is still warm in your hands.</p>
      <div class="stats"><div><b>${mm}:${String(ss).padStart(2, '0')}</b>Time</div><div><b>${stats.splats}</b>Splats</div><div><b>${stats.bounces}</b>Bounces</div><div><b>${stats.shards}/${stats.shardTotal}</b>Echo shards</div><div><b>${stats.logs}/${stats.logTotal}</b>Field notes</div><div><b>${stats.upgrades}/3</b>Upgrades</div></div>
      <div class="btns"></div></div>`;
    const b = m.querySelector('.btns')!;
    b.appendChild(this.btn('Keep exploring', 'The world stays painted', 'var(--green)', () => g.resume()));
    b.appendChild(this.btn('Sandbox', 'Free experimentation', 'var(--yellow)', () => g.start('sandbox')));
    b.appendChild(this.btn('New Game', '', 'var(--purple)', () => g.start('new')));
  }
}
