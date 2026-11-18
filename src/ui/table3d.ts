// 3D の場：札の置き場所・動き・カメラ・演出・タップの判定
import { CARDS } from '../game/cards';
import type { Ev, Player } from '../game/koikoi';
import type { View } from '../game/view';
import { BACK, atlas } from './art';
import { CH, CW, Stage, type CardDraw, type HaloDraw } from './gl/stage';
import { lookAt, model, mul, persp, project, qAxis, qEuler, qMul, qSlerp, type Mat4, type Quat, type Vec3 } from './gl/math';

interface Pose { p: Vec3; q: Quat; s: number }
interface Tween { from: Pose; to: Pose; t0: number; dur: number; arc: number; spin: number }
interface Obj { key: string; face: number; cur: Pose; tween: Tween | null; target: Pose; phase: number; flash: number }

export interface Interaction {
  pickable: Set<number>; // 押せる札（手札・場）
  selected: number | null; // 選んでいる手札
  targets: Set<number>; // 光らせる場札
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const KIND_ORDER = { hikari: 0, tane: 1, tan: 2, kasu: 3 } as const;

const FACE_UP: Quat = qAxis([1, 0, 0], -Math.PI / 2);
const FACE_DOWN: Quat = qMul(qAxis([0, 1, 0], Math.PI), qAxis([1, 0, 0], Math.PI / 2));

// 画面の縦横で置き方を変える
interface Layout {
  eye: Vec3; at: Vec3; fov: number;
  field: (i: number) => Vec3; fieldSlots: number;
  deck: Vec3;
  hand: (i: number, n: number) => Vec3; handTilt: number; handScale: number;
  opp: (i: number, n: number) => Vec3; oppScale: number;
  cap: (who: 0 | 1, group: number, i: number, n: number) => Vec3; capScale: number;
  reveal: Vec3; spot: (i: number, n: number) => Vec3;
}
function layoutFor(aspect: number): Layout {
  if (aspect >= 1.05) {
    return {
      eye: [0, 11.2, 8.6], at: [0, 0, 0.7], fov: 0.72,
      field: (i) => { const col = [4, 3, 5, 2, 6, 1, 7, 0, 8][Math.floor(i / 2) % 9]; return [(col - 4) * 1.22, 0.25, ((i % 2) - 0.5) * 1.9 + (i >= 18 ? 0.3 : 0)]; }, fieldSlots: 18,
      deck: [-6.9, 0.1, 0],
      hand: (i, n) => [(i - (n - 1) / 2) * 1.18, 1.0, 4.35], handTilt: 0.95, handScale: 1.05,
      opp: (i, n) => [(i - (n - 1) / 2) * 0.62, 0.15, -4.4], oppScale: 0.6,
      cap: (who, g, i, n) => { const step = Math.min(0.3, 2.9 / Math.max(1, n)); return [-6.3 + g * 3.65 + i * step, 0.12 + i * 0.004, who === 0 ? 2.75 : -2.75]; }, capScale: 0.5,
      reveal: [0, 4.2, 3.2], spot: (i, n) => [(i - (n - 1) / 2) * Math.min(1.35, 10 / n), 3.6, 2.2],
    };
  }
  return {
    eye: [0, 17, 6.6], at: [0, 0, 0.35], fov: 0.92,
    field: (i) => { const row = [1, 2, 0, 3, 4][Math.floor(i / 4) % 5]; return [((i % 4) - 1.5) * 1.22, 0.25, (row - 1.5) * 1.75]; }, fieldSlots: 20,
    deck: [3.6, 0.1, -5.7],
    hand: (i, n) => [(i - (n - 1) / 2) * Math.min(1.0, 6.9 / Math.max(1, n)), 1.3, 6.0], handTilt: 1.0, handScale: 0.92,
    opp: (i, n) => [-0.9 + (i - (n - 1) / 2) * 0.5, 0.15, -5.7], oppScale: 0.55,
    cap: (who, g, i, n) => { const step = Math.min(0.22, 1.6 / Math.max(1, n)); return [-4.0 + g * 2.15 + i * step, 0.12 + i * 0.004, who === 0 ? 4.15 : -4.15]; }, capScale: 0.42,
    reveal: [0, 6.0, 3.0], spot: (i, n) => [(i - (n - 1) / 2) * Math.min(1.5, 8 / n), 6.5, 3.2],
  };
}

export class Table3D {
  readonly canvas: HTMLCanvasElement;
  private stage: Stage;
  private objs: Obj[] = [];
  private byKey = new Map<string, Obj>();
  // 見えている置き場所
  private hand: number[] = [];
  private oppHand: string[] = [];
  private field: (string | null)[] = [];
  private deck: string[] = [];
  private cap: [string[], string[]] = [[], []];
  private reveal: string | null = null;
  private spot: string[] = [];
  private me: Player = 0;
  private L: Layout = layoutFor(1.6);
  private vp: Mat4 = [];
  private eye: Vec3 = [0, 10, 8];
  private t = 0;
  private raf = 0;
  private shake = 0;
  private zoom = 0; // 0〜1：寄る
  private zoomTo = 0;
  private uid = 0;
  // 演出の状態
  tint: Vec3 = [0.25, 0.55, 1.0];
  private tintTo: Vec3 = [0.25, 0.55, 1.0];
  cheer = 0;
  private burst = -99;
  private pulse = -99;
  private inter: Interaction = { pickable: new Set(), selected: null, targets: new Set() };
  onPick: (id: number) => void = () => {};
  private queue: Promise<void> = Promise.resolve();
  private seenRound = 0;
  private seenEvents = 0;
  speed = 1; // 1 で通常、0 に近いほど速い（テスト用）

