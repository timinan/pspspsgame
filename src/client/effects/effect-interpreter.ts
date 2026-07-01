/**
 * effect-interpreter.ts
 *
 * Runtime driver for the 441 data-driven effects generated from the
 * smoketest into `src/shared/effect-catalog-gen.ts`. Each metadata entry
 * has a `kind` string + `params` blob; runKind() dispatches to a Phaser
 * renderer that matches the smoketest's vanilla-canvas visuals as closely
 * as feasible.
 *
 * Design:
 *   - Every kind returns { destroy, pulseHit?, pulseMiss? } (matches
 *     EffectHandle from cat-effects.ts).
 *   - Renderers use Phaser Graphics + tweens + POST_UPDATE for parity with
 *     the existing makeGlow / makeParticles style. Depth is always
 *     `target.depth - 1` so effects sit behind the cat (matches the
 *     "cat always on top" rule Tim established on 2026-06-30).
 *   - Kinds not yet fully implemented fall back to `runFallback()` which
 *     paints a soft colored aura so equipping doesn't crash. Follow-up
 *     sessions fill each remaining renderer in place.
 */
import { Scene, Scenes, GameObjects, Tweens } from 'phaser';
import type { EffectHandle, EffectTarget, CatEffect } from './cat-effects';
import type { EffectMeta } from '@/shared/effect-catalog-gen';
// (aliased under src/client/shared/ — see tsconfig paths)

const REST_INTENSITY = 0.55;
const HIT_INTENSITY = 1.0;
const MISS_INTENSITY = 0.3;
const PULSE_DECAY_MS = 600;

function footPosition(target: EffectTarget): { x: number; y: number } {
  return {
    x: target.x,
    y: target.y + target.displayHeight * (1 - target.originY),
  };
}

// Body-mid Y — used by halos/rings/pulses so they wrap the cat's torso.
function midPosition(target: EffectTarget): { x: number; y: number } {
  return {
    x: target.x,
    y: target.y - target.displayHeight * (target.originY - 0.5),
  };
}

// Interpolate two 0xRRGGBB colors.
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
function cycleColor(colors: number[], t: number, cycleMs: number): number {
  const n = colors.length;
  if (n === 1) return colors[0];
  const phase = (t / cycleMs) % 1;
  const seg = 1 / n;
  const idx = Math.floor(phase / seg);
  const segP = (phase - idx * seg) / seg;
  return lerpColor(colors[idx], colors[(idx + 1) % n], segP);
}

// ===========================================================================
// STAGELIGHT (solid + multicolor cycling)
// ===========================================================================
function runStagelight(
  scene: Scene, target: EffectTarget, scale: number,
  colors: number[], cycleMs = 2400,
): EffectHandle {
  const baseWidth = 56 * scale;
  const tipWidth = 10 * scale;
  const flameHeight = 96 * scale;
  const sliceThick = 10 * scale;
  const slices = 40;
  const g = scene.add.graphics().setDepth(target.depth - 1);
  g.alpha = REST_INTENSITY;

  const draw = (color: number): void => {
    g.clear();
    for (let i = 0; i < slices; i++) {
      const t = i / (slices - 1);
      const y = -t * flameHeight;
      const w = baseWidth + (tipWidth - baseWidth) * t;
      const alpha = 0.24 * (1 - t * 0.8);
      g.fillStyle(color, alpha);
      g.fillEllipse(0, y, w, sliceThick);
    }
  };
  const sync = (): void => { const p = footPosition(target); g.setPosition(p.x, p.y); };

  let lastColor = -1;
  const onUpdate = (): void => {
    sync();
    if (colors.length === 1) {
      if (lastColor !== colors[0]) { draw(colors[0]); lastColor = colors[0]; }
    } else {
      const c = cycleColor(colors, scene.time.now, cycleMs);
      if (c !== lastColor) { draw(c); lastColor = c; }
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, onUpdate);
  onUpdate();

  const flicker = scene.tweens.add({
    targets: g, scaleX: 1.08, duration: 380,
    delay: Math.random() * 380, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
  });
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, onUpdate);
    flicker.stop(); flicker.remove(); g.destroy();
  });
}

// ===========================================================================
// STAGELIGHT SPATIAL SPLIT (N vertical bands across flame width)
// ===========================================================================
function runStagelightSplit(
  scene: Scene, target: EffectTarget, scale: number, colors: number[],
): EffectHandle {
  const baseWidth = 56 * scale;
  const tipWidth = 10 * scale;
  const flameHeight = 96 * scale;
  const sliceThick = 10 * scale;
  const slices = 40;
  const n = colors.length;
  const g = scene.add.graphics().setDepth(target.depth - 1);
  g.alpha = REST_INTENSITY;

  const draw = (): void => {
    g.clear();
    for (let i = 0; i < slices; i++) {
      const t = i / (slices - 1);
      const y = -t * flameHeight;
      const w = baseWidth + (tipWidth - baseWidth) * t;
      const alpha = 0.24 * (1 - t * 0.8);
      const segW = w / n;
      for (let k = 0; k < n; k++) {
        const cx = -w / 2 + segW * k + segW / 2;
        g.fillStyle(colors[k], alpha);
        g.fillEllipse(cx, y, segW, sliceThick);
      }
    }
  };
  const sync = (): void => { const p = footPosition(target); g.setPosition(p.x, p.y); };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync(); draw();

  const flicker = scene.tweens.add({
    targets: g, scaleX: 1.08, duration: 380,
    delay: Math.random() * 380, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
  });
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    flicker.stop(); flicker.remove(); g.destroy();
  });
}

