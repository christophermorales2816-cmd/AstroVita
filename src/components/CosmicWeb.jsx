import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * ASTROVITA — procedural deep-space environment.
 *
 * Two GPU point clouds and one travelling light source, drawn in three draw
 * calls total:
 *
 *   - a star shell (BufferGeometry + ShaderMaterial, additive, no depth write)
 *   - a soft nebula layer clustered around a handful of seeded centres
 *   - an occasional distant "event" that drifts across the field
 *
 * Every attribute is generated once into typed arrays. Nothing here allocates
 * inside useFrame, and no per-star React component exists: 10,600 individual
 * meshes would be a non-starter, while two Points objects are effectively free.
 *
 * The star colours are stylised (a cool blue-to-amber spread loosely echoing
 * stellar colour temperature) and the positions are procedural. This is set
 * dressing, not a plotted sky survey, and the HUD never labels it as data.
 */

const VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;

uniform float uTime;
uniform float uPixelRatio;
uniform float uTwinkle;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

  float twinkle = 1.0 - uTwinkle * 0.35
    + uTwinkle * 0.35 * sin(uTime * (0.4 + aPhase * 1.6) + aPhase * 6.2831853);

  vColor = aColor;
  vAlpha = twinkle;

  // Perspective size attenuation; clamped so nothing becomes a full-screen quad.
  float dist = max(-mvPosition.z, 1.0);
  gl_PointSize = clamp(aSize * uPixelRatio * (280.0 / dist), 0.6, 48.0);
  gl_Position = projectionMatrix * mvPosition;
}
`

const FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform float uSoftness;
uniform float uOpacity;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) discard;

  float falloff = smoothstep(0.5, 0.0, dist);
  falloff = pow(falloff, uSoftness);

  gl_FragColor = vec4(vColor, falloff * vAlpha * uOpacity);
}
`

/** Deterministic PRNG so the sky is identical on every reload. */
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * Stylised stellar colours. Rough nod to spectral class ordering: most stars
 * are dim and reddish, a minority are hot and blue.
 */
const STAR_COLORS = [
  [0.62, 0.72, 1.0], // hot blue-white
  [0.82, 0.88, 1.0],
  [1.0, 1.0, 0.98], // sun-like
  [1.0, 0.94, 0.82],
  [1.0, 0.84, 0.66], // K dwarf
  [1.0, 0.72, 0.58], // M dwarf
]

function buildStarField(count, seed) {
  const random = makeRandom(seed)
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const phases = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    // Uniform direction on a sphere, then a depth-layered radius so the field
    // has real parallax instead of sitting on a single shell.
    const u = random() * 2 - 1
    const theta = random() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    const layer = Math.pow(random(), 0.55)
    const radius = 140 + layer * 1260

    positions[i * 3] = r * Math.cos(theta) * radius
    positions[i * 3 + 1] = u * radius * 0.72
    positions[i * 3 + 2] = r * Math.sin(theta) * radius

    const tint = STAR_COLORS[Math.floor(Math.pow(random(), 1.6) * STAR_COLORS.length) % STAR_COLORS.length]
    // Dimmer with distance, so depth reads even without fog.
    const brightness = 0.45 + (1 - layer) * 0.55 * (0.6 + random() * 0.4)
    colors[i * 3] = tint[0] * brightness
    colors[i * 3 + 1] = tint[1] * brightness
    colors[i * 3 + 2] = tint[2] * brightness

    sizes[i] = 0.7 + Math.pow(random(), 3.2) * 4.4
    phases[i] = random()
  }

  return { positions, colors, sizes, phases }
}

const NEBULA_TINTS = [
  [0.32, 0.18, 0.62], // violet
  [0.1, 0.3, 0.62], // deep blue
  [0.52, 0.13, 0.42], // magenta
  [0.09, 0.4, 0.5], // teal
]

function buildNebula(count, seed) {
  const random = makeRandom(seed)
  const clusterCount = 7
  const clusters = []
  for (let c = 0; c < clusterCount; c += 1) {
    const u = random() * 2 - 1
    const theta = random() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    const radius = 520 + random() * 720
    clusters.push({
      center: new THREE.Vector3(
        r * Math.cos(theta) * radius,
        u * radius * 0.6,
        r * Math.sin(theta) * radius,
      ),
      spread: 130 + random() * 240,
      tint: NEBULA_TINTS[Math.floor(random() * NEBULA_TINTS.length) % NEBULA_TINTS.length],
    })
  }

  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const phases = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    const cluster = clusters[i % clusterCount]
    // Gaussian-ish falloff from the cluster centre via summed uniforms.
    const jitter = () => (random() + random() + random() - 1.5) * cluster.spread

    positions[i * 3] = cluster.center.x + jitter()
    positions[i * 3 + 1] = cluster.center.y + jitter() * 0.6
    positions[i * 3 + 2] = cluster.center.z + jitter()

    const brightness = 0.05 + Math.pow(random(), 2.4) * 0.16
    colors[i * 3] = cluster.tint[0] * brightness
    colors[i * 3 + 1] = cluster.tint[1] * brightness
    colors[i * 3 + 2] = cluster.tint[2] * brightness

    sizes[i] = 28 + random() * 96
    phases[i] = random()
  }

  return { positions, colors, sizes, phases }
}

