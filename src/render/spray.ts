/**
 * 小さな滝のしぶき（GPU で時間から位置を計算するパーティクル。CPU の更新なし）。
 */
import * as THREE from 'three';

export interface SprayEmitter {
  /** 落ちた先の中心（m） */
  x: number;
  y: number;
  z: number;
  /** しぶきが出る横幅（m） */
  width: number;
  /** 勢い（落差 m に比例） */
  power: number;
}

export function createSpray(emitters: SprayEmitter[], perEmitter: number, time: { value: number }): THREE.Points {
  const n = emitters.length * perEmitter;
  const base = new Float32Array(n * 3);
  const seed = new Float32Array(n * 4);
  const params = new Float32Array(n * 2);
  let k = 0;
  for (const e of emitters) {
    for (let i = 0; i < perEmitter; i++, k++) {
      base[k * 3] = e.x + (Math.random() - 0.5) * e.width;
      base[k * 3 + 1] = e.y;
      base[k * 3 + 2] = e.z;
      seed[k * 4] = Math.random();
      seed[k * 4 + 1] = Math.random() - 0.5;
      seed[k * 4 + 2] = Math.random();
      seed[k * 4 + 3] = Math.random();
      params[k * 2] = e.power;
      params[k * 2 + 1] = 0.7 + Math.random() * 0.6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geo.setAttribute('aParam', new THREE.BufferAttribute(params, 2));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: time, uScale: { value: 300 } },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      attribute vec2 aParam;
      uniform float uTime;
      uniform float uScale;
      varying float vAlpha;
      void main() {
        float power = aParam.x;
        float life = fract(uTime * (1.6 + aSeed.z) + aSeed.x);
        float t = life * 0.22;
        // 上と下流（-z）へ飛び出して落ちる
        float vy = (0.35 + aSeed.w * 0.6) * power;
        vec3 p = position;
        p.y += vy * t - 4.9 * t * t;
        p.z -= (0.15 + aSeed.z * 0.35) * t * 2.0;
        p.x += aSeed.y * 0.5 * t;
        vAlpha = (1.0 - life) * 0.85;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aParam.y * uScale * (0.004 + 0.004 * aSeed.w) / -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d);
        if (r > 0.25) discard;
        gl_FragColor = vec4(vec3(0.95, 0.97, 1.0), vAlpha * (1.0 - r * 4.0));
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  return pts;
}