// ===========================================================================
// HALO — ring around head/mid/feet with optional rotating bead
// ===========================================================================
type HaloParams = {
  color: number; radius: number; thickness?: number; pos?: 'head'|'mid'|'feet';
  glow?: boolean; alpha?: number; rotateMs?: number; tiltOscMs?: number;
  shape?: 'ellipse'|'segments'; segments?: number; reverse?: boolean;
  beadColor?: number; rotateBead?: boolean;
};
function runHalo(scene: Scene, target: EffectTarget, scale: number, p: HaloParams): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const radius = p.radius * scale;
  const thickness = p.thickness ?? 3;
  const posMode = p.pos ?? 'mid';
  const baseSquash = p.shape === 'ellipse' ? 0.32 : 0.55;
  const dir = p.reverse ? -1 : 1;

  const draw = (t: number): void => {
    g.clear();
    const squashAmp = p.tiltOscMs ? 0.12 * Math.sin(t / p.tiltOscMs) : 0;
    const squash = baseSquash + squashAmp;
    const rotate = p.rotateMs ? (t / p.rotateMs) * Math.PI * 2 * dir : 0;
    g.lineStyle(thickness, p.color, p.alpha ?? 0.85);
    if (p.shape === 'segments') {
      const n = p.segments ?? 12;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2 + rotate;
        const a1 = a0 + (Math.PI * 2) / n * 0.7;
        g.beginPath();
        g.arc(0, 0, radius, a0, a1);
        g.strokePath();
      }
    } else {
      g.strokeEllipse(0, 0, radius * 2, radius * 2 * squash);
      if (p.glow) {
        g.lineStyle(thickness * 3, p.color, 0.18);
        g.strokeEllipse(0, 0, radius * 2, radius * 2 * squash);
      }
    }
    // rotation bead
    const beadA = (t / (p.rotateMs || 2400)) * Math.PI * 2 * dir;
    const beadC = p.beadColor ?? p.color;
    g.fillStyle(beadC, 1);
    g.fillCircle(Math.cos(beadA) * radius, Math.sin(beadA) * radius * squash, 3);
    g.fillStyle(beadC, 0.35);
    g.fillCircle(Math.cos(beadA) * radius, Math.sin(beadA) * radius * squash, 7);
  };

  const sync = (): void => {
    let x = target.x;
    let y: number;
    if (posMode === 'feet') y = footPosition(target).y + 4;
    else if (posMode === 'head') y = target.y - target.displayHeight * target.originY - 8;
    else y = midPosition(target).y;
    g.setPosition(x, y);
    draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// SATURN (two counter-rotating halos)
// ===========================================================================
function runSaturn(scene: Scene, target: EffectTarget, scale: number, args: unknown[]): EffectHandle {
  const [a, b] = args as [number, number];
  const h1 = runHalo(scene, target, scale, {
    color: a, radius: 38, thickness: 3, pos: 'mid', shape: 'ellipse',
    glow: true, rotateMs: 4800, tiltOscMs: 2400,
  });
  const h2 = runHalo(scene, target, scale, {
    color: b, radius: 28, thickness: 2, pos: 'mid', shape: 'ellipse',
    glow: true, rotateMs: 3600, tiltOscMs: 2000, reverse: true,
  });
  return {
    destroy: () => { h1.destroy(); h2.destroy(); },
    pulseHit: () => { h1.pulseHit?.(); h2.pulseHit?.(); },
    pulseMiss: () => { h1.pulseMiss?.(); h2.pulseMiss?.(); },
  };
}

// ===========================================================================
// GROUND PORTAL (radial spiral at feet)
// ===========================================================================
type PortalParams = { args: [number, number, number, number] };
function runPortal(scene: Scene, target: EffectTarget, scale: number, p: PortalParams): EffectHandle {
  const [core, ring, mid, pulse] = p.args ?? [0xa64dff, 0xd6b6ff, 0x8833dd, 0xff88cc];
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const portalR = 44 * scale;
    // background radial
    for (let step = 0; step < 20; step++) {
      const r = portalR * (step / 20);
      const alpha = 0.75 * (1 - step / 20);
      const col = step < 10 ? core : mid;
      g.fillStyle(col, alpha * 0.3);
      g.fillEllipse(0, 0, r * 2, r * 2 * 0.36);
    }
    // rotating spiral arms
    g.lineStyle(2, ring, 0.85);
    for (let arm = 0; arm < 3; arm++) {
      const armPhase = (arm / 3) * Math.PI * 2;
      g.beginPath();
      for (let a = 0; a <= Math.PI * 2; a += 0.1) {
        const r = (a / (Math.PI * 2)) * portalR;
        const angle = a + t / 1400 + armPhase;
        const px = Math.cos(angle) * r;
        const py = Math.sin(angle) * r * 0.36;
        if (a === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.strokePath();
    }
    // concentric pulses
    for (let i = 0; i < 3; i++) {
      const phase = ((t / 1500 + i / 3) % 1);
      const r = phase * portalR;
      g.lineStyle(2, pulse, (1 - phase) * 0.6);
      g.strokeEllipse(0, 0, r * 2, r * 2 * 0.36);
    }
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y + 2); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// RING OF DOTS (12 dots orbiting body mid) + emoji variant
// ===========================================================================
function runRingOfDots(scene: Scene, target: EffectTarget, scale: number, color: number | 'rainbow'): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const r = 38 * scale;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + t / 1500;
      const wobble = 1 + 0.1 * Math.sin(t / 200 + i);
      const px = Math.cos(a) * r * wobble;
      const py = Math.sin(a) * r * 0.4 * wobble;
      const dotColor = color === 'rainbow'
        ? Phaser.Display.Color.HSVToRGB(((i * 30 + t / 20) % 360) / 360, 0.95, 1).color as unknown as number
        : color;
      g.fillStyle(dotColor, 0.85);
      g.fillCircle(px, py, 4);
    }
  };
  const sync = (): void => {
    const p = midPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

function runRingEmoji(scene: Scene, target: EffectTarget, scale: number, glyph: string): EffectHandle {
  const texts: GameObjects.Text[] = [];
  for (let i = 0; i < 12; i++) {
    const t = scene.add.text(0, 0, glyph, {
      fontSize: `${Math.round(16 * scale)}px`, resolution: 0.42, padding: { x: 3, y: 4 },
    }).setOrigin(0.5).setDepth(target.depth - 1);
    t.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    texts.push(t);
  }
  const sync = (): void => {
    const p = midPosition(target);
    const r = 38 * scale;
    const now = scene.time.now;
    texts.forEach((tx, i) => {
      const a = (i / 12) * Math.PI * 2 + now / 1500;
      tx.setPosition(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r * 0.4);
    });
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return {
    destroy: () => {
      scene.events.off(Scenes.Events.POST_UPDATE, sync);
      texts.forEach(t => t.destroy());
    },
  };
}

// ===========================================================================
// ORBITER (emoji text orbiting sprite)
// ===========================================================================
type OrbiterParams = {
  glyph: string; count: number; radius: number; pos?: 'mid'|'head'|'feet';
  size?: number; speedMs?: number; flatten?: number;
};
function runOrbiter(scene: Scene, target: EffectTarget, scale: number, p: OrbiterParams): EffectHandle {
  const n = p.count ?? 5;
  const speedMs = p.speedMs ?? 2400;
  const flatten = p.flatten ?? 0.4;
  const sz = Math.round((p.size ?? 14) * scale);
  const texts: GameObjects.Text[] = [];
  for (let i = 0; i < n; i++) {
    const t = scene.add.text(0, 0, p.glyph, {
      fontSize: `${sz}px`, resolution: 0.42, padding: { x: 3, y: 4 },
    }).setOrigin(0.5).setDepth(target.depth - 1);
    t.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    texts.push(t);
  }
  const sync = (): void => {
    const posMode = p.pos ?? 'mid';
    let cx = target.x;
    let cy: number;
    if (posMode === 'feet') cy = footPosition(target).y;
    else if (posMode === 'head') cy = target.y - target.displayHeight * target.originY - 4;
    else cy = midPosition(target).y;
    const r = (p.radius ?? 32) * scale;
    const now = scene.time.now;
    texts.forEach((tx, i) => {
      const a = (now / speedMs) * Math.PI * 2 + (i / n) * Math.PI * 2;
      tx.setPosition(cx + Math.cos(a) * r, cy + Math.sin(a) * r * flatten);
    });
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return {
    destroy: () => {
      scene.events.off(Scenes.Events.POST_UPDATE, sync);
      texts.forEach(t => t.destroy());
    },
  };
}

// ===========================================================================
// PULSE (heart / sonar / echo / semicircle radio)
// ===========================================================================
type PulseParams = {
  color: number; maxR?: number; intervalMs?: number; lifeMs?: number;
  shape?: 'ring'|'heart'|'semicircle'; thickness?: number; pos?: 'feet'|'mid';
  flatness?: number; alpha?: number;
};
function runPulse(scene: Scene, target: EffectTarget, scale: number, p: PulseParams): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const pulses: { start: number }[] = [];
  let lastSpawn = -1e9;
  const interval = p.intervalMs ?? 900;
  const life = p.lifeMs ?? 1500;
  const maxR = (p.maxR ?? 44) * scale;
  const shape = p.shape ?? 'ring';
  const thickness = p.thickness ?? 3;
  const alphaBase = p.alpha ?? 0.85;
  const flatness = p.flatness ?? 0.32;

  const draw = (t: number): void => {
    g.clear();
    if (t - lastSpawn > interval) { pulses.push({ start: t }); lastSpawn = t; }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pu = pulses[i];
      const age = (t - pu.start) / life;
      if (age >= 1) { pulses.splice(i, 1); continue; }
      const r = maxR * age;
      const alpha = (1 - age) * alphaBase;
      g.lineStyle(thickness, p.color, alpha);
      if (shape === 'heart') {
        const sc = r / 30;
        g.beginPath();
        for (let a = 0; a <= Math.PI * 2; a += 0.1) {
          const hx = 16 * Math.pow(Math.sin(a), 3);
          const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
          const px = hx * sc, py = hy * sc;
          if (a === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.strokePath();
      } else if (shape === 'semicircle') {
        g.beginPath();
        g.arc(0, 0, r, Math.PI, 0);
        g.strokePath();
      } else {
        g.strokeEllipse(0, 0, r * 2, r * 2 * flatness);
      }
    }
  };
  const sync = (): void => {
    const pos = p.pos === 'mid' ? midPosition(target) : footPosition(target);
    g.setPosition(pos.x, pos.y);
    draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// TINT (color-cycle over sprite via setTint)
// ===========================================================================
type TintParams = { args: [string, number[]?, number?, number?] };
function runTint(scene: Scene, target: EffectTarget, scale: number, p: TintParams): EffectHandle {
  const [mode, colors, cycleMs = 2400, alphaScale = 1] = p.args as [string, number[] | undefined, number | undefined, number | undefined];
  const asSprite = target as unknown as GameObjects.Sprite;
  const setTintFn = (asSprite.setTint as unknown) as (c: number) => void;
  const clearTintFn = (asSprite.clearTint as unknown) as () => void;
  if (!setTintFn) return runFallback(scene, target, scale);

  const originalHasTint = !!(asSprite as any).tintTopLeft;
  const originalTint = originalHasTint ? (asSprite as any).tintTopLeft : 0xffffff;

  const applyTint = (): void => {
    const t = scene.time.now;
    if (mode === 'rainbow') {
      const hue = ((t / (cycleMs || 1200)) * 360) % 360;
      const rgb = Phaser.Display.Color.HSVToRGB(hue / 360, 0.95, 0.9);
      setTintFn.call(asSprite, (rgb as any).color);
    } else if (mode === 'strobe') {
      const phase = Math.floor(t / 120) % 2;
      setTintFn.call(asSprite, phase ? 0xffffff : originalTint);
    } else if (mode === 'inverted-flash') {
      const phase = (t / 1200) % 1;
      if (phase < 0.18) setTintFn.call(asSprite, 0x333333);
      else setTintFn.call(asSprite, 0xffffff);
    } else if (mode === 'flash' && colors) {
      const c = cycleColor(colors, t, cycleMs || 3600);
      setTintFn.call(asSprite, c);
    } else {
      setTintFn.call(asSprite, 0xffffff);
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, applyTint);
  applyTint();
  return {
    destroy: () => {
      scene.events.off(Scenes.Events.POST_UPDATE, applyTint);
      clearTintFn.call(asSprite);
    },
  };
}

// ===========================================================================
// LIGHTNING (colored, on dark background with strike flash)
// ===========================================================================
function runLightning(
  scene: Scene, target: EffectTarget, scale: number,
  glowRgb = '255,228,77', coreRgb = '255,255,255',
): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth + 1);
  const dark = scene.add.graphics().setDepth(target.depth - 1);
  type Strike = { untilT: number; main: [number, number][]; branches: [number, number][][] };
  const strikes: Strike[] = [];

  const buildBolt = (originX: number, originY: number): Strike => {
    const main: [number, number][] = [];
    let x = originX, y = originY - 200;
    main.push([x, y]);
    while (y < originY) {
      x += (Math.random() - 0.5) * 30;
      y += 8 + Math.random() * 14;
      main.push([x, y]);
    }
    const branches: [number, number][][] = [];
    const nB = 1 + Math.floor(Math.random() * 3);
    for (let b = 0; b < nB; b++) {
      const si = 1 + Math.floor(Math.random() * (main.length - 2));
      let [bx, by] = main[si];
      const branch: [number, number][] = [[bx, by]];
      const dir = Math.random() < 0.5 ? -1 : 1;
      const len = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < len; i++) {
        bx += dir * (8 + Math.random() * 16);
        by += 4 + Math.random() * 10;
        branch.push([bx, by]);
      }
      branches.push(branch);
    }
    return { untilT: scene.time.now + 150, main, branches };
  };

  const [gr, gg, gb] = glowRgb.split(',').map(n => parseInt(n));
  const [cr, cg, cb] = coreRgb.split(',').map(n => parseInt(n));
  const glowInt = (gr << 16) | (gg << 8) | gb;
  const coreInt = (cr << 16) | (cg << 8) | cb;

  const draw = (): void => {
    g.clear(); dark.clear();
    const t = scene.time.now;
    if (Math.random() < 0.09 && strikes.length < 4) {
      strikes.push(buildBolt(target.x, target.y));
    }
    // dark bg — smaller footprint, over the entire scene view
    dark.fillStyle(0x000000, 0.85);
    dark.fillRect(-1000, -1000, 3000, 3000);
    const hasLive = strikes.some(s => t <= s.untilT);
    const drawPath = (pts: [number, number][], gAlpha: number, gW: number, cAlpha: number): void => {
      g.lineStyle(gW, glowInt, gAlpha);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.strokePath();
      g.lineStyle(gW * 0.3, coreInt, cAlpha);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.strokePath();
    };
    for (let i = strikes.length - 1; i >= 0; i--) {
      const s = strikes[i];
      if (t > s.untilT) { strikes.splice(i, 1); continue; }
      drawPath(s.main, 0.6, 5, 0.95);
      for (const br of s.branches) drawPath(br, 0.45, 3, 0.7);
    }
    if (hasLive) {
      g.fillStyle(coreInt, 0.22);
      g.fillRect(-1000, -1000, 3000, 3000);
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, draw);
  draw();
  return {
    destroy: () => {
      scene.events.off(Scenes.Events.POST_UPDATE, draw);
      g.destroy(); dark.destroy();
    },
  };
}

// ===========================================================================
// PENTAGRAM (5-pointed star + double ring, dim-pulse cycle)
// ===========================================================================
function runPentagram(scene: Scene, target: EffectTarget, scale: number, color: number): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const r = 30 * scale;
    // Bright by default, brief dim pulse — matches the smoketest's
    // "dim-down beat" reading.
    const cyc = (t / 3000) % 1;
    const bright = cyc < 0.08 ? 0.4 : Math.min(1.0, 0.4 + (cyc - 0.08) * 6);
    const wobble = Math.sin(t / 2000) * 0.05;
    // Draw in flattened coords (scaleY 0.32) via manual point transform
    // since Phaser Graphics doesn't have save/scale/rotate stack.
    const flat = 0.32;
    // Star (5-point). Points at angles i*4/5 * 2π, rotated by -π/2 + wobble.
    const rot = -Math.PI / 2 + wobble;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) {
      const a = (i * 4 / 5) * Math.PI * 2 + rot;
      pts.push([Math.cos(a) * r, Math.sin(a) * r * flat]);
    }
    g.lineStyle(2.5, color, 0.95 * bright);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.strokePath();
    // Inner ring at r * 1.05
    g.strokeEllipse(0, 0, r * 2 * 1.05, r * 2 * flat * 1.05);
    // Outer glow ring at r * 1.15 with softer alpha + thicker stroke
    g.lineStyle(6, color, 0.4 * bright);
    g.strokeEllipse(0, 0, r * 2 * 1.15, r * 2 * flat * 1.15);
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

function runPentagramMulti(scene: Scene, target: EffectTarget, scale: number, colors: number[]): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const r = 30 * scale;
    const cyc = (t / 3000) % 1;
    const bright = cyc < 0.08 ? 0.4 : Math.min(1.0, 0.4 + (cyc - 0.08) * 6);
    const color = cycleColor(colors, t, 2000);
    const flat = 0.32;
    const rot = -Math.PI / 2 + Math.sin(t / 2000) * 0.05;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) {
      const a = (i * 4 / 5) * Math.PI * 2 + rot;
      pts.push([Math.cos(a) * r, Math.sin(a) * r * flat]);
    }
    g.lineStyle(2.5, color, 0.95 * bright);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.strokePath();
    g.strokeEllipse(0, 0, r * 2 * 1.05, r * 2 * flat * 1.05);
    g.lineStyle(6, color, 0.4 * bright);
    g.strokeEllipse(0, 0, r * 2 * 1.15, r * 2 * flat * 1.15);
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// MAGIC CIRCLE (dual ellipse + 8 radial spokes rotating)
// ===========================================================================
function runMagicCircle(scene: Scene, target: EffectTarget, scale: number, color: number, brightness = 0.75): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const r = 38 * scale;
    const flat = 0.32;
    const rot = t / 3000;
    g.lineStyle(2, color, brightness);
    g.strokeEllipse(0, 0, r * 2, r * 2 * flat);
    g.strokeEllipse(0, 0, r * 2 * 0.7, r * 2 * 0.7 * flat);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + rot;
      const ix = Math.cos(a) * r * 0.7, iy = Math.sin(a) * r * 0.7 * flat;
      const ox = Math.cos(a) * r, oy = Math.sin(a) * r * flat;
      g.beginPath(); g.moveTo(ix, iy); g.lineTo(ox, oy); g.strokePath();
    }
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

function runMagicCircleMulti(scene: Scene, target: EffectTarget, scale: number, colors: number[]): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const color = cycleColor(colors, t, 3000);
    const r = 38 * scale;
    const flat = 0.32;
    const rot = t / 3000;
    g.lineStyle(2, color, 0.85);
    g.strokeEllipse(0, 0, r * 2, r * 2 * flat);
    g.strokeEllipse(0, 0, r * 2 * 0.7, r * 2 * 0.7 * flat);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + rot;
      const ix = Math.cos(a) * r * 0.7, iy = Math.sin(a) * r * 0.7 * flat;
      const ox = Math.cos(a) * r, oy = Math.sin(a) * r * flat;
      g.beginPath(); g.moveTo(ix, iy); g.lineTo(ox, oy); g.strokePath();
    }
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// CIRCLE PATTERN (ring + inner shape — heart/star6/hexagon/triangle)
// ===========================================================================
function runCirclePattern(scene: Scene, target: EffectTarget, scale: number, shape: string, color: number): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const r = 32 * scale;
    const flat = 0.32;
    const cyc = (t / 3000) % 1;
    const bright = cyc < 0.08 ? 0.4 : Math.min(1.0, 0.4 + (cyc - 0.08) * 6);
    const rot = t / 4000;
    g.lineStyle(2, color, 0.85 * bright);
    g.strokeEllipse(0, 0, r * 2, r * 2 * flat);
    g.beginPath();
    const rotate = (x: number, y: number): [number, number] =>
      [x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)];
    if (shape === 'heart') {
      let first = true;
      for (let a = 0; a <= Math.PI * 2; a += 0.1) {
        const hx = 16 * Math.pow(Math.sin(a), 3);
        const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
        const [rx, ry] = rotate(hx * (r / 24), hy * (r / 24));
        if (first) { g.moveTo(rx, ry * flat); first = false; }
        else g.lineTo(rx, ry * flat);
      }
      g.closePath();
    } else if (shape === 'star6') {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2 + rot;
        const rr = (i % 2 === 0) ? r * 0.75 : r * 0.3;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr * flat;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    } else if (shape === 'hexagon') {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rot;
        const px = Math.cos(a) * r * 0.7, py = Math.sin(a) * r * 0.7 * flat;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    } else {
      // triangle
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2 + rot;
        const px = Math.cos(a) * r * 0.75, py = Math.sin(a) * r * 0.75 * flat;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    }
    g.strokePath();
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// SUN RAYS (16 rays rotating slowly outward, gradient approx via layered strokes)
// ===========================================================================
function parseRgba(s: string): [number, number, number, number] {
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
  if (!m) return [255, 255, 255, 1];
  return [parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!), m[4] ? parseFloat(m[4]) : 1];
}
function rgb2int(r: number, g: number, b: number): number { return (r << 16) | (g << 8) | b; }

