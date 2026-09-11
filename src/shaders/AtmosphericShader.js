/**
 * ASTROVITA — atmospheric halo shader.
 *
 * ARTISTIC MODEL. The glow colour is mapped from *detected* atmospheric species
 * where a detection exists (methane -> teal, water -> pale blue, sulphur
 * dioxide -> amber, and so on) and otherwise falls back to the planet's class
 * palette. Density is scaled by how strong the evidence for an atmosphere is:
 * a world where JWST ruled out a thick envelope gets a visibly thinner halo
 * than one with a confirmed detection. It is a data-driven visual cue, not an
 * image of a real atmosphere.
 *
 * Rendered on a slightly larger back-face sphere with additive blending, so it
 * reads as light scattered around the limb rather than as a solid shell.
 */

import * as THREE from 'three'
import { hexToRgb } from '../services/dataNormalizer.js'

export const vertexShader = /* glsl */ `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vObjectPos;

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

uniform vec3  uColor;
uniform vec3  uLightDir;
uniform float uTime;
uniform float uIntensity;
uniform float uPower;
uniform float uDensity;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vObjectPos;

// Cheap value noise: the halo only needs slow, low-frequency motion, so a full
// simplex implementation would be wasted instructions on a per-pixel shell.
float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash(i + vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);

  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}

void main() {
  // Back faces are rendered, so the geometric normal points inward.
  vec3 N = normalize(-vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uLightDir);

  // Fresnel: the halo is brightest where the line of sight grazes the limb.
  float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uPower);

  // Forward scattering: an atmosphere lights up strongly on the day limb.
  float dayFacing = smoothstep(-0.45, 0.65, dot(N, L));
  float scatter = pow(max(dot(V, -L), 0.0), 2.0) * 0.35;

  // Slow drifting haze so the halo is never a static ring.
  vec3 hazeCoord = vObjectPos * 3.0 + vec3(uTime * 0.05, uTime * 0.02, -uTime * 0.035);
  float haze = valueNoise(hazeCoord) * 0.5 + valueNoise(hazeCoord * 2.3) * 0.25;

  float alpha = fresnel * uDensity * uIntensity;
  alpha *= 0.30 + dayFacing * 0.85;
  alpha *= 0.78 + haze * 0.42;
  alpha += scatter * uDensity * fresnel * 0.6;

  vec3 color = uColor * (0.65 + dayFacing * 0.9);
  color += uColor * haze * 0.2;

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
`

/**
 * @param {string} colorHex   glow colour derived from atmospheric species
 * @param {number} density    0..1, scaled by strength of the atmospheric evidence
 * @param {number} intensity  overall brightness multiplier
 */
export function createAtmosphereUniforms(colorHex, density = 0.6, intensity = 1.0) {
  return {
    uColor: { value: new THREE.Vector3(...hexToRgb(colorHex)) },
    uLightDir: { value: new THREE.Vector3(1, 0.35, 0.6).normalize() },
    uTime: { value: 0 },
    uIntensity: { value: intensity },
    uPower: { value: 3.1 },
    uDensity: { value: density },
  }
}

export function updateAtmosphereUniforms(uniforms, colorHex, density = 0.6, intensity = 1.0) {
  uniforms.uColor.value.set(...hexToRgb(colorHex))
  uniforms.uDensity.value = density
  uniforms.uIntensity.value = intensity
}

/** Material factory. Additive + depthWrite:false keeps the halo from occluding. */
export function createAtmosphereMaterial(colorHex, density, intensity) {
  return new THREE.ShaderMaterial({
    uniforms: createAtmosphereUniforms(colorHex, density, intensity),
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  })
}

export default {
  vertexShader,
  fragmentShader,
  createAtmosphereUniforms,
  updateAtmosphereUniforms,
  createAtmosphereMaterial,
}
