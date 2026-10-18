/**
 * 用水路の 3D 描画。
 * - 座標変換：sim (x, y)[cm] → three (x/100, 0, -y/100)[m]。下流は -z
 * - 勝敗の計算は一切しない。確定済みの軌跡（LeafPose）を受け取って表示するだけ
 */
import * as THREE from 'three';
import {
  LEAF_RULES, centroid, halfWidthAt, type Course, type LeafPose, type Polygon,
} from '../../packages/sim-core/src/index.ts';
import { concreteMaps, grassMaps, leafTexture, paddyMap, pebbleMaps, SKY, type LeafTone } from './textures.ts';
import { MAX_STONES, addCaustics, createSkyMaterial, createWaterMaterial } from './water.ts';

export type EffectiveQuality = 'high' | 'standard' | 'eco';
export type CameraMode = 'follow' | 'overhead' | 'orbit';

const S = 0.01; // cm → m
const DEPTH = 0.09; // 水深
const WALL_TOP = 0.2; // 水面からの壁の高さ
const WALL_T = 0.08; // 壁の厚み

const QUALITY: Record<EffectiveQuality, { dpr: number; shadows: boolean; octaves: number; tex: number; grass: number; aa: boolean }> = {
  high: { dpr: 2, shadows: true, octaves: 4, tex: 1024, grass: 7000, aa: true },
  standard: { dpr: 1.5, shadows: false, octaves: 3, tex: 512, grass: 2800, aa: true },
  eco: { dpr: 1, shadows: false, octaves: 2, tex: 256, grass: 700, aa: false },
};

export interface LeafVisual {
  polygon: Polygon;
  tone: LeafTone;
}

interface LeafObj {
  group: THREE.Group;
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  pose: LeafPose | null;
  lastContact: number;
}

interface Ripple {
  mesh: THREE.Mesh;
  age: number;
}