function runSunRays(scene: Scene, target: EffectTarget, scale: number, innerRgba: string, outerRgba: string): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const [ir, ig, ib, ia] = parseRgba(innerRgba);
  const [or, og, ob, oa] = parseRgba(outerRgba);
  const innerInt = rgb2int(ir, ig, ib);
  const outerInt = rgb2int(or, og, ob);
  const rays = 16;
  const draw = (t: number): void => {
    g.clear();
    const rot = t / 4000;
    // Approximate the gradient: 3 layered strokes per ray — bright core near
    // center, mid-band, fade at tip.
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + rot;
      const len = (90 + 14 * Math.sin(t / 300 + i)) * scale;
      const c = Math.cos(a), s = Math.sin(a);
      // Layer 1: inner bright half
      g.lineStyle(5, innerInt, ia * 0.9);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(c * len * 0.35, s * len * 0.35);
      g.strokePath();
      // Layer 2: outer color mid → out
      g.lineStyle(5, outerInt, oa * 0.6);
      g.beginPath(); g.moveTo(c * len * 0.35, s * len * 0.35); g.lineTo(c * len * 0.85, s * len * 0.85);
      g.strokePath();
      g.lineStyle(5, outerInt, oa * 0.15);
      g.beginPath(); g.moveTo(c * len * 0.85, s * len * 0.85); g.lineTo(c * len, s * len);
      g.strokePath();
    }
  };
  const sync = (): void => {
    // Sun rays sit at body-mid so the rays radiate from the cat's core.
    const p = midPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// GOD RAYS (5 vertical light shafts, flickering)
// ===========================================================================
function runGodRays(scene: Scene, target: EffectTarget, scale: number, glowRgb: string, coreRgb: string): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const [gr, gg, gb] = glowRgb.split(',').map((n) => parseInt(n));
  const [cr, cg, cb] = coreRgb.split(',').map((n) => parseInt(n));
  const glowInt = rgb2int(gr, gg, gb);
  const coreInt = rgb2int(cr, cg, cb);
  const draw = (t: number): void => {
    g.clear();
    const centerX = target.x;
    const top = target.y - target.displayHeight * target.originY - 60 * scale;
    const bot = target.y + target.displayHeight * (1 - target.originY);
    for (let i = 0; i < 5; i++) {
      const offset = (-40 + i * 22) * scale;
      const flick = 0.55 + 0.45 * Math.sin(t / 220 + i * 1.3);
      const x = centerX + offset;
      // Trapezoid from narrow top to wide bottom, layered alpha for gradient
      // Layer 1 outer glow (wider)
      g.fillStyle(glowInt, 0.28 * flick);
      g.beginPath();
      g.moveTo(x - 6 * scale, top);
      g.lineTo(x + 6 * scale, top);
      g.lineTo(x + 22 * scale, bot);
      g.lineTo(x - 22 * scale, bot);
      g.closePath();
      g.fillPath();
      // Layer 2 core (narrower, brighter)
      g.fillStyle(coreInt, 0.45 * flick);
      g.beginPath();
      g.moveTo(x - 3 * scale, top);
      g.lineTo(x + 3 * scale, top);
      g.lineTo(x + 12 * scale, bot);
      g.lineTo(x - 12 * scale, bot);
      g.closePath();
      g.fillPath();
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
  draw(scene.time.now);
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
    g.destroy();
  });
}

