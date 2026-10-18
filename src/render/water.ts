/**
 * 水面・空・水底のシェーダー。見た目専用で、勝敗に使う流速場とは完全に独立。
 */
import * as THREE from 'three';
import { SKY } from './textures.ts';

export const MAX_STONES = 16;

const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

export interface WaterUniforms {
  [k: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uFlow: THREE.IUniform<number>;
  uStones: THREE.IUniform<THREE.Vector4[]>;
  uStoneCount: THREE.IUniform<number>;
}

export function createWaterMaterial(octaves: number): THREE.ShaderMaterial & { uniforms: WaterUniforms } {
  const stones: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_STONES; i++) stones.push(new THREE.Vector4(0, 0, 0, 0));
  const uniforms: WaterUniforms = {
    uTime: { value: 0 },
    uFlow: { value: 0.42 },
    uStones: { value: stones },
    uStoneCount: { value: 0 },
    uSunDir: { value: SKY.sun.clone() },
    uSkyTop: { value: SKY.top.clone() },
    uSkyHorizon: { value: SKY.horizon.clone() },
    uWall: { value: new THREE.Color('#6f6a5f') },
    uDeep: { value: new THREE.Color('#2a4a3a') },
    uShallow: { value: new THREE.Color('#6f8a6a') },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    defines: { OCTAVES: octaves, MAX_STONES },
    vertexShader: /* glsl */ `
      attribute float aEdge;
      varying vec3 vWorld;
      varying float vEdge;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vEdge = aEdge;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFlow;
      uniform vec4 uStones[MAX_STONES];
      uniform int uStoneCount;
      uniform vec3 uSunDir;
      uniform vec3 uSkyTop;
      uniform vec3 uSkyHorizon;
      uniform vec3 uWall;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      varying vec3 vWorld;
      varying float vEdge;
      ${NOISE}

      // 流れ方向（-z）に引き伸ばされ、下流へ流れていく波の高さ
      float waveH(vec2 p) {
        float t = uTime;
        vec2 q = p + vec2(0.0, t * uFlow);
        float h = 0.0;
        float amp = 0.5;
        vec2 s = vec2(26.0, 9.0);
        for (int i = 0; i < OCTAVES; i++) {
          h += amp * vnoise(q * s + float(i) * 13.1 + vec2(0.0, t * 0.6 * float(i)));
          s *= 2.03;
          amp *= 0.5;
        }
        // 細かいさざ波
        h += 0.06 * vnoise(p * vec2(120.0, 60.0) + vec2(t * 1.3, t * uFlow * 60.0));
        return h;
      }

      void main() {
        vec2 p = vWorld.xz;
        float e = 0.004;
        // 石まわりの乱れ：波を強める
        float foam = 0.0;
        float rough = 1.0;
        for (int i = 0; i < MAX_STONES; i++) {
          if (i >= uStoneCount) break;
          vec4 s = uStones[i];
          vec2 d = p - s.xy;
          float dist = length(d) - s.z;
          // 石の縁の白波
          float ring = smoothstep(0.018, 0.0, dist) * (0.55 + 0.45 * vnoise(p * 90.0 + uTime * 3.0));
          // 下流（-z）側の後流の筋
          float down = -d.y;
          float lateral = abs(d.x) / (s.z * 1.4 + down * 0.25);
          float wake = down > 0.0 ? smoothstep(1.0, 0.2, lateral) * exp(-down / (s.z * 6.0)) : 0.0;
          float streak = wake * smoothstep(0.55, 0.9, vnoise(vec2(d.x * 120.0, d.y * 16.0 + uTime * uFlow * 16.0)));
          foam += ring * 0.5 + streak * 0.45;
          rough += wake * 1.5 + smoothstep(0.05, 0.0, dist) * 1.5;
        }
        // 岸際の泡と乱れ
        foam += smoothstep(0.012, 0.0, vEdge) * 0.35 * vnoise(vec2(p.y * 60.0 + uTime * uFlow * 60.0, p.x * 80.0));

        float h0 = waveH(p);
        float hx = waveH(p + vec2(e, 0.0));
        float hz = waveH(p + vec2(0.0, e));
        // 遠くの細かい凹凸は弱める（ちらつき防止）
        float camDist = length(cameraPosition - vWorld);
        float k = 0.045 * rough / (1.0 + camDist * 0.9);
        vec3 N = normalize(vec3(-(hx - h0) / e * k, 1.0, -(hz - h0) / e * k));

        vec3 V = normalize(cameraPosition - vWorld);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        // 細い水路なので、低い角度の反射は両岸のコンクリートを映す
        vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.8, R.y));
        float wallMix = smoothstep(0.45, 0.15, R.y);
        vec3 refl = mix(sky, uWall * (0.75 + 0.25 * vnoise(vWorld.xz * 20.0)), wallMix);
        float spec = pow(max(dot(R, uSunDir), 0.0), 300.0) * 1.4 + pow(max(dot(R, uSunDir), 0.0), 24.0) * 0.1;

        // 水そのものの色（浅い透明な水）
        vec3 body = mix(uShallow, uDeep, 0.35 + 0.3 * h0);
        vec3 col = mix(body, refl, fres);
        col += vec3(1.0, 0.97, 0.9) * spec * (1.0 - wallMix * 0.8);
        foam = clamp(foam, 0.0, 1.0);
        col = mix(col, vec3(0.93, 0.95, 0.93), foam * 0.8);
        float alpha = clamp(0.3 + fres * 0.8 + foam * 0.6 + spec * 0.5, 0.0, 0.97);
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
  return mat as THREE.ShaderMaterial & { uniforms: WaterUniforms };
}

/** 水底に揺らめく光（コースティクス）を足す */
export function addCaustics(mat: THREE.MeshStandardMaterial, time: { value: number }, flow: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uFlow = flow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCausticPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCausticPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uFlow;
        varying vec3 vCausticPos;
        ${NOISE}
        float caustic(vec2 p) {
          float t = uTime;
          vec2 q = p * vec2(34.0, 22.0) + vec2(0.0, t * uFlow * 22.0);
          float a = vnoise(q + vec2(t * 0.7, 0.0));
          float b = vnoise(q * 1.7 - vec2(0.0, t * 0.9));
          float c = 1.0 - abs(a - b) * 3.0;
          return pow(clamp(c, 0.0, 1.0), 6.0);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float under = step(vCausticPos.y, -0.005);
        totalEmissiveRadiance += vec3(0.95, 1.0, 0.85) * caustic(vCausticPos.xz) * 0.28 * under * diffuseColor.rgb * 2.0;`);
  };
}

/** 空（グラデーション＋太陽＋薄い雲） */
export function createSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: SKY.top.clone() },
      uHorizon: { value: SKY.horizon.clone() },
      uSun: { value: SKY.sun.clone() },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uSun;
      uniform float uTime;
      varying vec3 vDir;
      ${NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uTop, pow(h, 0.55));
        float sd = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.95, 0.85) * (pow(sd, 900.0) * 6.0 + pow(sd, 12.0) * 0.18);
        // 雲
        if (d.y > 0.02) {
          vec2 uv = d.xz / (d.y + 0.15) * 1.6 + vec2(uTime * 0.004, 0.0);
          float c = vnoise(uv * 2.0) * 0.6 + vnoise(uv * 5.0) * 0.3 + vnoise(uv * 11.0) * 0.1;
          c = smoothstep(0.55, 0.85, c) * smoothstep(0.02, 0.25, d.y);
          col = mix(col, vec3(0.98, 0.98, 0.97), c * 0.75);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