/** 描画用の再現可能な乱数 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  private course: Course | null = null;
  private courseGroup: THREE.Group | null = null;
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
  private textures: Record<string, { map: THREE.Texture; normalMap?: THREE.Texture }> = {};
  private leafTextures = new Map<LeafTone, THREE.Texture>();
  private resizeObs: ResizeObserver;
  private grassMat: THREE.MeshStandardMaterial | null = null;

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
    this.buildBackdrop();
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
      t.normalMap?.dispose();
    }
    this.textures = {
      concrete: concreteMaps(n),
      pebble: pebbleMaps(n),
      grass: grassMaps(Math.min(n, 512)),
      paddy: { map: paddyMap(256) },
    };
  }

  setQuality(q: EffectiveQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.buildTextures();
    this.applyQuality();
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

  // ---------------------------------------------------------------- 背景

  private buildBackdrop(): void {
    const g = new THREE.Group();
    const r = rng(77);
    // 田んぼ
    const paddyTex = this.textures.paddy.map.clone();
    paddyTex.needsUpdate = true;
    paddyTex.repeat.set(60, 60);
    const paddy = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ map: paddyTex, roughness: 0.9, color: 0xc8d6a8 }),
    );
    paddy.rotation.x = -Math.PI / 2;
    paddy.position.y = -0.32;
    paddy.receiveShadow = true;
    g.add(paddy);
    // 遠くの山
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x3f5a3c, roughness: 1, flatShading: true });
    for (let i = 0; i < 14; i++) {
      const hill = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), hillMat);
      const side = i % 2 === 0 ? -1 : 1;
      const dist = 90 + r() * 70;
      hill.position.set(side * (40 + r() * 120), -4, -dist + r() * 60 - 40);
      hill.scale.set(30 + r() * 40, 14 + r() * 22, 25 + r() * 30);
      g.add(hill);
    }
    // 家並み
    const wallMats = [0xe9e2d0, 0xd8cfbb, 0xc7c1b4, 0xefe8db].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
    const roofMats = [0x3e4652, 0x4b3f3a, 0x2f3b45].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));
    const roofShape = new THREE.Shape([new THREE.Vector2(-0.55, 0), new THREE.Vector2(0.55, 0), new THREE.Vector2(0, 0.42)]);
    const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 1, bevelEnabled: false });
    roofGeo.translate(0, 0, -0.5);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 12; i++) {
      const side = r() < 0.5 ? -1 : 1;
      const house = new THREE.Group();
      const w = 6 + r() * 4;
      const d = 5 + r() * 4;
      const hgt = 3 + (r() < 0.5 ? 2.8 : 0);
      const body = new THREE.Mesh(boxGeo, wallMats[i % wallMats.length]);
      body.scale.set(w, hgt, d);
      body.position.y = hgt / 2;
      const roof = new THREE.Mesh(roofGeo, roofMats[i % roofMats.length]);
      roof.scale.set(w * 1.15, w * 0.9, d * 1.1);
      roof.position.y = hgt;
      house.add(body, roof);
      house.position.set(side * (14 + r() * 40), -0.32, 10 - r() * 120);
      house.rotation.y = (r() - 0.5) * 0.4 + (r() < 0.3 ? Math.PI / 2 : 0);
      g.add(house);
    }
    // 電柱と電線
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 0.8 });
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 9, 8);
    const wirePts: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      const z = 6 - i * 28;
      pole.position.set(5.5, 4.1, z);
      g.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.08), poleMat);
      arm.position.set(5.5, 8.4, z);
      g.add(arm);
      wirePts.push(new THREE.Vector3(4.9, 8.45, z), new THREE.Vector3(6.1, 8.45, z));
    }
    const wireMat = new THREE.LineBasicMaterial({ color: 0x2a2a2a });
    for (const off of [0, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i + 1 < 8; i++) {
        const a = wirePts[i * 2 + off];
        const b = wirePts[(i + 1) * 2 + off];
        for (let k = 0; k <= 10; k++) {
          const t = k / 10;
          const p = a.clone().lerp(b, t);
          p.y -= Math.sin(Math.PI * t) * 0.6;
          pts.push(p);
        }
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
    }
    this.scene.add(g);
  }

  // ---------------------------------------------------------------- コース

  setCourse(course: Course): void {
    this.course = course;
    if (this.courseGroup) {
      this.scene.remove(this.courseGroup);
      this.courseGroup.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
        }
      });
    }
    const g = new THREE.Group();
    this.courseGroup = g;
    const q = QUALITY[this.quality];
    this.flow.value = course.baseSpeed * S;

    const y0 = -260;
    const y1 = course.length + 400;
    const step = 10;
    const ys: number[] = [];
    for (let y = y0; y <= y1; y += step) ys.push(y);
    const hw = (y: number) => halfWidthAt(course, Math.min(Math.max(y, 0), course.length)) * S;

    // 水底
    const bottomMaps = this.textures.pebble;
    const bottomMat = new THREE.MeshStandardMaterial({
      map: bottomMaps.map, normalMap: bottomMaps.normalMap, roughness: 0.75, color: 0xd8d2c0,
    });
    addCaustics(bottomMat, this.time, this.flow);
    const bottom = new THREE.Mesh(this.ribbon(ys, hw, -DEPTH, 5, 0.45, 0.04), bottomMat);
    bottom.receiveShadow = true;
    g.add(bottom);

    // 壁（内面＋天端＋外面）
    const cm = this.textures.concrete;
    const wallMat = new THREE.MeshStandardMaterial({
      map: cm.map, normalMap: cm.normalMap, roughness: 0.92, vertexColors: true,
    });
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(this.wallGeometry(ys, hw, side), wallMat);
      wall.receiveShadow = true;
      wall.castShadow = q.shadows;
      g.add(wall);
    }

    // 土手の草地
    const gm = this.textures.grass;
    const bankMat = new THREE.MeshStandardMaterial({ map: gm.map, normalMap: gm.normalMap, roughness: 0.95, color: 0xdfe8c8 });
    for (const side of [-1, 1]) {
      const bank = new THREE.Mesh(this.bankGeometry(ys, hw, side), bankMat);
      bank.receiveShadow = true;
      g.add(bank);
    }
    this.addGrass(g, ys, hw, q.grass);

    // 石
    const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0 });
    const r = rng(course.seed ^ 0x51);
    for (const s of course.stones) {
      const geo = new THREE.IcosahedronGeometry(1, this.quality === 'eco' ? 2 : 3);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const phase = [r() * 10, r() * 10, r() * 10];
      const colors: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i);
        const n = 1 + 0.18 * Math.sin(v.x * 3.1 + phase[0]) * Math.sin(v.y * 2.7 + phase[1]) + 0.1 * Math.sin(v.z * 5.3 + phase[2]);
        v.multiplyScalar(n);
        pos.setXYZ(i, v.x, v.y, v.z);
        // 上面は苔、水に濡れた部分は暗く
        const mossy = Math.max(0, v.y) * (0.6 + 0.4 * Math.sin(v.x * 7 + phase[0]));
        const base = 0.36 + 0.08 * Math.sin(v.x * 11 + v.z * 9);
        colors.push(
          base * (1 - mossy) + 0.27 * mossy,
          base * (1 - mossy) + 0.38 * mossy,
          base * 0.95 * (1 - mossy) + 0.16 * mossy,
        );
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, stoneMat);
      const rr = s.r * S;
      m.scale.set(rr, 0.07, rr * 0.92);
      m.position.set(s.x * S, -0.035, -s.y * S);
      m.rotation.y = r() * Math.PI;
      m.castShadow = q.shadows;
      m.receiveShadow = true;
      g.add(m);
    }

    // スタート・ゴールの目印（竹の棒としめ縄風の紐）
    const bambooMat = new THREE.MeshStandardMaterial({ color: 0x9c8a4a, roughness: 0.6 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0xd9cfae, roughness: 0.9 });
    for (const [y, tall] of [[course.startY, 0.18], [course.goalY, 0.3]] as const) {
      const w = hw(y);
      for (const side of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.009, tall + DEPTH, 8), bambooMat);
        pole.position.set(side * (w + 0.02), (tall - DEPTH) / 2 + WALL_TOP * 0.5, -y * S);
        pole.castShadow = q.shadows;
        g.add(pole);
      }
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, w * 2 + 0.04, 6), ropeMat);
      rope.rotation.z = Math.PI / 2;
      rope.position.set(0, WALL_TOP * 0.5 + tall - 0.02, -y * S);
      g.add(rope);
    }

    // 水面
    this.water = createWaterMaterial(q.octaves);
    this.water.uniforms.uFlow.value = this.flow.value;
    const stones = this.water.uniforms.uStones.value;
    course.stones.slice(0, MAX_STONES).forEach((s, i) => stones[i].set(s.x * S, -s.y * S, s.r * S * 0.95, 1));
    this.water.uniforms.uStoneCount.value = Math.min(course.stones.length, MAX_STONES);
    const water = new THREE.Mesh(this.ribbon(ys, hw, 0, 9, 1, 1, true), this.water);
    water.renderOrder = 2;
    g.add(water);

    this.scene.add(g);
    // 葉の描画順を水より後に
    for (const l of this.leaves) l.mesh.renderOrder = 3;
    this.camInit = false;
  }

  /** 流れ方向に沿った帯（水底・水面） */
  private ribbon(ys: number[], hw: (y: number) => number, height: number, cols: number, tile: number, shrink: number, edgeAttr = false): THREE.BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const edge: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < ys.length; i++) {
      const w = hw(ys[i]) + shrink * 0.01;
      const z = -ys[i] * S;
      for (let c = 0; c < cols; c++) {
        const t = c / (cols - 1);
        const x = -w + 2 * w * t;
        pos.push(x, height, z);
        uv.push(x / tile, z / tile);
        edge.push(w - Math.abs(x));
      }
    }
    for (let i = 0; i + 1 < ys.length; i++) {
      for (let c = 0; c + 1 < cols; c++) {
        const a = i * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        idx.push(a, b, d, b, e, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (edgeAttr) geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** 片側の壁：内面（水底→天端）・天端・外面 */
  private wallGeometry(ys: number[], hw: (y: number) => number, side: number): THREE.BufferGeometry {
    // 断面の点（内側から順に）：[オフセット x, 高さ y, v 座標, 色]
    const prof: [number, number, number, number[]][] = [
      [0, -DEPTH - 0.01, 0, [0.42, 0.47, 0.36]],
      [0, -0.012, 0.09, [0.5, 0.55, 0.4]],
      [0, 0.004, 0.11, [0.62, 0.63, 0.52]],
      [0, 0.05, 0.16, [0.88, 0.88, 0.82]],
      [0, WALL_TOP, 0.3, [1, 1, 1]],
      [WALL_T, WALL_TOP, 0.38, [0.95, 0.95, 0.92]],
      [WALL_T, WALL_TOP - 0.02, 0.4, [0.8, 0.82, 0.75]],
    ];
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const np = prof.length;
    for (let i = 0; i < ys.length; i++) {
      const w = hw(ys[i]);
      const z = -ys[i] * S;
      for (const [ox, y, v, c] of prof) {
        pos.push(side * (w + ox), y, z);
        uv.push(z / 0.6, v / 0.6 * 1.6);
        col.push(...c);
      }
    }
    for (let i = 0; i + 1 < ys.length; i++) {
      for (let k = 0; k + 1 < np; k++) {
        const a = i * np + k;
        const b = a + 1;
        const d = a + np;
        const e = d + 1;
        if (side < 0) idx.push(a, d, b, b, d, e);
        else idx.push(a, b, d, b, e, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** 壁の外側の土手（田んぼへ向かってゆるく下る） */
  private bankGeometry(ys: number[], hw: (y: number) => number, side: number): THREE.BufferGeometry {
    const prof: [number, number][] = [[WALL_T - 0.005, WALL_TOP - 0.005], [0.6, WALL_TOP + 0.02], [1.6, 0.1], [3.2, -0.2], [4.5, -0.34]];
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const np = prof.length;
    for (let i = 0; i < ys.length; i++) {
      const w = hw(ys[i]);
      const z = -ys[i] * S;
      for (const [ox, y] of prof) {
        const x = side * (w + ox);
        pos.push(x, y, z);
        uv.push(x / 0.8, z / 0.8);
      }
    }
    for (let i = 0; i + 1 < ys.length; i++) {
      for (let k = 0; k + 1 < np; k++) {
        const a = i * np + k;
        const b = a + 1;
        const d = a + np;
        const e = d + 1;
        if (side < 0) idx.push(a, d, b, b, d, e);
        else idx.push(a, b, d, b, e, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** 土手の草（インスタンス描画、風で揺れる） */
  private addGrass(g: THREE.Group, ys: number[], hw: (y: number) => number, count: number): void {
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
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float sway = sin(uTime * 1.7 + wp.x * 2.0 + wp.z * 1.3) * 0.5 + sin(uTime * 3.1 + wp.z * 4.0) * 0.25;
          transformed.x += sway * 0.18 * position.y * position.y;
          transformed.z += sway * 0.08 * position.y * position.y;`);
    };
    this.grassMat = mat;
    const mesh = new THREE.InstancedMesh(blade, mat, count);
    const r = rng(1234);
    const m = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const e = new THREE.Euler();
    const yMin = ys[0];
    const yMax = ys[ys.length - 1];
    for (let i = 0; i < count; i++) {
      const y = yMin + r() * (yMax - yMin);
      const side = r() < 0.5 ? -1 : 1;
      // 壁際に多く、外へ行くほどまばら
      const off = WALL_T + 0.06 + Math.pow(r(), 1.6) * 1.4;
      const x = side * (hw(y) + off);
      const ground = off < 0.6 ? WALL_TOP + 0.02 * (off / 0.6) : WALL_TOP + 0.02 - (off - 0.6) * 0.1;
      const hgt = 0.03 + r() * r() * 0.12;
      e.set((r() - 0.5) * 0.5, r() * Math.PI, (r() - 0.5) * 0.5);
      qt.setFromEuler(e);
      m.compose(new THREE.Vector3(x, ground - 0.005, -y * S), qt, new THREE.Vector3(hgt * (0.8 + r() * 0.6), hgt, hgt));
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
      this.scene.remove(l.group);
      l.mesh.geometry.dispose();
      (l.mesh.material as THREE.Material).dispose();
      l.shadow.geometry.dispose();
      (l.shadow.material as THREE.Material).dispose();
    }
    this.leaves = visuals.map((v) => {
      const geo = leafGeometry(v.polygon);
      const mat = new THREE.MeshStandardMaterial({
        map: this.leafTex(v.tone), side: THREE.DoubleSide, roughness: 0.45, metalness: 0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = QUALITY[this.quality].shadows;
      mesh.renderOrder = 3;
      const shadowGeo = leafGeometry(v.polygon, true);
      const shadow = new THREE.Mesh(
        shadowGeo,
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
      );
      shadow.renderOrder = 1;
      const group = new THREE.Group();
      group.add(mesh);
      group.visible = false;
      this.scene.add(group, shadow);
      shadow.visible = false;
      return { group, mesh, shadow, pose: null, lastContact: 0 };
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
    const v = new THREE.Vector3(l.pose.x * S, 0.03, -l.pose.y * S).project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  get hasCourse(): boolean {
    return this.course !== null;
  }

  setCameraMode(m: CameraMode): void {
    this.cameraMode = m;
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

    const sunOff = new THREE.Vector2(SKY.sun.x, SKY.sun.z).multiplyScalar(DEPTH / SKY.sun.y);
    this.leaves.forEach((l, i) => {
      if (!l.pose) {
        l.group.visible = false;
        l.shadow.visible = false;
        return;
      }
      const p = l.pose;
      const x = p.x * S;
      const z = -p.y * S;
      const yaw = Math.atan2(p.s, p.c);
      // 見た目だけの浮き沈み（勝敗には無関係）
      const bob = 0.0025 + Math.sin(t * 2.3 + i * 1.7) * 0.0012;
      l.group.visible = true;
      l.group.position.set(x, bob, z);
      l.group.rotation.set(Math.sin(t * 1.9 + i) * 0.03, yaw, Math.sin(t * 2.6 + i * 2) * 0.03);
      l.shadow.visible = true;
      l.shadow.position.set(x - sunOff.x, -DEPTH + 0.002, z - sunOff.y);
      l.shadow.rotation.set(0, yaw, 0);
      if (p.contact > 1.2 && t - l.lastContact > 0.35) {
        l.lastContact = t;
        this.spawnRipple(x, z);
      }
    });

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      const k = r.age / 0.9;
      r.mesh.scale.setScalar(0.02 + k * 0.09);
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

  private spawnRipple(x: number, z: number): void {
    if (this.ripples.length > 12) return;
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.002, z);
    m.renderOrder = 4;
    this.scene.add(m);
    this.ripples.push({ mesh: m, age: 0 });
  }

  private updateCamera(dt: number): void {
    const poses = this.leaves.map((l) => l.pose).filter((p): p is LeafPose => !!p);
    const course = this.course;
    let focusX = 0;
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
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (this.cameraMode === 'follow') {
      const back = 0.5 + Math.min(spread, 1.2) * 0.6;
      pos.set(fx * 0.6, 0.1 + Math.min(spread, 1.5) * 0.12, fz + back);
      look.set(fx, 0.0, fz - 0.7);
    } else if (this.cameraMode === 'overhead') {
      const hgt = 1.4 + Math.min(spread, 2) * 0.8;
      pos.set(0, hgt, fz + hgt * 0.35);
      look.set(0, 0, fz - 0.15);
    } else {
      // デモ用：ゆっくり回り込む
      this.orbitT += dt;
      const a = this.orbitT * 0.12;
      const len = course ? course.length * S : 6;
      const z = poses.length ? fz : -((this.orbitT * 0.25) % len);
      pos.set(Math.sin(a) * 0.55, 0.22 + Math.sin(a * 0.7) * 0.08, z + 0.9 + Math.cos(a) * 0.3);
      look.set(0, -0.01, z - 0.6);
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
    this.grassMat?.dispose();
  }
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