// ===========================================================================
// SOUND BARS (14 vertical bars pulsing to sin waves)
// ===========================================================================
function runSoundBars(scene: Scene, target: EffectTarget, scale: number, hueBase: number): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const cx = target.x;
    const baseY = target.y + target.displayHeight * (1 - target.originY);
    const bars = 14;
    const maxH = 80 * scale;
    for (let i = 0; i < bars; i++) {
      const h = (Math.sin(t / 180 + i) * 0.5 + 0.6) * maxH;
      const a = i / bars - 0.5;
      const px = cx + a * 100 * scale;
      const hue = (hueBase + i * 8) / 360;
      const rgb = Phaser.Display.Color.HSVToRGB(hue, 0.85, 0.85);
      const c = (rgb as unknown as { color: number }).color;
      g.fillStyle(c, 0.9);
      g.fillRect(px - 3 * scale, baseY - h, 5 * scale, h);
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
  draw(scene.time.now);
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
    g.destroy();
  });
}

// ===========================================================================
// AURORA RIBBON (4 sine waves stacked at body-mid line)
// ===========================================================================
function runAuroraRibbon(scene: Scene, target: EffectTarget, scale: number, hues: number[]): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const cy = midPosition(target).y;
    const cx = target.x;
    // Span roughly ±140 px around target center — narrow enough to stay
    // "on the cat" rather than filling the whole scene.
    const span = 140 * scale;
    const x0 = cx - span, x1 = cx + span;
    for (let layer = 0; layer < 4; layer++) {
      const hueDeg = (hues[layer % hues.length] + t / 60) % 360;
      const rgb = Phaser.Display.Color.HSVToRGB(hueDeg / 360, 0.9, 0.6);
      const c = (rgb as unknown as { color: number }).color;
      g.lineStyle(6, c, 0.85);
      g.beginPath();
      for (let x = x0; x <= x1; x += 4) {
        const localX = x - cx;
        const y = cy + Math.sin(localX / 22 + t / 900 + layer) * 14 - layer * 4;
        if (x === x0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokePath();
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
  draw(scene.time.now);
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
    g.destroy();
  });
}

