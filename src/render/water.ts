/**
 * 水面・空・水底のシェーダー。見た目専用で、勝敗に使う流速場とは完全に独立。
 */
import * as THREE from 'three';
import { SKY } from './textures.ts';

export const MAX_STONES = 16;
export const MAX_DROPS = 6;
export const MAX_COVERS = 4;

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
  uDrops: THREE.IUniform<THREE.Vector4[]>;
  uDropCount: THREE.IUniform<number>;
  uCovers: THREE.IUniform<THREE.Vector2[]>;
  uCoverCount: THREE.IUniform<number>;
}

/** 側溝のふた（暗渠）の範囲。水面・水底・壁・葉で共有する uniform */
export interface CoverUniforms {
  uCovers: THREE.IUniform<THREE.Vector2[]>;
  uCoverCount: THREE.IUniform<number>;
}

export function createCoverUniforms(): CoverUniforms {
  const covers: THREE.Vector2[] = [];
  for (let i = 0; i < MAX_COVERS; i++) covers.push(new THREE.Vector2());
  return { uCovers: { value: covers }, uCoverCount: { value: 0 } };
}

/** ふたの下の暗さ（world z から） */
const COVER_SHADE = /* glsl */ `
  uniform vec2 uCovers[${4}];
  uniform int uCoverCount;
  float coverShade(vec3 wp) {
    float s = 1.0;
    for (int i = 0; i < ${4}; i++) {
      if (i >= uCoverCount) break;
      vec2 c = uCovers[i];
      // z は下流が負。c.x=上流端の z, c.y=下流端の z（c.x > c.y）
      float inside = smoothstep(c.y - 0.02, c.y + 0.06, wp.z) * smoothstep(c.x + 0.02, c.x - 0.06, wp.z);
      s = min(s, 1.0 - 0.72 * inside * step(wp.y, 0.22));
    }
    return s;
  }
`;

export function createWaterMaterial(octaves: number, cover: CoverUniforms): THREE.ShaderMaterial & { uniforms: WaterUniforms } {
  const stones: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_STONES; i++) stones.push(new THREE.Vector4(0, 0, 0, 0));
  const drops: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_DROPS; i++) drops.push(new THREE.Vector4(0, 0, 0, 0));
  const uniforms: WaterUniforms = {
    uTime: { value: 0 },
    uFlow: { value: 0.42 },
    uStones: { value: stones },
    uStoneCount: { value: 0 },
    uDrops: { value: drops },
    uDropCount: { value: 0 },
    uCovers: cover.uCovers,
    uCoverCount: cover.uCoverCount,
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
    defines: { OCTAVES: octaves, MAX_STONES, MAX_DROPS },
    vertexShader: /* glsl */ `
      attribute float aEdge;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vEdge;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vEdge = aEdge;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFlow;
      uniform vec4 uStones[MAX_STONES];
      uniform int uStoneCount;
      uniform vec4 uDrops[MAX_DROPS];
      uniform int uDropCount;
      varying vec3 vNormalW;
      ${COVER_SHADE}
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

        // 小さな滝：落ち口の手前はなめらか（ガラスのような舌）、落ちる水は白く筋になり、滝壺は泡立つ
        float glassy = 0.0;
        for (int i = 0; i < MAX_DROPS; i++) {
          if (i >= uDropCount) break;
          vec4 d = uDrops[i]; // x=落ち口の z, y=落差(m), z=切り欠き中心 x, w=切り欠き幅(m)
          float dz = d.x - p.y; // 下流向きの距離（m）
          if (dz < -0.13 || dz > 0.45) continue;
          float notch = d.w > 0.0 ? smoothstep(d.w * 0.9, d.w * 0.3, abs(p.x - d.z)) : 1.0;
          float strength = clamp(d.y / 0.05, 0.4, 1.8) * mix(0.55, 1.0, notch);
          glassy = max(glassy, smoothstep(-0.12, -0.03, dz) * smoothstep(0.004, -0.004, dz));
          float sheet = smoothstep(-0.002, 0.01, dz) * smoothstep(0.075, 0.05, dz);
          float streaks = smoothstep(0.45, 0.85, vnoise(vec2(p.x * 160.0, dz * 30.0 - uTime * 9.0)));
          foam += sheet * (0.35 + 0.55 * streaks) * strength;
          float pool = smoothstep(0.05, 0.08, dz) * (1.0 - smoothstep(0.08, 0.42, dz));
          float churn = vnoise(vec2(p.x * 70.0 + uTime * 1.7, dz * 50.0 - uTime * 4.0)) * 0.6
                      + vnoise(vec2(p.x * 150.0 - uTime * 2.3, dz * 110.0 - uTime * 6.0)) * 0.4;
          foam += pool * smoothstep(0.25, 0.75, churn + (1.0 - smoothstep(0.08, 0.3, dz)) * 0.45) * strength;
          rough += pool * 3.0 * strength;
        }
        rough *= 1.0 - 0.8 * glassy;

        float h0 = waveH(p);
        float hx = waveH(p + vec2(e, 0.0));
        float hz = waveH(p + vec2(0.0, e));
        // 遠くの細かい凹凸は弱める（ちらつき防止）
        float camDist = length(cameraPosition - vWorld);
        float k = 0.045 * rough / (1.0 + camDist * 0.9);
        vec3 N = normalize(vNormalW + vec3(-(hx - h0) / e * k, 0.0, -(hz - h0) / e * k));

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
        float shade = coverShade(vWorld);
        gl_FragColor = vec4(col * shade, mix(alpha, 0.92, 1.0 - shade));
        #include <colorspace_fragment>
      }
    `,
  });
  return mat as THREE.ShaderMaterial & { uniforms: WaterUniforms };
}

/** 水底に揺らめく光（コースティクス）を足す */
/** ふたの下を暗くする（標準マテリアル用） */
export function addCoverShade(mat: THREE.Material, cover: CoverUniforms): void {
  mat.onBeforeCompile = (shader) => injectCoverShade(shader, cover);
}

export function injectCoverShade(shader: THREE.WebGLProgramParametersWithUniforms, cover: CoverUniforms): void {
  shader.uniforms.uCovers = cover.uCovers;
  shader.uniforms.uCoverCount = cover.uCoverCount;
  if (!shader.vertexShader.includes('vShadePos')) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShadePos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        #ifdef USE_INSTANCING
          vShadePos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vShadePos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
  }
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vShadePos;\n${COVER_SHADE}`)
    .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb *= coverShade(vShadePos);');
}

export function addCaustics(mat: THREE.MeshStandardMaterial, time: { value: number }, flow: { value: number }, cover: CoverUniforms): void {
  mat.onBeforeCompile = (shader) => {
    injectCoverShade(shader, cover);
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
