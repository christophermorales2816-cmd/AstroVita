/**
 * ASTROVITA — procedural planet surface shader.
 *
 * ARTISTIC MODEL. No exoplanet in this catalog has ever been imaged at a
 * resolution that shows surface detail. Everything this shader draws is a
 * procedural interpretation driven by *measured* bulk properties (radius, mass,
 * equilibrium temperature) and, where available, detected atmospheric species.
 * It is never a photograph and the UI labels it as such.
 *
 * Technique: 3D simplex noise (Ashima/Gustavson formulation) composed into
 * fractal brownian motion, ridged noise for terrain relief, and domain warping
 * for the turbulent structures on giants. A single uniform int selects the
 * visual profile so one material serves every planet class.
 */

import * as THREE from 'three'
import { hexToRgb, SURFACE_PROFILE } from '../services/dataNormalizer.js'

const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * snoise(p * freq);
    freq *= lacunarity;
    amp *= gain;
  }
  return sum;
}

// Ridged multifractal: sharp crests, used for rocky relief.
float ridged(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(snoise(p * freq));
    sum += amp * n * n;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}
`

export const vertexShader = /* glsl */ `
varying vec3 vObjectPos;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vObjectPos = normalize(position);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

export const fragmentShader = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uSeed;
uniform vec3  uLow;
uniform vec3  uMid;
uniform vec3  uHigh;
uniform vec3  uAccent;
uniform vec3  uLightDir;
uniform int   uProfile;
uniform float uBandStrength;
uniform float uCloudStrength;
uniform float uTidalLock;
uniform float uHeat;
uniform float uDetail;

varying vec3 vObjectPos;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

${NOISE_GLSL}