// ===========================================================================
// PIXEL RAIN (50 falling colored pixels)
// ===========================================================================
type PixelRainMode = 'gold' | 'red' | 'neon';
function runPixelRain(scene: Scene, target: EffectTarget, scale: number, mode: PixelRainMode = 'neon'): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth + 1);
  const N = 50;
  // Rain field spans roughly target width x2. Local coords centered on target.
  const spanX = 120 * scale;
  const spanY = 160 * scale;
  const drops = Array.from({ length: N }, () => ({
    x: (Math.random() - 0.5) * spanX * 2,
    y: (Math.random() - 0.5) * spanY,
    c: Math.random(),
  }));
  const draw = (t: number): void => {
    g.clear();
    const cx = target.x;
    const topY = target.y - target.displayHeight * target.originY - 60 * scale;
    const botY = target.y + target.displayHeight * (1 - target.originY);
    const yRange = botY - topY;
    for (const d of drops) {
      d.y += 1.4;
      if (d.y > yRange) { d.y -= yRange; d.x = (Math.random() - 0.5) * spanX * 2; }
      let c: number;
      if (mode === 'gold') c = 0xffdc50;
      else if (mode === 'red') c = 0xff5050;
      else {
        const rgb = Phaser.Display.Color.HSVToRGB(d.c, 0.95, 0.62);
        c = (rgb as unknown as { color: number }).color;
      }
      g.fillStyle(c, 0.95);
      g.fillRect(cx + Math.floor(d.x), topY + Math.floor(d.y), 4 * scale, 4 * scale);
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
  draw(scene.time.now);
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
    g.destroy();
  });
}

// ===========================================================================
// DISCO LINES (12 vertical color-cycling bars around cat)
// ===========================================================================
function runDiscoLines(scene: Scene, target: EffectTarget, scale: number, hueOffset: number): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const centerX = target.x;
    const footY = target.y + target.displayHeight * (1 - target.originY);
    const topY = target.y - target.displayHeight * target.originY - 40 * scale;
    const span = 140 * scale;
    const lines = 12;
    for (let i = 0; i < lines; i++) {
      const a = i / lines - 0.5;
      const px = centerX + a * span * 2;
      const hue = (t / 240 + i * 30 + hueOffset) % 360;
      const flick = 0.7 + 0.3 * Math.sin(t / 180 + i * 1.3);
      const rgb = Phaser.Display.Color.HSVToRGB(hue / 360, 0.85, 0.6);
      const c = (rgb as unknown as { color: number }).color;
      // Layered alpha strokes to approximate the top→bottom gradient
      g.fillStyle(c, 0.75 * flick);
      g.fillRect(px - 3, topY, 6, footY - topY);
      // Fade band at the top
      g.fillStyle(c, 0.3 * flick);
      g.fillRect(px - 3, topY - 30 * scale, 6, 30 * scale);
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
  draw(scene.time.now);
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
    g.destroy();
  });
}

// ===========================================================================
// GLITCH (random noise rects around cat)
// ===========================================================================
function runGlitch(scene: Scene, target: EffectTarget, scale: number, hueRange: [number, number]): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth + 1);
  const draw = (): void => {
    g.clear();
    const cx = target.x;
    const cyMid = midPosition(target).y;
    const spanX = 100 * scale, spanY = 90 * scale;
    for (let i = 0; i < 24; i++) {
      const rx = cx + (Math.random() - 0.5) * spanX * 2;
      const ry = cyMid + (Math.random() - 0.5) * spanY;
      const rw = 6 + Math.random() * 50 * scale;
      const rh = 1 + Math.random() * 5 * scale;
      let hue = hueRange[0] + Math.random() * (hueRange[1] - hueRange[0]);
      if (hue < 0) hue += 360;
      if (hue >= 360) hue -= 360;
      const rgb = Phaser.Display.Color.HSVToRGB(hue / 360, 0.9, 0.6);
      const c = (rgb as unknown as { color: number }).color;
      g.fillStyle(c, 0.7);
      g.fillRect(rx, ry, rw, rh);
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, draw);
  draw();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, draw);
    g.destroy();
  });
}

// ===========================================================================
// TELEPORT PAD (expanding squares on the floor)
// ===========================================================================
function runTeleportPad(scene: Scene, target: EffectTarget, scale: number, color: number, bright = false): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const flat = 0.32;
    const baseAlpha = bright ? 1.0 : 0.7;
    for (let i = 0; i < 5; i++) {
      const phase = ((t / 1400 + i / 5) % 1);
      const r = (14 + phase * 100) * scale;
      const alpha = (1 - phase) * baseAlpha;
      g.lineStyle(2, color, alpha);
      // Stroke a squished rect (Phaser Graphics has no scale stack). Just
      // approximate the flatten with two thin horizontal lines + two vertical.
      const w = r * 2, h = r * 2 * flat;
      g.strokeRect(-w / 2, -h / 2, w, h);
    }
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

