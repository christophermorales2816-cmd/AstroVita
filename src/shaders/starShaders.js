/**
 * FILE: src/shaders/starShaders.js
 *
 * PURPOSE
 *   Single shared source of truth for the soft-glow point shader used by both
 *   the deep-space background (CosmicWeb, 18,000 stars) and the macro catalog
 *   view (MacroView, one point per host star). Previously CosmicWeb carried its
 *   own inline copy; duplicating GLSL means two shader programs get compiled
 *   and two copies drift apart over time.
 *
 * DEPENDENCIES
 *   None. Plain strings, consumed by THREE.ShaderMaterial.
 *
 * PERFORMANCE-CRITICAL DECISIONS
 *   - Module-level constants, never built inside a component. A new shader
 *     string identity forces THREE to recompile the program on every render.
 *   - `precision mediump float` in the fragment stage. These are soft glows;
 *     highp buys nothing visually and costs real throughput on integrated GPUs
 *     and mobile tiled renderers.
 *   - Early `discard` outside the point radius so the blend unit is never asked
 *     to composite fully transparent corner fragments. With 18,000 additive
 *     points this is the difference between comfortable and fill-rate bound.
 *   - gl_PointSize is clamped. An unclamped point near the near plane becomes a
 *     screen-filling quad and collapses the frame rate instantly.
 *
 * ATTRIBUTE CONTRACT — geometry must supply all three:
 *   aColor  vec3   linear RGB, pre-multiplied by per-star brightness
 *   aSize   float  base point size in world-ish units, scaled by uSizeScale
 *   aPhase  float  0..1 twinkle phase offset; also used for hover pulses
 *
 * UNIFORM CONTRACT:
 *   uTime       float  seconds
 *   uPixelRatio float  renderer pixel ratio, so points match across DPI
 *   uTwinkle    float  0 disables twinkle entirely (reduced-motion)
 *   uSoftness   float  glow falloff exponent; higher = tighter core
 *   uOpacity    float  global fade, used to dim the sky during observation
 *   uSizeScale  float  multiplier applied to aSize (macro vs background)
 */

export const STAR_VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;

uniform float uTime;
uniform float uPixelRatio;
uniform float uTwinkle;
uniform float uSizeScale;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

  // Twinkle is a cheap per-vertex sine. uTwinkle == 0.0 collapses this to a
  // constant 1.0 so reduced-motion users get a perfectly still sky.
  float twinkle = 1.0 - uTwinkle * 0.35
    + uTwinkle * 0.35 * sin(uTime * (0.4 + aPhase * 1.6) + aPhase * 6.2831853);

  vColor = aColor;
  vAlpha = twinkle;

  // Perspective size attenuation. The clamp is load-bearing: without an upper
  // bound a point that drifts close to the camera becomes a fullscreen quad.
  float dist = max(-mvPosition.z, 1.0);
  gl_PointSize = clamp(aSize * uSizeScale * uPixelRatio * (280.0 / dist), 0.6, 64.0);
  gl_Position = projectionMatrix * mvPosition;
}
`

export const STAR_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform float uSoftness;
uniform float uOpacity;

varying vec3 vColor;
varying float vAlpha;

void main() {
  // gl_PointCoord is 0..1 across the point sprite; centre it to get a radius.
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);

  // Reject the square corners before any blending work happens.
  if (dist > 0.5) discard;

  float falloff = smoothstep(0.5, 0.0, dist);
  falloff = pow(falloff, uSoftness);

  gl_FragColor = vec4(vColor, falloff * vAlpha * uOpacity);
}
`

/**
 * Build the uniform block for a star point cloud.
 *
 * The returned object is meant to be created ONCE per cloud (inside useMemo)
 * and then mutated in place from useFrame. Handing a freshly built uniforms
 * object to <shaderMaterial> on a re-render rebuilds the material.
 */
export function createStarUniforms({
  pixelRatio = 1,
  twinkle = 1,
  softness = 2.4,
  opacity = 1,
  sizeScale = 1,
} = {}) {
  return {
    uTime: { value: 0 },
    uPixelRatio: { value: pixelRatio },
    uTwinkle: { value: twinkle },
    uSoftness: { value: softness },
    uOpacity: { value: opacity },
    uSizeScale: { value: sizeScale },
  }
}

export default { STAR_VERTEX_SHADER, STAR_FRAGMENT_SHADER, createStarUniforms }
