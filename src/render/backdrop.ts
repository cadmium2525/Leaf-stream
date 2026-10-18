/**
 * コースごとの遠景：田園（用水路）・住宅街（側溝）・山あいの杉林（小川）。
 */
import * as THREE from 'three';
import type { CourseStyle } from '../../packages/sim-core/src/index.ts';
import { rng } from './terrain.ts';
import { paddyMap } from './textures.ts';

export type Env = 'paddy' | 'town' | 'mountain';

export function envOf(style: CourseStyle): Env {
  return style === 'gutter' ? 'town' : style === 'natural' ? 'mountain' : 'paddy';
}

/** 環境ごとの霧の色・距離 */
export const ENV_FOG: Record<Env, { color: string; near: number; far: number }> = {
  paddy: { color: '#dfe8e6', near: 18, far: 140 },
  town: { color: '#e2e6e6', near: 14, far: 110 },
  mountain: { color: '#c9d8d0', near: 10, far: 80 },
};

function houses(g: THREE.Group, r: () => number, n: number, near: number, far: number, groundY: number): void {
  const wallMats = [0xe9e2d0, 0xd8cfbb, 0xc7c1b4, 0xefe8db, 0xb9b3a6].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
  const roofMats = [0x3e4652, 0x4b3f3a, 0x2f3b45, 0x5a3b30].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));
  const roofShape = new THREE.Shape([new THREE.Vector2(-0.55, 0), new THREE.Vector2(0.55, 0), new THREE.Vector2(0, 0.42)]);
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 1, bevelEnabled: false });
  roofGeo.translate(0, 0, -0.5);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? -1 : 1;
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
    house.position.set(side * (near + r() * (far - near)), groundY, 12 - r() * 130);
    house.rotation.y = (r() - 0.5) * 0.3 + (r() < 0.3 ? Math.PI / 2 : 0);
    g.add(house);
  }
}

function poles(g: THREE.Group, x: number, groundY: number): void {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 0.8 });
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 9, 8);
  const tops: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    const z = 6 - i * 28;
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, groundY + 4.5, z);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.08), poleMat);
    arm.position.set(x, groundY + 8.7, z);
    g.add(pole, arm);
    tops.push(new THREE.Vector3(x, groundY + 8.75, z));
  }
  const wireMat = new THREE.LineBasicMaterial({ color: 0x2a2a2a });
  for (const off of [-0.6, 0.6]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i + 1 < tops.length; i++) {
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const p = tops[i].clone().lerp(tops[i + 1], t);
        p.x += off;
        p.y -= Math.sin(Math.PI * t) * 0.6;
        pts.push(p);
      }
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
  }
}

function hills(g: THREE.Group, r: () => number, n: number, color: number, dist: [number, number], scale: number): void {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
  for (let i = 0; i < n; i++) {
    const hill = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), mat);
    const side = i % 2 === 0 ? -1 : 1;
    const d = dist[0] + r() * (dist[1] - dist[0]);
    const sx = (30 + r() * 40) * scale;
    // 丘の裾が水路から 12m 以上離れるように置く
    hill.position.set(side * (sx + 12 + r() * 80), -4, -d + r() * 50 - 30);
    hill.scale.set(sx, (14 + r() * 22) * scale, (25 + r() * 30) * scale);
    g.add(hill);
  }
}

/** 杉と広葉樹の林（インスタンス描画） */
function forest(g: THREE.Group, r: () => number, count: number, groundY: number): void {
  const cone = new THREE.ConeGeometry(1, 1, 7);
  cone.translate(0, 0.5, 0);
  const trunk = new THREE.CylinderGeometry(0.08, 0.12, 1, 6);
  trunk.translate(0, 0.5, 0);
  const crown = new THREE.IcosahedronGeometry(1, 1);
  const cedar = new THREE.InstancedMesh(cone, new THREE.MeshStandardMaterial({ color: 0x2c4a2c, roughness: 0.95, flatShading: true }), count);
  const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }), count);
  const broad = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: 0x4a6b34, roughness: 0.95, flatShading: true }), Math.floor(count / 3));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const color = new THREE.Color();
  let nb = 0;
  for (let i = 0; i < count; i++) {
    const side = r() < 0.5 ? -1 : 1;
    const dist = 2.2 + Math.pow(r(), 0.7) * 40;
    const x = side * dist;
    const z = 14 - r() * 140;
    const h = 5 + r() * 9;
    const y = groundY - 0.2 + (dist > 6 ? (dist - 6) * 0.25 : 0);
    q.setFromEuler(new THREE.Euler(0, r() * 6.28, 0));
    m.compose(new THREE.Vector3(x, y + h * 0.25, z), q, new THREE.Vector3(h * 0.2, h * 0.8, h * 0.2));
    cedar.setMatrixAt(i, m);
    color.setHSL(0.33 + (r() - 0.5) * 0.04, 0.35, 0.18 + r() * 0.08);
    cedar.setColorAt(i, color);
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, h * 0.35, 1));
    trunks.setMatrixAt(i, m);
    if (i % 3 === 0 && nb < broad.count) {
      const bx = side * (2 + r() * 25);
      const s = 1.5 + r() * 2.5;
      m.compose(new THREE.Vector3(bx, groundY + s * 0.9, 12 - r() * 140), q, new THREE.Vector3(s * 1.2, s, s * 1.1));
      broad.setMatrixAt(nb, m);
      color.setHSL(0.25 + r() * 0.06, 0.4, 0.3 + r() * 0.1);
      broad.setColorAt(nb, color);
      nb++;
    }
  }
  broad.count = nb;
  for (const im of [cedar, trunks, broad]) {
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    g.add(im);
  }
}

export function buildBackdrop(env: Env, treeCount: number): THREE.Group {
  const g = new THREE.Group();
  const r = rng(env === 'paddy' ? 77 : env === 'town' ? 78 : 79);
  if (env === 'paddy') {
    const tex = paddyMap(256);
    tex.repeat.set(60, 60);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, color: 0xc8d6a8 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.32;
    ground.receiveShadow = true;
    g.add(ground);
    hills(g, r, 14, 0x3f5a3c, [90, 160], 1);
    houses(g, r, 12, 14, 54, -0.32);
    poles(g, 5.5, -0.4);
  } else if (env === 'town') {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x6a6a66, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    g.add(ground);
    hills(g, r, 8, 0x4a5f4a, [120, 180], 0.8);
    houses(g, r, 26, 3.5, 18, -0.2);
    poles(g, 3.2, -0.2);
  } else {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x3b4a2c, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.9;
    g.add(ground);
    hills(g, r, 18, 0x2f4a33, [45, 110], 1.2);
    forest(g, r, treeCount, -0.5);
    // 遠くに一軒だけ古い民家
    houses(g, r, 2, 26, 40, -0.9);
  }
  return g;
}