function runTeleportMulti(scene: Scene, target: EffectTarget, scale: number, colors: number[]): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const flat = 0.32;
    for (let i = 0; i < 5; i++) {
      const phase = ((t / 1400 + i / 5) % 1);
      const r = (14 + phase * 100) * scale;
      const alpha = (1 - phase) * 0.7;
      const color = cycleColor(colors, t + i * 500, 2400);
      g.lineStyle(2, color, alpha);
      const w = r * 2, h = r * 2 * flat;
      g.strokeRect(-w / 2, -h / 2, w, h);
    }
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// ICE PUDDLE (chunky cyan tile pattern under the cat's feet)
// ===========================================================================
function runIcePuddle(scene: Scene, target: EffectTarget, scale: number): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const TILE = 4;
    const w = 78 * scale, h = 22 * scale;
    const halfW = w / 2, halfH = h / 2;
    const phase = Math.floor(t / 1400);
    for (let py = -halfH; py < halfH; py += TILE) {
      for (let px = -halfW; px < halfW; px += TILE) {
        const ex = px / halfW, ey = py / halfH;
        const dist = Math.sqrt(ex * ex + ey * ey);
        if (dist > 1) continue;
        const seed = ((px * 374761393) ^ (py * 668265263) ^ (phase * 2147483647)) >>> 0;
        const r = (seed % 100) / 100;
        let color: number;
        if (r < 0.15) color = 0xffffff;
        else if (r < 0.45) color = 0xb4f0ff;
        else color = 0x64d2ff;
        const alpha = 0.7 + (1 - dist) * 0.25;
        g.fillStyle(color, alpha);
        g.fillRect(px, py, TILE, TILE);
      }
    }
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// LAVA PUDDLE (sum-of-sines flow with 4-tone palette)
// ===========================================================================
function runLavaPuddle(scene: Scene, target: EffectTarget, scale: number, palette: number[][]): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const colors = palette.map(([r, gg, b]) => rgb2int(r, gg, b));
  const draw = (t: number): void => {
    g.clear();
    const TILE = 4;
    const w = 92 * scale, h = 30 * scale;
    const halfW = w / 2, halfH = h / 2;
    for (let py = -halfH; py < halfH; py += TILE) {
      for (let px = -halfW; px < halfW; px += TILE) {
        const ex = px / halfW, ey = py / halfH;
        const dist = Math.sqrt(ex * ex + ey * ey);
        if (dist > 1) continue;
        const w1 = Math.sin(px * 0.10 + py * 0.06 + t / 900);
        const w2 = Math.sin(px * 0.22 - py * 0.15 + t / 1400 + 1.7);
        const w3 = Math.sin(px * 0.06 + py * 0.20 + t / 1800 + 0.4);
        const jitter = (((px * 374761393) ^ (py * 668265263)) >>> 0) % 100 / 100 - 0.5;
        const flow = (w1 + w2 + w3) / 3 + jitter * 0.2;
        const heat = (flow + 1) / 2 + (1 - dist) * 0.18;
        let color: number;
        if (heat > 1.05) color = colors[3];
        else if (heat > 0.78) color = colors[2];
        else if (heat > 0.45) color = colors[1];
        else color = colors[0];
        const alpha = 0.85 + (1 - dist) * 0.15;
        g.fillStyle(color, alpha);
        g.fillRect(px, py, TILE, TILE);
      }
    }
  };
  const sync = (): void => {
    const p = footPosition(target); g.setPosition(p.x, p.y); draw(scene.time.now);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// PILLARS MULTI (vertical color pillars around cat)
// ===========================================================================
function runPillarsMulti(scene: Scene, target: EffectTarget, scale: number, colors: number[]): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const cx = target.x;
    const footY = target.y + target.displayHeight * (1 - target.originY);
    const topY = target.y - target.displayHeight * target.originY - 40 * scale;
    for (let idx = 0; idx < 4; idx++) {
      const xo = (-54 + 36 * idx) * scale;
      const flicker = 0.7 + 0.3 * Math.sin(t / 60 + xo * 0.1);
      const c = colors[idx % colors.length];
      g.fillStyle(c, 0.65 * flicker);
      g.fillRect(cx + xo - 4 * scale, topY, 8 * scale, footY - topY);
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
  draw(scene.time.now);
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
    g.destroy();
  });
}

