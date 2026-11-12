import { Physics } from './core/physics';
import { Game } from './game';

async function boot() {
  const q = new URLSearchParams(location.search);
  const test = q.has('test');
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const bar = document.getElementById('load-bar')!, text = document.getElementById('load-text')!;
  const progress = (f: number, t?: string) => { bar.style.width = Math.round(f * 100) + '%'; if (t) text.textContent = t; };
  try {
    progress(0.05, 'Waking the physics…');
    await Physics.init();
    const game = new Game(canvas, {
      test,
      bake: q.has('bake') ? q.get('bake') !== '0' : !test,
      quality: (q.get('quality') as 'high' | 'low' | null) ?? (test ? 'low' : undefined),
    });
    (window as any).__rb = game;
    await game.init(progress);
    game.hud.loadingDone();
  } catch (e) {
    console.error(e);
    text.textContent = 'Could not start: ' + (e as Error).message + ' — WebGL2 and WebAssembly are required.';
  }
}
boot();
