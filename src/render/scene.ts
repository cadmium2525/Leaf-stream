/**
 * 水路・小川の 3D 描画。
 * - 座標変換：sim (x, y)[cm] → three (x/100, 高さ, -y/100)[m]。下流は -z
 * - 勝敗の計算は一切しない。確定済みの軌跡（LeafPose）を受け取って表示するだけ
 * - 落差の高さ・水面の形・しぶきは見た目専用（terrain.ts）
 */
import * as THREE from 'three';
import { LEAF_RULES, centroid, type Course, type LeafPose, type Polygon } from '../../packages/sim-core/src/index.ts';
import { asphaltMap, blockMap, concreteMaps, earthMaps, grassMaps, leafTexture, pebbleMaps, SKY, type LeafTone, type MaterialMaps } from './textures.ts';
import {
  MAX_COVERS, MAX_DROPS, MAX_STONES, addCaustics, addCoverShade, createCoverUniforms, createSkyMaterial, createWaterMaterial,
  injectCoverShade,
} from './water.ts';
import {
  DEPTH, LIP, NATURAL_COLORS, NATURAL_PROFILE, S, Terrain, WALL_COLORS, WALL_PROFILE, WALL_T, WALL_TOP, rng,
} from './terrain.ts';
import { ENV_FOG, buildBackdrop, envOf, type Env } from './backdrop.ts';
import { createSpray, type SprayEmitter } from './spray.ts';

export type EffectiveQuality = 'high' | 'standard' | 'eco';
export type CameraMode = 'follow' | 'overhead' | 'orbit';

const QUALITY: Record<EffectiveQuality, {
  dpr: number; shadows: boolean; octaves: number; tex: number; grass: number; aa: boolean; trees: number; spray: number;
}> = {
  high: { dpr: 2, shadows: true, octaves: 4, tex: 1024, grass: 7000, aa: true, trees: 900, spray: 160 },
  standard: { dpr: 1.5, shadows: false, octaves: 3, tex: 512, grass: 2800, aa: true, trees: 450, spray: 90 },
  eco: { dpr: 1, shadows: false, octaves: 2, tex: 256, grass: 700, aa: false, trees: 160, spray: 35 },
};

export interface LeafVisual {
  polygon: Polygon;
  tone: LeafTone;
}

interface LeafObj {
  /** 位置と水面の傾きに合わせた前傾 */
  outer: THREE.Group;
  /** 向き（ヨー）と揺れ */
  inner: THREE.Group;
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  pose: LeafPose | null;
  lastY: number | null;
  pitch: number;
  lastContact: number;
}

interface Ripple {
  mesh: THREE.Mesh;
  age: number;
  size: number;
}

/** 断面 prof 上で、岸からの距離 off の地面の高さ */
function profileHeight(prof: [number, number, number][], off: number): number {
  for (let i = 0; i + 1 < prof.length; i++) {
    const [x0, y0] = prof[i];
    const [x1, y1] = prof[i + 1];
    if (off >= x0 && off <= x1) return y0 + ((y1 - y0) * (off - x0)) / (x1 - x0 || 1);
  }
  return prof[prof.length - 1][1];
}

/** 岩の形のゆらぎと回転を見込んだ、中心から外形までの最大距離（半径に対する倍率） */
const ROCK_REACH = 1.45;
/** 中心から上端までの高さ（半径に対する倍率。縦は 0.75 倍に潰している） */
const ROCK_TOP = 1.0;

/** 草地の土手（コンクリート水路の外側） */
const GRASS_BANK: [number, number, number][] = [
  [WALL_T - 0.005, WALL_TOP - 0.005, 0], [0.6, WALL_TOP + 0.02, 0.6], [1.6, 0.1, 1.6], [3.2, -0.2, 3.2], [4.5, -0.34, 4.5],
];