// ===========================================================================
// STAR CIRCLE MULTI (6 stars orbiting with color cycle)
// ===========================================================================
function runStarCircleMulti(scene: Scene, target: EffectTarget, scale: number, colors: number[]): EffectHandle {
  const N = 6;
  const texts: GameObjects.Text[] = [];
  for (let i = 0; i < N; i++) {
    const t = scene.add.text(0, 0, '⭐', {
      fontSize: `${Math.round(14 * scale)}px`, resolution: 0.42, padding: { x: 3, y: 4 },
    }).setOrigin(0.5).setDepth(target.depth - 1);
    t.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    texts.push(t);
  }
  const sync = (): void => {
    const p = midPosition(target);
    const r = 34 * scale;
    const now = scene.time.now;
    const color = cycleColor(colors, now, 3000);
    texts.forEach((tx, i) => {
      const a = (now / 2400) * Math.PI * 2 + (i / N) * Math.PI * 2;
      tx.setPosition(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r * 0.4);
      tx.setTint(color);
    });
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return {
    destroy: () => {
      scene.events.off(Scenes.Events.POST_UPDATE, sync);
      texts.forEach((t) => t.destroy());
    },
  };
}

// ===========================================================================
// CONSTELLATION (12 twinkling dots + connecting lines)
// ===========================================================================
function runConstellation(scene: Scene, target: EffectTarget, scale: number): EffectHandle {
  const POOL = 12;
  const RANGE = 45;
  const dots = Array.from({ length: POOL }, () => ({
    dx: -RANGE + Math.random() * RANGE * 2,
    dy: -RANGE + Math.random() * RANGE * 2,
    period: 4400 + Math.random() * 2600,
    phaseOffset: Math.random(),
  }));
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const draw = (t: number): void => {
    g.clear();
    const cx = target.x;
    const cy = target.y - target.displayHeight * (target.originY - 0.5) - target.displayHeight * 0.15;
    const rot = t / 5000;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const live = dots.map((d, i) => {
      const phase = ((t / d.period) + d.phaseOffset) % 1;
      let alpha = 0;
      if (phase < 0.2) alpha = phase / 0.2;
      else if (phase < 0.6) alpha = 1;
      else alpha = 1 - (phase - 0.6) / 0.4;
      if (alpha < 0.02 && i % 3 === Math.floor(t / 600) % 3) {
        d.dx = -RANGE + Math.random() * RANGE * 2;
        d.dy = -RANGE + Math.random() * RANGE * 2;
      }
      const sx = d.dx * cosR - d.dy * sinR;
      const sy = d.dx * sinR + d.dy * cosR;
      return { x: cx + sx * scale, y: cy + sy * scale * 0.6, alpha };
    });
    const visible = live.filter((d) => d.alpha > 0.3);
    for (let i = 0; i < visible.length; i++) {
      let bestJ = -1, bestD = Infinity;
      for (let j = i + 1; j < visible.length; j++) {
        const dx = visible[i].x - visible[j].x;
        const dy = visible[i].y - visible[j].y;
        const dd = dx * dx + dy * dy;
        if (dd < bestD) { bestD = dd; bestJ = j; }
      }
      if (bestJ >= 0 && bestD < 4500) {
        const avg = Math.min(visible[i].alpha, visible[bestJ].alpha);
        g.lineStyle(2.5, 0xdcebff, avg * 0.7);
        g.beginPath();
        g.moveTo(visible[i].x, visible[i].y);
        g.lineTo(visible[bestJ].x, visible[bestJ].y);
        g.strokePath();
      }
    }
    for (const d of live) {
      if (d.alpha < 0.02) continue;
      g.fillStyle(0xffffff, d.alpha);
      g.fillCircle(d.x, d.y, 3.5 * scale);
      g.fillStyle(0xffffff, 0.25 * d.alpha);
      g.fillCircle(d.x, d.y, 6 * scale);
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
  draw(scene.time.now);
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
    g.destroy();
  });
}

// ===========================================================================
// WEATHER (snow / rain / wind / stars / dust / fog particle streams)
// ===========================================================================
function runWeather(scene: Scene, target: EffectTarget, scale: number, mode: string): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth + 1);
  const centerX = target.x;
  const topY = target.y - target.displayHeight * target.originY - 60 * scale;
  const botY = target.y + target.displayHeight * (1 - target.originY);
  const spanX = 160 * scale;
  const N = mode === 'rain' ? 60 : mode === 'wind' ? 44 : mode === 'dust' ? 130 : mode === 'stars' ? 120 : 48;
  type Particle = { x: number; y: number; spd: number; drift: number; sz: number };
  const items: Particle[] = Array.from({ length: N }, () => ({
    x: (Math.random() - 0.5) * spanX * 2,
    y: Math.random() * (botY - topY),
    spd: 0.4 + Math.random() * 0.8,
    drift: (Math.random() - 0.5) * 0.3,
    sz: 1 + Math.random() * 2,
  }));
  const draw = (t: number): void => {
    g.clear();
    const yRange = botY - topY;
    for (const it of items) {
      if (mode !== 'wind') {
        const speed = mode === 'rain' ? 4 : mode === 'snow' ? 1.6 : mode === 'dust' ? 0.5 : 0.2;
        it.y += it.spd * speed;
        it.x += it.drift;
        if (it.y > yRange) { it.y -= yRange; it.x = (Math.random() - 0.5) * spanX * 2; }
        if (it.x < -spanX) it.x = spanX;
        if (it.x > spanX) it.x = -spanX;
      } else {
        it.x += 2;
        it.y += 0.8;
        if (it.x > spanX + 20) {
          it.x = -spanX - 20;
          it.y = Math.random() * yRange * (Math.random() < 0.7 ? 0.55 : 1);
        }
      }
      const drawX = centerX + it.x;
      const drawY = topY + it.y;
      if (mode === 'snow') {
        g.fillStyle(0xffffff, 0.5 + 0.5 * Math.sin(t / 300 + it.x));
        g.fillCircle(drawX, drawY, it.sz);
      } else if (mode === 'rain') {
        g.lineStyle(2, 0x8cb4ff, 0.85);
        g.beginPath(); g.moveTo(drawX, drawY); g.lineTo(drawX + 2, drawY + 14); g.strokePath();
      } else if (mode === 'wind') {
        g.lineStyle(1.5, 0xc8d2ff, 0.55 + 0.3 * Math.sin(t / 400 + it.x));
        g.beginPath(); g.moveTo(drawX, drawY); g.lineTo(drawX + 26, drawY + 10); g.strokePath();
      } else if (mode === 'fog') {
        g.fillStyle(0xdcdcf0, 0.06 + 0.04 * Math.sin(t / 600 + it.x));
        g.fillEllipse(drawX, drawY, 28, 8);
      } else if (mode === 'dust') {
        g.fillStyle(0xfff0b4, 0.5 + 0.3 * Math.sin(t / 500 + it.x));
        g.fillRect(drawX, drawY, 2, 2);
      } else {
        g.fillStyle(0xffffff, 0.7 + 0.3 * Math.sin(t / 800 + it.x));
        g.fillRect(drawX, drawY, 2, 2);
      }
    }
  };
  scene.events.on(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
  draw(scene.time.now);
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, () => draw(scene.time.now));
    g.destroy();
  });
}

// ===========================================================================
// FALLBACK (soft colored aura for kinds not yet fully implemented)
// ===========================================================================
function runFallback(scene: Scene, target: EffectTarget, scale: number, color = 0xa64dff): EffectHandle {
  const g = scene.add.graphics().setDepth(target.depth - 1);
  const sync = (): void => {
    g.clear();
    const p = footPosition(target);
    g.setPosition(p.x, p.y);
    g.fillStyle(color, 0.25);
    g.fillCircle(0, -40 * scale, 30 * scale);
    g.fillStyle(color, 0.14);
    g.fillCircle(0, -40 * scale, 50 * scale);
  };
  scene.events.on(Scenes.Events.POST_UPDATE, sync);
  sync();
  return withPulse(scene, g, () => {
    scene.events.off(Scenes.Events.POST_UPDATE, sync);
    g.destroy();
  });
}

// ===========================================================================
// PULSE HIT/MISS mixin — every runX above wraps final teardown through this
// ===========================================================================
function withPulse(scene: Scene, g: GameObjects.Graphics, destroyFn: () => void): EffectHandle {
  g.alpha = REST_INTENSITY;
  let pulseT: Tweens.Tween | null = null;
  let decayT: Tweens.Tween | null = null;
  const pulseTo = (peak: number): void => {
    pulseT?.stop(); decayT?.stop();
    pulseT = scene.tweens.add({
      targets: g, alpha: peak, duration: 80, ease: 'Quad.easeOut',
      onComplete: () => {
        decayT = scene.tweens.add({
          targets: g, alpha: REST_INTENSITY,
          duration: PULSE_DECAY_MS, ease: 'Sine.easeOut',
        });
      },
    });
  };
  return {
    destroy: () => {
      pulseT?.stop(); pulseT?.remove();
      decayT?.stop(); decayT?.remove();
      destroyFn();
    },
    pulseHit: () => pulseTo(HIT_INTENSITY),
    pulseMiss: () => pulseTo(MISS_INTENSITY),
  };
}