  static create(): Table3D | null {
    const canvas = document.createElement('canvas');
    canvas.className = 'stage';
    const stage = Stage.create(canvas, atlas());
    return stage ? new Table3D(canvas, stage) : null;
  }

  private constructor(canvas: HTMLCanvasElement, stage: Stage) {
    this.canvas = canvas;
    this.stage = stage;
    for (let i = 0; i < 48; i++) {
      const pose: Pose = { p: [0, 0.1 + i * 0.01, 0], q: FACE_DOWN, s: 1 };
      const o: Obj = { key: `u${this.uid++}`, face: BACK, cur: pose, target: pose, tween: null, phase: i * 0.7, flash: 0 };
      this.objs.push(o);
      this.byKey.set(o.key, o);
    }
    canvas.addEventListener('pointerdown', (e) => this.pick(e));
    const loop = (ms: number) => { this.frame(ms / 1000); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() { cancelAnimationFrame(this.raf); this.canvas.remove(); }

  setInteraction(i: Interaction) { this.inter = i; this.place(0.18); }
  setMood(kind: 'normal' | 'final' | 'cheer') { this.tintTo = kind === 'final' ? [1.0, 0.22, 0.25] : kind === 'cheer' ? [1.0, 0.75, 0.25] : [0.25, 0.55, 1.0]; }
  doBurst() { this.burst = this.t; this.shake = 0.35; }
  doPulse() { this.pulse = this.t; }

  // ---------- 置き場所 ----------
  private rename(o: Obj, key: string, face: number) { this.byKey.delete(o.key); o.key = key; o.face = face; this.byKey.set(key, o); }
  private obj(id: number) { return this.byKey.get(`c${id}`); }

  // 見え方に合わせて置き場所を作り直す（足りない札は、伏せた札から割り当てる）
  private rebuild(v: View) {
    const known = new Set<number>([...v.hand, ...v.field, ...v.captured[0], ...v.captured[1], ...(v.pendingDraw != null ? [v.pendingDraw] : [])]);
    const free = this.objs.filter((o) => !(o.key.startsWith('c') && known.has(o.face)));
    for (const id of known) if (!this.obj(id)) this.rename(free.shift()!, `c${id}`, id);
    for (const o of free) this.rename(o, `u${this.uid++}`, BACK);
    const unknown = free.map((o) => o.key);
    this.me = v.me;
    this.hand = [...v.hand];
    this.oppHand = unknown.slice(0, v.oppHand);
    this.deck = unknown.slice(v.oppHand, v.oppHand + v.deck);
    const keep = this.field.map((k) => (k && v.field.includes(Number(k.slice(1))) && k.startsWith('c') ? k : null));
    for (const id of v.field) if (!keep.includes(`c${id}`)) { const i = keep.indexOf(null); if (i >= 0) keep[i] = `c${id}`; else keep.push(`c${id}`); }
    this.field = keep;
    this.cap = [v.captured[0].map((id) => `c${id}`), v.captured[1].map((id) => `c${id}`)];
    this.reveal = v.pendingDraw != null && v.phase === 'drawChoose' ? `c${v.pendingDraw}` : null;
  }

  private facing(p: Vec3): Quat {
    const dy = this.eye[1] - p[1], dz = this.eye[2] - p[2];
    return qAxis([1, 0, 0], -Math.atan2(dy, dz));
  }

  // それぞれの札の行き先を決め、変わったものは動かす
  private place(dur = 0.45, stagger = 0) {
    const L = this.L;
    const want = new Map<string, Pose>();
    const fieldN = this.field.length;
    this.field.forEach((k, i) => { if (k) want.set(k, { p: L.field(i % Math.max(L.fieldSlots, fieldN)), q: FACE_UP, s: 1 }); });
    this.deck.forEach((k, i) => want.set(k, { p: [L.deck[0], L.deck[1] + i * 0.02, L.deck[2]], q: FACE_DOWN, s: 1 }));
    const tilt = qAxis([1, 0, 0], -Math.PI / 2 + L.handTilt);
    this.hand.forEach((id, i) => {
      const p = L.hand(i, this.hand.length);
      const sel = this.inter.selected === id;
      want.set(`c${id}`, { p: [p[0], p[1] + (sel ? 0.55 : 0), p[2] - (sel ? 0.5 : 0)], q: tilt, s: L.handScale * (sel ? 1.08 : 1) });
    });
    this.oppHand.forEach((k, i) => want.set(k, { p: L.opp(i, this.oppHand.length), q: FACE_DOWN, s: L.oppScale }));
    for (const who of [0, 1] as const) {
      const groups: string[][] = [[], [], [], []];
      for (const k of this.cap[who]) groups[KIND_ORDER[CARDS[Number(k.slice(1))].kind]].push(k);
      groups.forEach((g, gi) => g.sort().forEach((k, i) => {
        const side = who === this.me ? 0 : 1;
        want.set(k, { p: L.cap(side, gi, i, g.length), q: FACE_UP, s: L.capScale });
      }));
    }
    if (this.reveal) want.set(this.reveal, { p: L.reveal, q: this.facing(L.reveal), s: 1.5 });
    this.spot.forEach((k, i) => { const p = L.spot(i, this.spot.length); want.set(k, { p, q: this.facing(p), s: 1.1 }); });
    let n = 0;
    for (const o of this.objs) {
      const w = want.get(o.key);
      if (!w) continue;
      const d = Math.hypot(w.p[0] - o.target.p[0], w.p[1] - o.target.p[1], w.p[2] - o.target.p[2]) + Math.abs(w.s - o.target.s) + (1 - Math.abs(w.q[0] * o.target.q[0] + w.q[1] * o.target.q[1] + w.q[2] * o.target.q[2] + w.q[3] * o.target.q[3]));
      if (d < 1e-4) continue;
      const from = this.poseNow(o);
      const dist = Math.hypot(w.p[0] - from.p[0], w.p[2] - from.p[2]);
      o.tween = { from, to: w, t0: this.t + stagger * n++ * this.speed, dur: Math.max(0.05, dur * this.speed), arc: dur > 0.2 ? Math.min(2.2, 0.3 + dist * 0.18) : 0, spin: 0 };
      o.target = w;
    }
  }

  private poseNow(o: Obj): Pose {
    const tw = o.tween;
    if (!tw) return o.cur;
    const k = Math.min(1, Math.max(0, (this.t - tw.t0) / tw.dur));
    const e = ease(k);
    const p = lerp3(tw.from.p, tw.to.p, e);
    p[1] += Math.sin(k * Math.PI) * tw.arc;
    let q = qSlerp(tw.from.q, tw.to.q, e);
    if (tw.spin) q = qMul(qAxis([0, 1, 0], tw.spin * Math.sin(k * Math.PI)), q);
    return { p, q, s: tw.from.s + (tw.to.s - tw.from.s) * e };
  }

  // ---------- 1 コマ描く ----------
  private frame(now: number) {
    const dt = Math.min(0.05, now - (this.t || now));
    this.t = now;
    const cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    this.stage.resize(w, h);
    const aspect = w / h;
    const L2 = layoutFor(aspect);
    if (L2.eye[1] !== this.L.eye[1]) { this.L = L2; this.place(0.3); }
    this.zoom += (this.zoomTo - this.zoom) * Math.min(1, dt * 4);
    for (let i = 0; i < 3; i++) this.tint[i] += (this.tintTo[i] - this.tint[i]) * Math.min(1, dt * 2);
    this.shake *= Math.exp(-dt * 5);
    const L = this.L;
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    const eye = lerp3(L.eye, [L.at[0], L.eye[1] * 0.72, L.eye[2] * 0.82], this.zoom);
    eye[0] += Math.sin(this.t * 0.25) * 0.35 + sx; eye[1] += sy;
    this.eye = eye;
    this.vp = mul(persp(L.fov, aspect, 0.5, 120), lookAt(eye, [L.at[0] + sx * 0.5, L.at[1], L.at[2]], [0, 1, 0]));

    const cards: CardDraw[] = [];
    const halos: HaloDraw[] = [];
    const pulse = 0.55 + 0.45 * Math.sin(this.t * 5);
    const choosing = this.inter.targets.size > 0 || this.inter.pickable.size > 0;
    for (const o of this.objs) {
      let pose = this.poseNow(o);
      if (o.tween && this.t >= o.tween.t0 + o.tween.dur) { o.cur = o.tween.to; o.tween = null; pose = o.cur; }
      else if (!o.tween) o.cur = pose;
      const id = o.key.startsWith('c') ? o.face : -1;
      const inField = this.field.includes(o.key);
      const p: Vec3 = [...pose.p];
      if (!o.tween && inField) p[1] += Math.sin(this.t * 1.3 + o.phase) * 0.05;
      if (!o.tween && this.spot.includes(o.key)) p[1] += Math.sin(this.t * 2 + o.phase) * 0.08;
      const m = model(p, pose.q, pose.s);
      let glow: CardDraw['glow'] = [0, 0, 0, 0];
      const isTarget = id >= 0 && this.inter.targets.has(id);
      const isSel = id >= 0 && this.inter.selected === id;
      const isPick = id >= 0 && this.inter.pickable.has(id);
      if (isTarget) glow = [0.3, 0.9, 1.0, pulse];
      else if (isSel) glow = [1.0, 0.8, 0.3, 0.9];
      else if (isPick && this.hand.includes(id)) glow = [0.4, 0.7, 1.0, 0.25];
      if (o.flash > 0) { glow = [1.0, 0.85, 0.4, Math.max(glow[3], o.flash)]; o.flash = Math.max(0, o.flash - dt * 1.2); }
      if (this.spot.includes(o.key)) glow = [1.0, 0.75, 0.25, 0.55];
      const dim = choosing && inField && this.inter.targets.size > 0 && !isTarget ? 0.6 : 0;
      cards.push({ m, face: o.face, glow, dim });
      if (isTarget || isSel || this.spot.includes(o.key) || o.flash > 0.05) halos.push({ m, color: isTarget ? [0.2, 0.75, 1.0, 0.9 * pulse] : [1.0, 0.7, 0.25, 0.9] });
      if (!o.tween && pose === o.cur && o.key === this.reveal) halos.push({ m, color: [1, 1, 1, 0.5] });
    }
    // 奥から描く（光の重なりを自然に）
    cards.sort((a, b) => b.m[14] - a.m[14]);
    this.stage.draw({ time: this.t, vp: this.vp, eye, tint: this.tint, cheer: this.cheer, burst: this.burst, pulse: this.pulse }, cards, halos);
    if (this.sampler) { const f = this.sampler; this.sampler = null; f(this.stage.brightPixels()); }
  }

  // 描けているかの確認（画面テスト用）：明るい点の数
  private sampler: ((n: number) => void) | null = null;
  sample(): Promise<number> { return new Promise((r) => { this.sampler = r; }); }

  // ---------- タップ ----------
  private corners(o: Obj): [number, number][] | null {
    const pose = this.poseNow(o);
    const m = model(pose.p, pose.q, pose.s);
    const pts: [number, number][] = [];
    for (const [x, y] of [[-CW / 2, -CH / 2], [CW / 2, -CH / 2], [CW / 2, CH / 2], [-CW / 2, CH / 2]]) {
      const w: Vec3 = [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13], m[2] * x + m[6] * y + m[14]];
      const s = project(this.vp, w);
      if (!s) return null;
      pts.push(s);
    }
    return pts;
  }

  // 札の画面上の中心（0〜1）。画面テストで使う
  screenOf(id: number): [number, number] | null {
    const o = this.obj(id);
    if (!o || !this.vp.length) return null;
    return project(this.vp, this.poseNow(o).p);
  }

  private pick(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    let best: { id: number; score: number } | null = null;
    for (const id of [...this.inter.pickable, ...this.inter.targets]) {
      const o = this.obj(id);
      if (!o) continue;
      const c = this.corners(o);
      if (!c || !inside(c, x, y)) continue;
      const score = (this.hand.includes(id) ? 10 : 0) + (c[0][1] + c[2][1]) / 2;
      if (!best || score > best.score) best = { id, score };
    }
    if (best) this.onPick(best.id);
  }

  // ---------- 見え方の更新（出来事を順に演出する） ----------
  update(v: View, hooks: EventHooks): Promise<void> {
    this.queue = this.queue.then(() => this.play(v, hooks)).catch((e) => console.error(e));
    return this.queue;
  }

  private async play(v: View, hooks: EventHooks) {
    const S = (ms: number) => sleep(ms * this.speed);
    if (v.round !== this.seenRound) {
      // 新しい月：札を集めて配り直す
      this.seenRound = v.round;
      this.seenEvents = 0;
      this.spot = []; this.reveal = null;
      const all = this.objs.map((o) => o.key);
      this.hand = []; this.oppHand = []; this.field = []; this.cap = [[], []];
      this.deck = all;
      this.place(0.4, 0.004);
      hooks.onEvent?.({ k: 'deal', round: v.round, dealer: v.dealer });
      await S(650);
      // 配る前の状態（全部山）から、見え方に合わせて配る
      const fresh = v.events.every((e) => e.k === 'deal');
      this.rebuild(v);
      if (!fresh) {
        // 途中から見る（つなぎ直しなど）：いまの状態をそのまま出す
        this.place(0.5, 0.02);
        this.seenEvents = v.events.length;
        await S(700);
        return;
      }
      this.place(0.5, 0.035);
      this.seenEvents = v.events.length;
      await S(900);
      return;
    }
    const evs = v.events.slice(this.seenEvents);
    this.seenEvents = v.events.length;
    for (const ev of evs) await this.animate(ev, v, hooks);
    this.spot = [];
    this.rebuild(v);
    this.place(0.4);
    await S(300);
  }

  private async animate(ev: Ev, v: View, hooks: EventHooks) {
    const S = (ms: number) => sleep(ms * this.speed);
    hooks.onEvent?.(ev);
    switch (ev.k) {
      case 'play': {
        let o = this.obj(ev.card);
        if (!o) { const k = this.oppHand.pop(); if (k) { o = this.byKey.get(k)!; this.rename(o, `c${ev.card}`, ev.card); } }
        if (!o) return;
        this.hand = this.hand.filter((x) => x !== ev.card);
        this.oppHand = this.oppHand.filter((k) => k !== o!.key);
        await this.land(o, ev.card, ev.took, ev.p, hooks);
        break;
      }
      case 'draw': {
        let o = this.obj(ev.card);
        if (!o) { const k = this.deck.pop(); if (k) { o = this.byKey.get(k)!; this.rename(o, `c${ev.card}`, ev.card); } }
        if (!o) return;
        this.deck = this.deck.filter((k) => k !== o!.key);
        if (this.reveal !== o.key) {
          // 山からめくって、目の前で見せる
          this.reveal = o.key;
          this.zoomTo = 0.25;
          this.place(0.5);
          hooks.onSound?.('flip');
          await S(700);
          this.zoomTo = 0;
        }
        if (ev.choosing) return; // 取る札を選ぶまで待つ
        this.reveal = null;
        await this.land(o, ev.card, ev.took, ev.p, hooks);
        break;
      }
      case 'yaku': {
        const ids = [...new Set(ev.yaku.flatMap((y) => y.cards))].slice(0, 10);
        this.spot = ids.map((id) => `c${id}`).filter((k) => this.byKey.has(k));
        this.zoomTo = 0.35;
        this.doPulse();
        this.place(0.6, 0.05);
        await S(2000);
        this.spot = [];
        this.zoomTo = 0;
        this.place(0.5);
        await S(400);
        break;
      }
      case 'koikoi':
        this.doBurst();
        this.doPulse();
        await S(900);
        break;
      case 'end':
        await S(300);
        break;
      default:
        break;
    }
    void v;
  }

  // 札を場に置く・合わせて取る
  private async land(o: Obj, card: number, took: number[], p: Player, hooks: EventHooks) {
    const S = (ms: number) => sleep(ms * this.speed);
    if (!took.length) {
      const i = this.field.indexOf(null);
      if (i >= 0) this.field[i] = o.key; else this.field.push(o.key);
      this.place(0.45);
      await S(450);
      hooks.onSound?.('slap');
      return;
    }
    // 合わせる札の上に重ねる
    const tgt = took.filter((x) => x !== card).map((x) => this.obj(x)).filter(Boolean) as Obj[];
    const base = tgt[0]?.target.p ?? this.L.field(0);
    o.tween = { from: this.poseNow(o), to: { p: [base[0] + 0.18, base[1] + 0.12, base[2] + 0.12], q: FACE_UP, s: 1 }, t0: this.t, dur: 0.42 * this.speed, arc: 1.2, spin: 0 };
    o.target = o.tween.to;
    await S(430);
    hooks.onSound?.('slap');
    this.shake = Math.max(this.shake, 0.08);
    for (const x of [o, ...tgt]) x.flash = 1;
    await S(250);
    // 取り札へ
    this.field = this.field.map((k) => (k && tgt.some((x) => x.key === k) ? null : k));
    this.cap[p].push(o.key, ...tgt.map((x) => x.key));
    this.place(0.5, 0.04);
    await S(520);
  }

  pendingPick() { return this.reveal != null; }
}

export interface EventHooks {
  onEvent?: (ev: Ev | { k: 'deal'; round: number; dealer: Player }) => void;
  onSound?: (s: 'slap' | 'flip') => void;
}

function inside(c: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = c[i], [bx, by] = c[(i + 1) % 4];
    const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cr !== 0) { if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false; }
  }
  return true;
}
export { qEuler };