export class CanalScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  quality: EffectiveQuality;
  cameraMode: CameraMode = 'orbit';
  /** 毎フレーム呼ばれる（dt 秒） */
  onFrame: ((dt: number) => void) | null = null;
  /** 自動調整で画質を下げたとき */
  onAutoDowngrade: ((q: EffectiveQuality) => void) | null = null;
  autoQuality = false;

  private container: HTMLElement;
  private clock = new THREE.Clock();
  private running = false;
  private raf = 0;
  private time = { value: 0 };
  private flow = { value: 0.42 };
  private cover = createCoverUniforms();
  /** 草が傾く向き（world の x,z。コースの風から） */
  private windU = { value: new THREE.Vector2() };
  private course: Course | null = null;
  private terrain: Terrain | null = null;
  private courseGroup: THREE.Group | null = null;
  private env: Env | null = null;
  private backdrop: THREE.Group | null = null;
  private water: ReturnType<typeof createWaterMaterial> | null = null;
  private sky: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  private leaves: LeafObj[] = [];
  private ripples: Ripple[] = [];
  private camPos = new THREE.Vector3(0, 0.6, 1.5);
  private camLook = new THREE.Vector3(0, 0, 0);
  private camInit = false;
  private orbitT = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private lowFpsSeconds = 0;
  private textures: Record<string, MaterialMaps> = {};
  private leafTextures = new Map<LeafTone, THREE.Texture>();
  private resizeObs: ResizeObserver;

  constructor(container: HTMLElement, quality: EffectiveQuality) {
    this.container = container;
    this.quality = quality;
    const q = QUALITY[quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: q.aa, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 400);
    this.scene.fog = new THREE.Fog(SKY.horizon.clone(), 18, 140);

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), createSkyMaterial());
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.scene.add(new THREE.HemisphereLight(0xcfe3f0, 0x5a5a3a, 1.1));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    this.sun.position.copy(SKY.sun).multiplyScalar(10);
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    const sc = this.sun.shadow.camera;
    sc.left = -3;
    sc.right = 3;
    sc.top = 3;
    sc.bottom = -3;
    sc.near = 0.1;
    sc.far = 30;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.buildTextures();
    this.applyQuality();

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = () => {
    if (document.hidden) cancelAnimationFrame(this.raf);
    else if (this.running) {
      this.clock.getDelta();
      this.loop();
    }
  };

  private buildTextures(): void {
    const n = QUALITY[this.quality].tex;
    for (const t of Object.values(this.textures)) {
      t.map.dispose();
      t.normalMap.dispose();
    }
    this.textures = {
      concrete: concreteMaps(n),
      pebble: pebbleMaps(n),
      grass: grassMaps(Math.min(n, 512)),
      earth: earthMaps(Math.min(n, 512)),
    };
  }

  setQuality(q: EffectiveQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.buildTextures();
    this.applyQuality();
    this.env = null;
    if (this.course) this.setCourse(this.course);
  }

  private applyQuality(): void {
    const q = QUALITY[this.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    this.resize();
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 68 : 55;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- コース

  get hasCourse(): boolean {
    return this.course !== null;
  }

  setCourse(course: Course): void {
    this.course = course;
    disposeTree(this.courseGroup, this.scene);
    const q = QUALITY[this.quality];
    const T = new Terrain(course);
    this.terrain = T;
    const g = new THREE.Group();
    this.courseGroup = g;
    this.flow.value = course.baseSpeed * S;
    // 草のなびき：風（cm/s）をおおよその傾きに換算。下流（+y）は world の -z
    this.windU.value.set(course.windX * 0.0025, -course.windY * 0.0025);

    // 遠景（環境が変わったときだけ作り直す）
    const env = envOf(course.style);
    if (env !== this.env) {
      disposeTree(this.backdrop, this.scene);
      this.backdrop = buildBackdrop(env, q.trees);
      this.scene.add(this.backdrop);
      this.env = env;
      const f = ENV_FOG[env];
      const fog = this.scene.fog as THREE.Fog;
      fog.color.set(f.color);
      fog.near = f.near;
      fog.far = f.far;
    }

    // ふた（暗渠）の範囲
    const covers = this.cover.uCovers.value;
    course.covers.slice(0, MAX_COVERS).forEach((c, i) => covers[i].set(-c.y0 * S, -c.y1 * S));
    this.cover.uCoverCount.value = Math.min(course.covers.length, MAX_COVERS);

    const natural = course.style === 'natural';

    // 水底
    const pm = this.textures.pebble;
    const bottomMat = new THREE.MeshStandardMaterial({
      map: pm.map, normalMap: pm.normalMap, roughness: 0.75, color: natural ? 0xc8c4b0 : 0xd8d2c0,
    });
    addCaustics(bottomMat, this.time, this.flow, this.cover);
    const bottom = new THREE.Mesh(T.ribbon((y) => -DEPTH + T.bed(y), 7, natural ? 0.6 : 0.45, natural ? 0.07 : 0.004), bottomMat);
    bottom.receiveShadow = true;
    g.add(bottom);

    if (natural) this.buildNaturalBanks(g, T, course);
    else this.buildConcrete(g, T, course);

    this.buildStones(g, T, course, natural);
    this.buildDrops(g, T, course, natural);
    this.buildMarkers(g, T, course);

    // 水面
    this.water = createWaterMaterial(q.octaves, this.cover);
    this.water.uniforms.uFlow.value = this.flow.value;
    if (natural) {
      this.water.uniforms.uShallow.value.set('#78917a');
      this.water.uniforms.uWall.value.set('#5d6b4a');
    }
    const stones = this.water.uniforms.uStones.value;
    course.stones.slice(0, MAX_STONES).forEach((s, i) => stones[i].set(s.x * S, -s.y * S, s.r * S * 0.95, 1));
    this.water.uniforms.uStoneCount.value = Math.min(course.stones.length, MAX_STONES);
    const drops = this.water.uniforms.uDrops.value;
    course.drops.slice(0, MAX_DROPS).forEach((d, i) => drops[i].set(-d.y * S, d.h * S, d.notchX * S, d.notchW * S));
    this.water.uniforms.uDropCount.value = Math.min(course.drops.length, MAX_DROPS);
    const water = new THREE.Mesh(T.ribbon((y) => T.water(y), 11, 1, 0.004, true), this.water);
    water.renderOrder = 2;
    g.add(water);

    // 滝のしぶき
    const emitters: SprayEmitter[] = course.drops.map((d) => {
      const y = d.y + LIP + 1.5;
      return {
        x: d.notchW > 0 ? d.notchX * S : T.cx(d.y),
        y: T.water(y) + 0.004,
        z: -y * S,
        width: d.notchW > 0 ? d.notchW * S * 1.2 : T.hw(d.y) * 1.6,
        power: d.h / 5,
      };
    });
    if (emitters.length) g.add(createSpray(emitters, q.spray, this.time));

    this.scene.add(g);
    for (const l of this.leaves) l.mesh.renderOrder = 3;
    this.camInit = false;
  }

  /** コンクリート水路・側溝：壁、外側（草地 or 道路とブロック塀）、ふた */
  private buildConcrete(g: THREE.Group, T: Terrain, course: Course): void {
    const q = QUALITY[this.quality];
    const cm = this.textures.concrete;
    const wallMat = new THREE.MeshStandardMaterial({ map: cm.map, normalMap: cm.normalMap, roughness: 0.92, vertexColors: true });
    addCoverShade(wallMat, this.cover);
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(T.strip(side, WALL_PROFILE, { colors: WALL_COLORS }), wallMat);
      wall.receiveShadow = true;
      wall.castShadow = q.shadows;
      g.add(wall);
    }

    if (course.style === 'concrete') {
      const gm = this.textures.grass;
      const bankMat = new THREE.MeshStandardMaterial({ map: gm.map, normalMap: gm.normalMap, roughness: 0.95, color: 0xdfe8c8 });
      for (const side of [-1, 1]) {
        const bank = new THREE.Mesh(T.strip(side, GRASS_BANK, { tile: 0.8 }), bankMat);
        bank.receiveShadow = true;
        g.add(bank);
      }
      this.addGrass(g, T, q.grass, GRASS_BANK, [0.06, 1.4], [0.03, 0.12]);
      return;
    }

    // 側溝：右は道路（白線つき）、左は細い路肩とブロック塀
    const asphalt = asphaltMap(256);
    const roadMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 });
    const road = new THREE.Mesh(T.strip(1, [[WALL_T - 0.005, WALL_TOP - 0.004, 0], [4, WALL_TOP - 0.004, 4]], { tile: 1 }), roadMat);
    road.receiveShadow = true;
    const line = new THREE.Mesh(T.strip(1, [[0.22, WALL_TOP - 0.001, 0], [0.3, WALL_TOP - 0.001, 0.1]]), new THREE.MeshStandardMaterial({ color: 0xe8e6dc, roughness: 0.8 }));
    const shoulder = new THREE.Mesh(T.strip(-1, [[WALL_T - 0.005, WALL_TOP - 0.004, 0], [0.5, WALL_TOP - 0.004, 0.5], [0.5, -0.2, 0.8], [4, -0.2, 4]], { tile: 1 }), roadMat);
    shoulder.receiveShadow = true;
    g.add(road, line, shoulder);

    // ブロック塀
    const blockTex = blockMap(256);
    const segLen = 1.0;
    const ys: number[] = [];
    for (let y = T.y0; y < T.y1; y += segLen / S) ys.push(y);
    const wallBlocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: blockTex, roughness: 0.95 }), ys.length);
    const m = new THREE.Matrix4();
    ys.forEach((y, i) => {
      const yc = y + segLen / S / 2;
      m.compose(
        new THREE.Vector3(T.cx(yc) - T.hw(yc) - WALL_T - 0.45, T.bed(yc) + WALL_TOP + 0.6, -yc * S),
        new THREE.Quaternion(),
        new THREE.Vector3(0.12, 1.2, segLen + 0.002),
      );
      wallBlocks.setMatrixAt(i, m);
    });
    wallBlocks.castShadow = q.shadows;
    wallBlocks.receiveShadow = true;
    g.add(wallBlocks);
    this.addGrass(g, T, Math.floor(q.grass * 0.12), [[WALL_T, WALL_TOP, 0], [0.4, WALL_TOP, 0.4]], [0.0, 0.35], [0.02, 0.07], -1);

    // ふた（暗渠）
    const lidMat = new THREE.MeshStandardMaterial({ map: this.textures.concrete.map, roughness: 0.9, color: 0xb8b4a8 });
    for (const c of course.covers) {
      const len = (c.y1 - c.y0) * S;
      const ym = (c.y0 + c.y1) / 2;
      const lid = new THREE.Mesh(new THREE.BoxGeometry(T.hw(ym) * 2 + WALL_T * 2 + 0.04, 0.05, len), lidMat);
      lid.position.set(T.cx(ym), T.bed(ym) + WALL_TOP + 0.025, -ym * S);
      lid.castShadow = q.shadows;
      lid.receiveShadow = true;
      g.add(lid);
    }
  }

  /** 自然の小川：凸凹の土手、岸の岩、草 */
  private buildNaturalBanks(g: THREE.Group, T: Terrain, course: Course): void {
    const q = QUALITY[this.quality];
    const em = this.textures.earth;
    const bankMat = new THREE.MeshStandardMaterial({ map: em.map, normalMap: em.normalMap, roughness: 0.95, vertexColors: true });
    for (const side of [-1, 1]) {
      const bank = new THREE.Mesh(T.strip(side, NATURAL_PROFILE, { colors: NATURAL_COLORS, jitter: 0.035, seed: course.seed & 0xff, tile: 0.7 }), bankMat);
      bank.receiveShadow = true;
      g.add(bank);
    }
    this.addGrass(g, T, Math.floor(q.grass * 1.2), NATURAL_PROFILE, [0.1, 2.2], [0.05, 0.22]);

    // 岸に並ぶ岩
    const r = rng(course.seed ^ 0x77);
    const rocks: { x: number; y: number; z: number; r: number }[] = [];
    for (const side of [-1, 1]) {
      for (let y = T.y0; y < T.y1;) {
        const rad = 0.03 + r() * 0.07;
        // 岩の内側の端が水際（葉が跳ね返る位置）に来るように、水路の外側へ置く
        rocks.push({ x: T.cx(y) + side * (T.hw(y) + rad * ROCK_REACH), y: T.bed(y) - 0.015, z: -y * S, r: rad });
        y += 10 + r() * 18;
      }
    }
    this.addRocks(g, rocks, course.seed);
  }

  /** 苔むした岩（インスタンス描画） */
  private addRocks(g: THREE.Group, rocks: { x: number; y: number; z: number; r: number }[], seed: number): void {
    if (!rocks.length) return;
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      v.multiplyScalar(1 + 0.16 * Math.sin(v.x * 4.1 + 1) * Math.sin(v.z * 3.3 + 2) + 0.08 * Math.sin(v.y * 6.7));
      pos.setXYZ(i, v.x, v.y, v.z);
      const moss = Math.max(0, v.y);
      colors.push(0.3 - 0.1 * moss, 0.3 + 0.03 * moss, 0.27 - 0.12 * moss);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, flatShading: true });
    addCoverShade(mat, this.cover);
    const im = new THREE.InstancedMesh(geo, mat, rocks.length);
    const r = rng(seed ^ 0x99);
    const m = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const c = new THREE.Color();
    rocks.forEach((k, i) => {
      qt.setFromEuler(new THREE.Euler(r() * 0.4, r() * 6.28, r() * 0.4));
      m.compose(new THREE.Vector3(k.x, k.y, k.z), qt, new THREE.Vector3(k.r, k.r * 0.75, k.r * 1.1));
      im.setMatrixAt(i, m);
      const v = 0.75 + r() * 0.4;
      im.setColorAt(i, c.setRGB(v, v * (0.95 + r() * 0.1), v * 0.9));
    });
    im.castShadow = QUALITY[this.quality].shadows;
    im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    g.add(im);
  }

  /** 水中の石（当たり判定のある石） */
  private buildStones(g: THREE.Group, T: Terrain, course: Course, natural: boolean): void {
    const q = QUALITY[this.quality];
    const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0 });
    addCoverShade(stoneMat, this.cover);
    const r = rng(course.seed ^ 0x51);
    for (const s of course.stones) {
      const geo = new THREE.IcosahedronGeometry(1, this.quality === 'eco' ? 2 : 3);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const phase = [r() * 10, r() * 10, r() * 10];
      const colors: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i);
        // 横方向の凸凹は小さめにして、当たり判定の円（半径 r）と見た目の輪郭を揃える
        const n = 1 + 0.08 * Math.sin(v.x * 3.1 + phase[0]) * Math.sin(v.y * 2.7 + phase[1]) + 0.05 * Math.sin(v.z * 5.3 + phase[2]);
        v.set(v.x * n, v.y * (1 + 0.18 * Math.sin(v.x * 4.3 + phase[1])), v.z * n);
        pos.setXYZ(i, v.x, v.y, v.z);
        // 上面は苔、水に濡れた部分は暗く
        const mossy = Math.max(0, v.y) * (0.6 + 0.4 * Math.sin(v.x * 7 + phase[0]));
        const base = 0.36 + 0.08 * Math.sin(v.x * 11 + v.z * 9);
        colors.push(base * (1 - mossy) + 0.27 * mossy, base * (1 - mossy) + 0.38 * mossy, base * 0.95 * (1 - mossy) + 0.16 * mossy);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, stoneMat);
      const rr = s.r * S;
      const hgt = natural ? 0.09 : 0.07;
      m.scale.set(rr, hgt, rr);
      m.position.set(s.x * S, T.bed(s.y) - DEPTH + hgt * 0.8, -s.y * S);
      m.rotation.y = r() * Math.PI;
      m.castShadow = q.shadows;
      m.receiveShadow = true;
      g.add(m);
    }
  }

  /** 落ち口の構造：コンクリートの堰（欠けあり）／岩の段 */
  private buildDrops(g: THREE.Group, T: Terrain, course: Course, natural: boolean): void {
    if (natural) {
      const r = rng(course.seed ^ 0x33);
      const rocks: { x: number; y: number; z: number; r: number }[] = [];
      for (const d of course.drops) {
        const c = T.cx(d.y);
        const w = T.hw(d.y);
        for (let x = c - w - 0.02; x <= c + w + 0.02; x += 0.045 + r() * 0.03) {
          if (d.notchW > 0 && Math.abs(x - d.notchX * S) < d.notchW * S * 0.55) continue;
          const rad = 0.03 + r() * 0.025;
          // 落ち口の岩棚は水面のすぐ下に沈める（水がその上を越えていく。葉もその上を流れる）
          rocks.push({ x, y: T.water(d.y - 1) - 0.02 - rad * ROCK_TOP, z: -(d.y - 0.5) * S, r: rad });
        }
        // 滝壺の縁の石
        for (let k = 0; k < 5; k++) {
          const rad = 0.02 + r() * 0.025;
          const side = k % 2 === 0 ? -1 : 1;
          const y = d.y + 8 + r() * 25;
          rocks.push({ x: T.cx(y) + side * (T.hw(y) + rad * ROCK_REACH), y: T.bed(y) - DEPTH * 0.4, z: -y * S, r: rad });
        }
      }
      this.addRocks(g, rocks, course.seed + 7);
      return;
    }
    // 水に沈んだ堰（濡れて苔むした色）
    const mat = new THREE.MeshStandardMaterial({ map: this.textures.concrete.map, roughness: 0.6, color: 0x5f6a52 });
    addCoverShade(mat, this.cover);
    for (const d of course.drops) {
      const c = T.cx(d.y);
      const w = T.hw(d.y);
      const top = T.water(d.y - 20) - 0.022;
      const bottom = T.bed(d.y + 1) - DEPTH;
      const z = -(d.y - 1.8) * S;
      const box = (x0: number, x1: number, topY: number) => {
        if (x1 - x0 < 0.005) return;
        const b = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, topY - bottom, 0.036), mat);
        b.position.set((x0 + x1) / 2, (topY + bottom) / 2, z);
        b.receiveShadow = true;
        g.add(b);
      };
      if (d.notchW > 0) {
        const n0 = (d.notchX - d.notchW / 2) * S;
        const n1 = (d.notchX + d.notchW / 2) * S;
        box(c - w, n0, top);
        box(n0, n1, top - 0.025);
        box(n1, c + w, top);
      } else box(c - w, c + w, top);
    }
  }

  /** スタート・ゴールの目印（竹の棒としめ縄風の紐） */
  private buildMarkers(g: THREE.Group, T: Terrain, course: Course): void {
    const q = QUALITY[this.quality];
    const bambooMat = new THREE.MeshStandardMaterial({ color: 0x9c8a4a, roughness: 0.6 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0xd9cfae, roughness: 0.9 });
    for (const [y, tall] of [[course.startY, 0.18], [course.goalY, 0.3]] as const) {
      const w = T.hw(y);
      const c = T.cx(y);
      const base = T.bed(y);
      for (const side of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.009, tall + DEPTH + WALL_TOP * 0.5, 8), bambooMat);
        pole.position.set(c + side * (w + 0.02), base + (tall + WALL_TOP * 0.5 - DEPTH) / 2, -y * S);
        pole.castShadow = q.shadows;
        g.add(pole);
      }
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, w * 2 + 0.04, 6), ropeMat);
      rope.rotation.z = Math.PI / 2;
      rope.position.set(c, base + WALL_TOP * 0.5 + tall - 0.02, -y * S);
      g.add(rope);
    }
  }

  /** 土手の草（インスタンス描画、風で揺れる） */
  private addGrass(
    g: THREE.Group, T: Terrain, count: number, prof: [number, number, number][],
    range: [number, number], height: [number, number], onlySide = 0,
  ): void {
    if (count <= 0) return;
    const blade = new THREE.BufferGeometry();
    const seg = 4;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      // 高さ 1 に対する幅（インスタンスは等倍率で拡大する）
      const w = 0.035 * (1 - t);
      pos.push(-w, t, 0, w, t, 0);
      const c = [0.22 + 0.3 * t, 0.36 + 0.3 * t, 0.12 + 0.1 * t];
      col.push(...c, ...c);
      if (i < seg) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    blade.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    blade.setIndex(idx);
    blade.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
    const time = this.time;
    const cover = this.cover;
    const windU = this.windU;
    mat.onBeforeCompile = (shader) => {
      injectCoverShade(shader, cover);
      shader.uniforms.uTime = time;
      shader.uniforms.uWind = windU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float sway = sin(uTime * 1.7 + wp.x * 2.0 + wp.z * 1.3) * 0.5 + sin(uTime * 3.1 + wp.z * 4.0) * 0.25;
          transformed.x += sway * 0.18 * position.y * position.y;
          transformed.z += sway * 0.08 * position.y * position.y;
          // 風下へなびく（インスタンスの回転を打ち消してワールドの向きに合わせる）
          vec3 lean = vec3(uWind.x, 0.0, uWind.y) * (0.6 + 0.4 * sway) * position.y * position.y;
          transformed += (inverse(mat3(instanceMatrix)) * lean) * length(instanceMatrix[1].xyz);`);
    };
    const mesh = new THREE.InstancedMesh(blade, mat, count);
    const r = rng(1234 + count);
    const m = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let i = 0; i < count; i++) {
      const y = T.y0 + r() * (T.y1 - T.y0);
      const side = onlySide || (r() < 0.5 ? -1 : 1);
      const off = range[0] + Math.pow(r(), 1.6) * (range[1] - range[0]);
      const ground = profileHeight(prof, off) + T.bed(y);
      const hgt = height[0] + r() * r() * (height[1] - height[0]);
      e.set((r() - 0.5) * 0.5, r() * Math.PI, (r() - 0.5) * 0.5);
      qt.setFromEuler(e);
      m.compose(new THREE.Vector3(T.cx(y) + side * (T.hw(y) + off), ground - 0.005, -y * S), qt, new THREE.Vector3(hgt * (0.8 + r() * 0.6), hgt, hgt));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    g.add(mesh);
  }

  // ---------------------------------------------------------------- 葉っぱ

  private leafTex(tone: LeafTone): THREE.Texture {
    let t = this.leafTextures.get(tone);
    if (!t) {
      t = leafTexture(tone);
      this.leafTextures.set(tone, t);
    }
    return t;
  }

  setLeaves(visuals: LeafVisual[]): void {
    for (const l of this.leaves) {
      this.scene.remove(l.outer, l.shadow);
      l.mesh.geometry.dispose();
      (l.mesh.material as THREE.Material).dispose();
      l.shadow.geometry.dispose();
      (l.shadow.material as THREE.Material).dispose();
    }
    this.leaves = visuals.map((v) => {
      const mat = new THREE.MeshStandardMaterial({ map: this.leafTex(v.tone), side: THREE.DoubleSide, roughness: 0.45, metalness: 0 });
      addCoverShade(mat, this.cover);
      const mesh = new THREE.Mesh(leafGeometry(v.polygon), mat);
      mesh.castShadow = QUALITY[this.quality].shadows;
      mesh.renderOrder = 3;
      const shadow = new THREE.Mesh(
        leafGeometry(v.polygon, true),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
      );
      shadow.renderOrder = 1;
      shadow.visible = false;
      const inner = new THREE.Group();
      inner.add(mesh);
      const outer = new THREE.Group();
      outer.add(inner);
      outer.visible = false;
      this.scene.add(outer, shadow);
      return { outer, inner, mesh, shadow, pose: null, lastY: null, pitch: 0, lastContact: 0 };
    });
  }

  /** sim 座標の姿勢をセット（null で非表示） */
  setPose(i: number, pose: LeafPose | null): void {
    const l = this.leaves[i];
    if (!l) return;
    l.pose = pose ? { ...pose } : null;
  }

  /** 3D 位置を画面座標に（ラベル表示用） */
  project(i: number): { x: number; y: number; visible: boolean } | null {
    const l = this.leaves[i];
    if (!l || !l.pose) return null;
    const v = new THREE.Vector3(l.pose.x * S, this.waterAt(l.pose.y) + 0.03, -l.pose.y * S).project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  setCameraMode(m: CameraMode): void {
    this.cameraMode = m;
  }

  private waterAt(y: number): number {
    return this.terrain ? this.terrain.water(y) : 0;
  }

  private centerAt(y: number): number {
    return this.terrain ? this.terrain.cx(y) : 0;
  }

  // ---------------------------------------------------------------- ループ

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.getDelta();
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private loop = (): void => {
    if (!this.running || document.hidden) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.tick(dt);
  };

  private tick(dt: number): void {
    this.time.value += dt;
    const t = this.time.value;
    this.onFrame?.(dt);
    if (this.water) this.water.uniforms.uTime.value = t;
    (this.sky.material as THREE.ShaderMaterial).uniforms.uTime.value = t;

    const T = this.terrain;
    const sunOff = new THREE.Vector2(SKY.sun.x, SKY.sun.z).multiplyScalar(DEPTH / SKY.sun.y);
    this.leaves.forEach((l, i) => {
      if (!l.pose) {
        l.outer.visible = false;
        l.shadow.visible = false;
        l.lastY = null;
        return;
      }
      const p = l.pose;
      const x = p.x * S;
      const z = -p.y * S;
      const yaw = Math.atan2(p.s, p.c);
      const surface = this.waterAt(p.y);
      // 水面の傾きに合わせて前のめりになる（滝を落ちるとき）。見た目だけ
      const target = T ? Math.max(-1.2, Math.min(0.3, Math.atan(T.waterSlope(p.y)))) : 0;
      l.pitch += (target - l.pitch) * Math.min(1, dt * 14);
      const bob = 0.0025 + Math.sin(t * 2.3 + i * 1.7) * 0.0012;
      l.outer.visible = true;
      l.outer.position.set(x, surface + bob, z);
      l.outer.rotation.set(l.pitch, 0, 0);
      l.inner.rotation.set(Math.sin(t * 1.9 + i) * 0.03, yaw, Math.sin(t * 2.6 + i * 2) * 0.03);
      l.shadow.visible = true;
      l.shadow.position.set(x - sunOff.x, (T ? T.bed(p.y) : 0) - DEPTH + 0.002, z - sunOff.y);
      l.shadow.rotation.set(0, yaw, 0);
      if (p.contact > 1.2 && t - l.lastContact > 0.35) {
        l.lastContact = t;
        this.spawnRipple(x, surface, z, 1);
      }
      // 滝壺に着水したら大きな波紋
      if (T && l.lastY !== null) {
        for (const d of T.course.drops) {
          const land = d.y + LIP;
          if (l.lastY < land && p.y >= land) {
            this.spawnRipple(x, this.waterAt(land + 2), -(land + 2) * S, 2.2);
            this.spawnRipple(x, this.waterAt(land + 2), -(land + 2) * S, 1.3);
          }
        }
      }
      l.lastY = p.y;
    });

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      const k = r.age / (0.9 + r.size * 0.2);
      r.mesh.scale.setScalar((0.02 + k * 0.09) * r.size);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - k);
      if (k >= 1) {
        this.scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        this.ripples.splice(i, 1);
      }
    }

    this.updateCamera(dt);
    this.sun.target.position.copy(this.camLook);
    this.sun.position.copy(this.camLook).addScaledVector(SKY.sun, 10);
    this.renderer.render(this.scene, this.camera);
    this.trackFps(dt);
  }

  private spawnRipple(x: number, y: number, z: number, size: number): void {
    if (this.ripples.length > 16) return;
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y + 0.002, z);
    m.renderOrder = 4;
    this.scene.add(m);
    this.ripples.push({ mesh: m, age: 0, size });
  }

  private updateCamera(dt: number): void {
    const poses = this.leaves.map((l) => l.pose).filter((p): p is LeafPose => !!p);
    const course = this.course;
    let focusX = this.centerAt(course ? course.startY : 0) / S;
    let focusY = course ? course.startY : 0;
    if (poses.length) {
      // 先頭の葉を中心に、2 枚とも入るように
      const lead = poses.reduce((a, b) => (a.y > b.y ? a : b));
      const tail = poses.reduce((a, b) => (a.y < b.y ? a : b));
      focusY = (lead.y * 2 + tail.y) / 3;
      focusX = poses.reduce((s, p) => s + p.x, 0) / poses.length;
    }
    const spread = poses.length > 1 ? Math.abs(poses[0].y - poses[1].y) * S : 0;
    const fx = focusX * S;
    const fz = -focusY * S;
    const offX = fx - this.centerAt(focusY);
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (this.cameraMode === 'follow') {
      const back = 0.5 + Math.min(spread, 1.2) * 0.6;
      const camY = focusY - back / S;
      // 蛇行しても水路の中から見る。高さは水面に合わせる
      pos.set(this.centerAt(camY) + offX * 0.6, this.waterAt(camY) + 0.1 + Math.min(spread, 1.5) * 0.12, fz + back);
      look.set(this.centerAt(focusY + 70) + offX, this.waterAt(focusY + 70), fz - 0.7);
    } else if (this.cameraMode === 'overhead') {
      const hgt = 1.4 + Math.min(spread, 2) * 0.8;
      pos.set(this.centerAt(focusY), this.waterAt(focusY) + hgt, fz + hgt * 0.35);
      look.set(this.centerAt(focusY + 15), this.waterAt(focusY + 15), fz - 0.15);
    } else {
      // デモ用：ゆっくり回り込む
      this.orbitT += dt;
      const a = this.orbitT * 0.12;
      const len = course ? course.length * S : 6;
      const z = poses.length ? fz : -((this.orbitT * 0.25) % len);
      const ycm = -z / S;
      pos.set(this.centerAt(ycm - 90) + Math.sin(a) * 0.55, this.waterAt(ycm - 90) + 0.22 + Math.sin(a * 0.7) * 0.08, z + 0.9 + Math.cos(a) * 0.3);
      look.set(this.centerAt(ycm + 60), this.waterAt(ycm + 60) - 0.01, z - 0.6);
    }
    if (!this.camInit) {
      this.camPos.copy(pos);
      this.camLook.copy(look);
      this.camInit = true;
    }
    const k = 1 - Math.exp(-dt * 2.5);
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  private trackFps(dt: number): void {
    if (!this.autoQuality) return;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc < 1) return;
    const fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this.lowFpsSeconds = fps < 26 ? this.lowFpsSeconds + 1 : 0;
    if (this.lowFpsSeconds >= 3 && this.quality !== 'eco') {
      this.lowFpsSeconds = 0;
      const next: EffectiveQuality = this.quality === 'high' ? 'standard' : 'eco';
      this.setQuality(next);
      this.onAutoDowngrade?.(next);
    }
  }

  /** 1 フレームだけ描く（停止中の再描画用） */
  renderOnce(): void {
    this.tick(0);
  }

  dispose(): void {
    this.stop();
    this.resizeObs.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.renderer.dispose();
  }
}

/** グループ配下のジオメトリとマテリアルを解放して取り外す */
function disposeTree(g: THREE.Object3D | null, parent: THREE.Object3D): void {
  if (!g) return;
  parent.remove(g);
  g.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Line) {
      o.geometry.dispose();
      const m = o.material as THREE.Material | THREE.Material[];
      (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
    }
  });
}

/** 葉っぱの外形から薄いメッシュを作る（重心原点、葉脈は元の葉の位置のまま） */
export function leafGeometry(polygon: Polygon, flat = false): THREE.BufferGeometry {
  const [gx, gy] = centroid(polygon);
  const shape = new THREE.Shape(polygon.map(([x, y]) => new THREE.Vector2((x - gx) * S, (y - gy) * S)));
  const geo = new THREE.ShapeGeometry(shape);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i) / S + gx;
    const ly = pos.getY(i) / S + gy;
    uv.setXY(i, (lx + LEAF_RULES.maxAbsX) / (2 * LEAF_RULES.maxAbsX), (ly + LEAF_RULES.maxAbsY) / (2 * LEAF_RULES.maxAbsY));
    // 縁を少し反らせる
    if (!flat) pos.setZ(i, 0.0025 * (lx * lx) / 7);
  }
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}