// ===========================================================================
// DISPATCH — kind → run function
// ===========================================================================
export function runKind(
  meta: EffectMeta,
  scene: Scene,
  target: EffectTarget,
  scale: number,
): EffectHandle {
  const params = meta.impl.params as Record<string, unknown>;
  switch (meta.impl.kind) {
    case 'stagelight': {
      const colors = (params.colors as number[]) ?? [0xffe44d];
      const cycleMs = (params.cycleMs as number) ?? 2400;
      return runStagelight(scene, target, scale, colors, cycleMs);
    }
    case 'stagelight_split': {
      const colors = (params.colors as number[]) ?? [0xff3333, 0x3399ff];
      return runStagelightSplit(scene, target, scale, colors);
    }
    case 'halo':
      return runHalo(scene, target, scale, params as unknown as HaloParams);
    case 'halo_saturn':
      return runSaturn(scene, target, scale, (params.args as unknown[]) ?? []);
    case 'halo_portal':
      return runPortal(scene, target, scale, params as unknown as PortalParams);
    case 'halo_ring_of_dots':
      return runRingOfDots(scene, target, scale, 0xff8833);
    case 'halo_ring_emoji':
      return runRingEmoji(scene, target, scale, (params.glyph as string) ?? '🔥');
    case 'orbiter':
      return runOrbiter(scene, target, scale, params as unknown as OrbiterParams);
    case 'pulse':
    case 'sonar_pro':
    case 'sonar_pro_multi':
    case 'heart_multi':
    case 'radio_multi':
      return runPulse(scene, target, scale, params as unknown as PulseParams);
    case 'tint':
      return runTint(scene, target, scale, params as unknown as TintParams);
    case 'lightning_colored': {
      const args = (params.args as unknown[]) ?? [];
      return runLightning(scene, target, scale, (args[0] as string), (args[1] as string));
    }
    // ---------- ported from the smoketest canvas renders ----------
    case 'pentagram': {
      // params: { color } — kept ID-scoped for the shipped 6 variants.
      const color = (params.color as number) ?? colorFromId(meta.id, 0xff3333);
      return runPentagram(scene, target, scale, color);
    }
    case 'pentagram_multi': {
      const colors = (params.colors as number[]) ?? [0xff3333, 0xffd34d];
      return runPentagramMulti(scene, target, scale, colors);
    }
    case 'magic_circle': {
      const color = (params.color as number) ?? colorFromId(meta.id, 0xa64dff);
      return runMagicCircle(scene, target, scale, color);
    }
    case 'magic_circle_bright': {
      const color = (params.color as number) ?? colorFromId(meta.id, 0xa64dff);
      return runMagicCircle(scene, target, scale, color, 1.0);
    }
    case 'magic_circle_multi': {
      const palette = (params.palette as number[]) ?? (params.colors as number[]) ?? [0xff3333, 0x33ff66, 0x3399ff];
      return runMagicCircleMulti(scene, target, scale, palette);
    }
    case 'circle_pattern': {
      const args = (params.args as unknown[]) ?? ['star6', 0xffd34d];
      return runCirclePattern(scene, target, scale, args[0] as string, args[1] as number);
    }
    case 'sun_rays': {
      const args = (params.args as unknown[]) ?? ['rgba(255,240,180,1)', 'rgba(255,220,110,0.85)'];
      return runSunRays(scene, target, scale, args[0] as string, args[1] as string);
    }
    case 'god_rays': {
      const args = (params.args as unknown[]) ?? ['255,255,235', '255,240,160'];
      // The extractor sometimes splits comma-separated RGB triples into
      // multiple positional args — recombine when we see 6 slots.
      let glow: string, core: string;
      if (args.length >= 6) {
        glow = `${args[0]},${args[1]},${String(args[2]).replace(/'$/, '')}`;
        core = `${args[3]},${args[4]},${String(args[5]).replace(/'$/, '')}`;
      } else {
        glow = args[0] as string; core = args[1] as string;
      }
      return runGodRays(scene, target, scale, glow, core);
    }
    case 'sound_bars': {
      const hueBase = (params.hueBase as number) ?? 280;
      return runSoundBars(scene, target, scale, hueBase);
    }
    case 'aurora_ribbon': {
      const hues = (params.hues as number[]) ?? [120, 170, 220, 270];
      return runAuroraRibbon(scene, target, scale, hues);
    }
    case 'pixel_rain': {
      const cf = (params.colorFn as string) ?? 'neon';
      return runPixelRain(
        scene, target, scale,
        cf.includes('gold') ? 'gold' : cf.includes('red') ? 'red' : 'neon',
      );
    }
    case 'disco_lines': {
      const hueOffset = (params.hueOffset as number) ?? 0;
      return runDiscoLines(scene, target, scale, hueOffset);
    }
    case 'glitch': {
      const range = (params.hueRange as number[]) ?? [0, 360];
      return runGlitch(scene, target, scale, [range[0], range[1]]);
    }
    case 'teleport_pad': {
      const args = (params.args as unknown[]) ?? [0x33ffe6];
      return runTeleportPad(scene, target, scale, args[0] as number);
    }
    case 'teleport_bright': {
      const args = (params.args as unknown[]) ?? [0x33ffe6];
      return runTeleportPad(scene, target, scale, args[0] as number, /* bright */ true);
    }
    case 'teleport_multi': {
      const palette = (params.palette as number[]) ?? (params.colors as number[]) ?? [0xff3333, 0xffd34d, 0x33ffe6];
      return runTeleportMulti(scene, target, scale, palette);
    }
    case 'ice_puddle':
      return runIcePuddle(scene, target, scale);
    case 'lava_puddle': {
      const palette = (params.colors as number[][]) ??
        [[80, 20, 20], [180, 60, 20], [255, 140, 40], [255, 240, 120]];
      return runLavaPuddle(scene, target, scale, palette);
    }
    case 'pillars_multi': {
      const colors = (params.colors as number[]) ?? [0xff3333, 0x33ff66, 0x3399ff, 0xffd34d];
      return runPillarsMulti(scene, target, scale, colors);
    }
    case 'star_circle_multi': {
      const palette = (params.palette as number[]) ?? (params.colors as number[]) ?? [0xffd34d, 0x33ffe6, 0xff66cc];
      return runStarCircleMulti(scene, target, scale, palette);
    }
    case 'constellation':
      return runConstellation(scene, target, scale);
    case 'custom_mkWeather': {
      const args = (params.args as unknown[]) ?? ['snow'];
      return runWeather(scene, target, scale, String(args[0] ?? 'snow'));
    }
    default:
      // Fallback color derived from category so at least each category has
      // a distinct look until we implement the kind properly.
      return runFallback(scene, target, scale, catFallbackColor(meta.category));
  }
}

/** Best-guess color for kinds where the extractor lost the param — reads
 *  the color hint out of the effect id (e.g. 'effect-floor-pentagram-gold'
 *  → gold). Keeps the shipped variants visually distinct even when the
 *  params object is empty. */
function colorFromId(id: string, fallback: number): number {
  if (id.includes('gold')) return 0xffd34d;
  if (id.includes('purple') || id.includes('void')) return 0xa64dff;
  if (id.includes('cyan') || id.includes('ice')) return 0x33ffe6;
  if (id.includes('red')) return 0xff3333;
  if (id.includes('blue')) return 0x3399ff;
  if (id.includes('green')) return 0x33ff66;
  if (id.includes('pink') || id.includes('magenta')) return 0xff66cc;
  if (id.includes('orange')) return 0xff8833;
  if (id.includes('white') || id.includes('silver')) return 0xf0f0ff;
  return fallback;
}

function catFallbackColor(category: string): number {
  switch (category) {
    case 'Beams': return 0xffe44d;
    case 'Pulse Waves': return 0xff66cc;
    case 'Floor / Ground': return 0xa64dff;
    case 'Weather': return 0x66ccff;
    case 'Decorative': return 0xffffff;
    case 'Misc / Extras': return 0x33ffe6;
    default: return 0xa64dff;
  }
}

// Convert an EffectMeta from the generated catalog into a CatEffect the rest
// of the runtime can consume identically to the hand-authored entries.
export function makeCatEffectFromMeta(meta: EffectMeta): CatEffect {
  return {
    id: meta.id,
    name: meta.name,
    iconEmoji: meta.iconEmoji,
    rarity: meta.rarity,
    apply(scene, target, scale = 1) {
      return runKind(meta, scene, target, scale);
    },
    burst(scene, target, scale = 1) {
      // Reuse the apply's first ~200 ms for a light burst feel — most of the
      // meta-driven effects don't need a distinct burst pattern.
      const h = runKind(meta, scene, target, scale);
      scene.time.delayedCall(220, () => h.destroy());
    },
  };
}