function PointCloud({ data, softness, opacity, twinkle, pixelRatio }) {
  const materialRef = useRef(null)

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uTwinkle: { value: twinkle },
      uSoftness: { value: softness },
      uOpacity: { value: opacity },
    }),
    // Uniform *values* are updated imperatively below; this object is created
    // once per cloud so the material is never rebuilt mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useFrame((state) => {
    if (!materialRef.current) return
    uniforms.uTime.value = state.clock.elapsedTime
    uniforms.uPixelRatio.value = pixelRatio
    uniforms.uTwinkle.value = twinkle
    uniforms.uOpacity.value = opacity
  })

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
        <bufferAttribute attach="attributes-aColor" args={[data.colors, 3]} />
        <bufferAttribute attach="attributes-aSize" args={[data.sizes, 1]} />
        <bufferAttribute attach="attributes-aPhase" args={[data.phases, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={VERTEX_SHADER}
        fragmentShader={FRAGMENT_SHADER}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

/**
 * A slow-moving distant object. Fires roughly every 16 seconds, crosses the
 * field, fades out. One mesh, negligible cost, and it makes the sky feel alive
 * rather than painted on.
 */
function DistantEvent({ enabled }) {
  const meshRef = useRef(null)
  const state = useRef({ t: 10, from: new THREE.Vector3(), to: new THREE.Vector3(), active: false })

  useFrame((_, delta) => {
    const mesh = meshRef.current
    if (!mesh) return

    if (!enabled) {
      mesh.visible = false
      return
    }

    const s = state.current
    s.t += delta

    if (!s.active && s.t > 16) {
      const angle = Math.random() * Math.PI * 2
      const height = (Math.random() - 0.5) * 320
      s.from.set(Math.cos(angle) * 900, height, Math.sin(angle) * 900)
      s.to.set(Math.cos(angle + 1.4) * 620, height + (Math.random() - 0.5) * 200, Math.sin(angle + 1.4) * 620)
      s.active = true
      s.t = 0
    }

    if (s.active) {
      const progress = s.t / 5.5
      if (progress >= 1) {
        s.active = false
        s.t = 0
        mesh.visible = false
        return
      }
      mesh.visible = true
      mesh.position.lerpVectors(s.from, s.to, progress)
      const fade = Math.sin(progress * Math.PI)
      mesh.scale.setScalar(3 + fade * 9)
      mesh.material.opacity = fade * 0.55
    } else {
      mesh.visible = false
    }
  })

  return (
    <mesh ref={meshRef} visible={false} frustumCulled={false}>
      <sphereGeometry args={[1, 12, 12]} />
      <meshBasicMaterial
        color="#bfe9ff"
        transparent
        opacity={0}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  )
}

/**
 * @param {object} props
 * @param {number} props.starCount       number of stars in the main shell
 * @param {number} props.nebulaCount     number of soft nebula sprites
 * @param {boolean} props.reducedMotion  suppresses parallax, twinkle and events
 * @param {number} props.dim             0..1, how much to fade the sky while a
 *                                       planet is under observation
 */
export default function CosmicWeb({
  starCount = 9000,
  nebulaCount = 1600,
  reducedMotion = false,
  dim = 0,
}) {
  const groupRef = useRef(null)
  const gl = useThree((state) => state.gl)

  const stars = useMemo(() => buildStarField(starCount, 0x5eed), [starCount])
  const nebula = useMemo(() => buildNebula(nebulaCount, 0x9a17), [nebulaCount])

  const pixelRatio = Math.min(gl.getPixelRatio(), 2)

  useFrame((state, delta) => {
    const group = groupRef.current
    if (!group) return

    const step = Math.min(delta, 0.1)

    if (reducedMotion) {
      // Keep a fixed, static sky. Information is unchanged; only motion stops.
      group.rotation.set(0, group.rotation.y, 0)
      return
    }

    // Autonomous drift plus damped mouse parallax. Pointer is -1..1.
    group.rotation.y += step * 0.0075
    const targetX = -state.pointer.y * 0.05
    const targetZ = state.pointer.x * 0.035
    group.rotation.x = THREE.MathUtils.damp(group.rotation.x, targetX, 1.6, step)
    group.rotation.z = THREE.MathUtils.damp(group.rotation.z, targetZ, 1.6, step)
  })

  const starOpacity = 1 - dim * 0.68
  const nebulaOpacity = 1 - dim * 0.5

  // Keys force a clean geometry rebuild if the quality preset ever changes
  // the particle count, instead of resizing attributes in place.
  return (
    <group ref={groupRef}>
      <PointCloud
        key={`stars-${starCount}`}
        data={stars}
        softness={2.4}
        opacity={starOpacity}
        twinkle={reducedMotion ? 0 : 1}
        pixelRatio={pixelRatio}
      />
      <PointCloud
        key={`nebula-${nebulaCount}`}
        data={nebula}
        softness={1.15}
        opacity={nebulaOpacity}
        twinkle={0}
        pixelRatio={pixelRatio}
      />
      <DistantEvent enabled={!reducedMotion && dim < 0.5} />
    </group>
  )
}