void main() {
  vec3 sp = normalize(vObjectPos);
  vec3 seedOffset = vec3(uSeed * 137.13, uSeed * 71.7, uSeed * 219.9);
  vec3 p = sp * 2.4 + seedOffset;

  int octaves = uDetail > 0.5 ? 6 : 4;

  // Domain warp: makes structures curl instead of looking like plain noise.
  vec3 warp = vec3(
    fbm(p + vec3(0.0, 1.3, 2.1), 3, 2.0, 0.5),
    fbm(p + vec3(3.7, 0.4, 1.1), 3, 2.0, 0.5),
    fbm(p + vec3(1.9, 2.8, 0.3), 3, 2.0, 0.5)
  );

  float base = fbm(p + warp * 0.9, octaves, 2.05, 0.5);
  float relief = ridged(p * 1.7 + warp * 0.4, octaves);

  float latitude = sp.y;
  float absLat = abs(latitude);

  vec3 color;
  float shininess = 0.0;

  if (uProfile == 2 || uProfile == 3) {
    // Gas giant / hot Jupiter: latitudinal bands distorted by the warp field,
    // plus slow zonal drift and a storm vortex.
    float bandCoord = latitude * 9.0 + warp.y * 1.6 + uTime * 0.015;
    float bands = sin(bandCoord) * 0.5 + 0.5;
    bands = mix(bands, smoothstep(0.25, 0.75, bands), 0.65);
    bands = mix(0.5, bands, clamp(uBandStrength, 0.0, 1.0));
    float turbulence = fbm(p * 1.6 + vec3(uTime * 0.03, 0.0, 0.0), octaves, 2.1, 0.55);

    color = mix(uLow, uMid, clamp(bands + turbulence * 0.35, 0.0, 1.0));
    color = mix(color, uHigh, smoothstep(0.55, 1.0, bands * 0.7 + turbulence * 0.5));

    // A single long-lived storm, positioned deterministically by the seed.
    vec3 stormAxis = normalize(vec3(cos(uSeed * 6.28), 0.28, sin(uSeed * 6.28)));
    float storm = smoothstep(0.90, 0.995, dot(sp, stormAxis));
    color = mix(color, uAccent, storm * 0.75);

    color = mix(color, color * 1.35 + uAccent * 0.25, uHeat * float(uProfile == 3));
  } else if (uProfile == 1 || uProfile == 6) {
    // Ocean world / Hycean candidate: animated liquid field with shorelines.
    float swell = fbm(p * 1.35 + vec3(uTime * 0.035, uTime * 0.018, 0.0), octaves, 2.0, 0.55);
    float landMask = smoothstep(0.12, 0.38, base + relief * 0.25);

    vec3 deep = uLow;
    vec3 shallow = uMid;
    vec3 land = uHigh;

    color = mix(deep, shallow, smoothstep(-0.25, 0.35, swell));
    color = mix(color, land, landMask * (uProfile == 6 ? 0.25 : 0.85));
    shininess = (1.0 - landMask) * 0.85;

    // Polar caps only where a temperate world could plausibly hold them.
    float caps = smoothstep(0.78, 0.93, absLat) * (1.0 - uHeat);
    color = mix(color, uAccent, caps * 0.8);
  } else if (uProfile == 4) {
    // Ice world: fractured plates and bright, low-contrast terrain.
    float plates = ridged(p * 2.6, octaves);
    float cracks = smoothstep(0.62, 0.72, plates);
    color = mix(uLow, uMid, smoothstep(-0.3, 0.5, base));
    color = mix(color, uHigh, cracks * 0.8);
    color = mix(color, uAccent, smoothstep(0.55, 0.95, absLat) * 0.6);
    shininess = 0.35;
  } else if (uProfile == 5) {
    // Lava world: a molten network glowing through cooled crust.
    float crust = smoothstep(0.15, 0.55, base + relief * 0.5);
    float veins = smoothstep(0.55, 0.78, ridged(p * 3.1 + vec3(uTime * 0.02), octaves));
    color = mix(uMid, uLow, crust);
    float emissive = veins * (1.0 - crust * 0.55);
    color = mix(color, uHigh, emissive);
    color += uAccent * emissive * 0.65;
  } else if (uProfile == 7) {
    // Tidally locked rock: a permanent substellar hemisphere. The boundary is
    // fixed in object space along +X, so it stays put as the body rotates for
    // inspection - which is the point of visualising a locked world.
    float dayNight = smoothstep(-0.35, 0.45, sp.x);
    float terrain = base * 0.6 + relief * 0.5;

    vec3 nightSide = mix(uLow, uLow * 0.45 + uAccent * 0.12, smoothstep(-0.2, 0.6, terrain));
    vec3 daySide = mix(uMid, uHigh, smoothstep(-0.1, 0.7, terrain));

    color = mix(nightSide, daySide, dayNight);
    // Terminator ice belt: the classic eyeball-world visualisation.
    float belt = smoothstep(0.35, 0.05, abs(sp.x + 0.12));
    color = mix(color, uAccent, belt * 0.35 * (1.0 - uHeat));
  } else {
    // Rocky / terrestrial default: cratered, layered terrain.
    float terrain = base * 0.65 + relief * 0.55;
    float craters = smoothstep(0.68, 0.80, ridged(p * 4.3 + seedOffset, 4));
    color = mix(uLow, uMid, smoothstep(-0.45, 0.35, terrain));
    color = mix(color, uHigh, smoothstep(0.30, 0.85, terrain));
    color = mix(color, color * 0.72, craters * 0.6);
    float caps = smoothstep(0.86, 0.97, absLat) * (1.0 - uHeat);
    color = mix(color, uAccent, caps * 0.55);
  }

  // Animated cloud deck, scaled by how much atmosphere the data supports.
  if (uCloudStrength > 0.01) {
    vec3 cloudP = sp * 3.1 + vec3(uTime * 0.045, uTime * 0.012, -uTime * 0.02) + seedOffset * 0.3;
    float clouds = fbm(cloudP, 5, 2.15, 0.55);
    clouds = smoothstep(0.18, 0.62, clouds);
    color = mix(color, uAccent * 0.9 + vec3(0.14), clouds * uCloudStrength * 0.55);
  }

  // Lighting. Single key light standing in for the host star, with a soft
  // terminator and a cool ambient fill so the night side is never pure black.
  vec3 N = normalize(vWorldNormal);
  vec3 L = normalize(uLightDir);
  vec3 V = normalize(cameraPosition - vWorldPos);

  float lambert = dot(N, L);
  float dayLight = smoothstep(-0.22, 0.42, lambert);
  vec3 ambient = mix(vec3(0.045, 0.055, 0.11), uLow * 0.25, 0.5);

  vec3 lit = color * (ambient + dayLight * 1.18);

  if (shininess > 0.0) {
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 42.0) * shininess * dayLight;
    lit += vec3(0.9, 0.96, 1.0) * spec * 0.6;
  }

  // Lava worlds keep emitting on the night side.
  if (uProfile == 5) {
    lit += color * 0.35 * (1.0 - dayLight);
  }

  // A world expected to be tidally locked keeps a permanently cold hemisphere
  // even when its surface profile is not the dedicated eyeball-world variant.
  float lockShading = mix(1.0, mix(0.62, 1.12, smoothstep(-0.45, 0.5, sp.x)), uTidalLock);
  lit *= mix(1.0, lockShading, step(0.5, uTidalLock) * (1.0 - step(6.5, float(uProfile))));

  // Rim light picks the body out against the star field.
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  lit += uAccent * rim * 0.22 * (0.35 + dayLight * 0.65);

  gl_FragColor = vec4(lit, 1.0);
}
`

/**
 * Build the uniform block for one planet.
 * @param {object} palette  output of derivePalette()
 * @param {number} seed     stable 0..1 hash of the planet id
 * @param {boolean} highDetail  false on low-power devices (fewer noise octaves)
 */
export function createSurfaceUniforms(palette, seed, highDetail = true) {
  return {
    uTime: { value: 0 },
    uSeed: { value: seed },
    uLow: { value: new THREE.Vector3(...hexToRgb(palette.low)) },
    uMid: { value: new THREE.Vector3(...hexToRgb(palette.mid)) },
    uHigh: { value: new THREE.Vector3(...hexToRgb(palette.high)) },
    uAccent: { value: new THREE.Vector3(...hexToRgb(palette.accent)) },
    uLightDir: { value: new THREE.Vector3(1, 0.35, 0.6).normalize() },
    uProfile: { value: palette.profile ?? SURFACE_PROFILE.ROCKY },
    uBandStrength: { value: palette.bandStrength ?? 0.2 },
    uCloudStrength: { value: palette.cloudStrength ?? 0.4 },
    uTidalLock: { value: palette.tidalLock ?? 0 },
    uHeat: { value: palette.heat ?? 0.35 },
    uDetail: { value: highDetail ? 1 : 0 },
  }
}

/** Push a changed palette into an existing uniform block without reallocating. */
export function updateSurfaceUniforms(uniforms, palette, seed, highDetail = true) {
  uniforms.uSeed.value = seed
  uniforms.uLow.value.set(...hexToRgb(palette.low))
  uniforms.uMid.value.set(...hexToRgb(palette.mid))
  uniforms.uHigh.value.set(...hexToRgb(palette.high))
  uniforms.uAccent.value.set(...hexToRgb(palette.accent))
  uniforms.uProfile.value = palette.profile ?? SURFACE_PROFILE.ROCKY
  uniforms.uBandStrength.value = palette.bandStrength ?? 0.2
  uniforms.uCloudStrength.value = palette.cloudStrength ?? 0.4
  uniforms.uTidalLock.value = palette.tidalLock ?? 0
  uniforms.uHeat.value = palette.heat ?? 0.35
  uniforms.uDetail.value = highDetail ? 1 : 0
}

export default { vertexShader, fragmentShader, createSurfaceUniforms, updateSurfaceUniforms }
