import type { Game } from '../game';
import { Paint, PAINTS, PAINT_ORDER } from '../paint/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const CONTROLS = `
<div class="controls">
  <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>Move &nbsp;·&nbsp; <kbd>Shift</kbd> sprint &nbsp;·&nbsp; <kbd>Space</kbd> jump</span>
  <span><kbd>LMB</kbd></span><span>Spray paint</span>
  <span><kbd>RMB</kbd> / <kbd>F</kbd></span><span>Kinetic pulse — shove objects</span>
  <span><kbd>1</kbd>–<kbd>5</kbd> / wheel</span><span>Select pigment</span>
  <span><kbd>Q</kbd></span><span>Solvent — strips paint</span>
  <span><kbd>R</kbd></span><span>Return to checkpoint &nbsp;·&nbsp; <kbd>Esc</kbd> pause</span>
</div>`;

export class Hud {
  private slots = new Map<Paint, HTMLElement>();
  private hintTimer = 0;
  private titleTimer = 0;
  private lastObjective = '';
  private tags = '';

  constructor(private game: Game) {
    const bar = $('hotbar');
    const mk = (p: Paint, key: string) => {
      const d = document.createElement('div');
      d.className = 'slot locked';
      d.style.setProperty('--c', PAINTS[p].css);
      d.innerHTML = `<em>${key}</em><b></b>`;
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
    h.innerHTML = html;
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
    const pl = this.game.player;
    $('crosshair').classList.toggle('fire', this.game.input.down('Mouse0'));
    const tags = [pl.climbing ? 'CLIMBING' : '', pl.onIce ? 'NO FRICTION' : '', pl.lowG && !pl.grounded ? 'LOW GRAVITY' : ''].filter(Boolean).join(' · ');
    if (tags !== this.tags) { this.tags = tags; $('state-tags').textContent = tags; }
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
    m.innerHTML = `<div class="menu-inner"><h1 class="logo">REALITY <span>BRUSH</span></h1><p class="tagline">Rewrite the world</p><div class="btns"></div>${CONTROLS}</div><div class="foot">A TOOL THAT SHOULD NOT EXIST</div>`;
    const b = m.querySelector('.btns')!;
    if (g.hasSave()) b.appendChild(this.btn('Continue', g.saveSummary(), 'var(--green)', () => g.start('continue')));
    b.appendChild(this.btn('New Game', 'Three districts · one impossible tool', 'var(--purple)', () => g.start('new')));
    b.appendChild(this.btn('Sandbox', 'Every pigment unlocked · free experimentation', 'var(--yellow)', () => g.start('sandbox')));
    m.querySelector('.menu-inner')!.appendChild(this.settings());
  }

  showPause() {
    const g = this.game, m = $('menu');
    m.className = 'center';
    m.innerHTML = `<div class="menu-inner"><h3>PAUSED</h3><p class="tagline">${g.mode === 'sandbox' ? 'Sandbox — test range' : g.currentObjective()}</p><div class="btns"></div>${CONTROLS}</div>`;
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
  }

  showClick(text: string, fn: () => void) {
    const m = $('menu');
    m.className = 'center';
    m.innerHTML = `<div class="menu-inner"><h1 class="logo">REALITY <span>BRUSH</span></h1><p class="tagline">${text}</p><div class="btns"></div></div>`;
    m.querySelector('.btns')!.appendChild(this.btn('Begin', '', 'var(--purple)', fn));
  }

  showEnding(stats: { time: number; splats: number; bounces: number }) {
    const g = this.game, m = $('menu');
    const mm = Math.floor(stats.time / 60), ss = Math.floor(stats.time % 60);
    m.className = 'center ending';
    m.innerHTML = `<div class="menu-inner"><h1 class="logo">REALITY <span>REWRITTEN</span></h1>
      <p class="lead">The gravity core is singing again. Colour is pouring back into the city, street by street — and the brush is still warm in your hands.</p>
      <div class="stats"><div><b>${mm}:${String(ss).padStart(2, '0')}</b>Time</div><div><b>${stats.splats}</b>Splats</div><div><b>${stats.bounces}</b>Bounces</div></div>
      <div class="btns"></div></div>`;
    const b = m.querySelector('.btns')!;
    b.appendChild(this.btn('Keep exploring', 'The world stays painted', 'var(--green)', () => g.resume()));
    b.appendChild(this.btn('Sandbox', 'Free experimentation', 'var(--yellow)', () => g.start('sandbox')));
    b.appendChild(this.btn('New Game', '', 'var(--purple)', () => g.start('new')));
  }
}
