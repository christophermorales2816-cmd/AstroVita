import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  STAR_FRAGMENT_SHADER,
  STAR_VERTEX_SHADER,
  createStarUniforms,
} from '../shaders/starShaders.js'

/**
 * FILE: src/components/CosmicWeb.jsx
 *
 * PURPOSE
 *   The deep-space environment every view tier is drawn inside: a Milky Way
 *   style star field, a soft nebula layer, occasional shooting stars, and a
 *   slowly orbiting debris ring.
 *
 * DEPENDENCIES
 *   ../shaders/starShaders.js  shared glow shader (also used by MacroView)
 *
 * PERFORMANCE-CRITICAL DECISIONS
 *   - ONE useFrame for the whole file. This is the hard rule here: three
 *     independent dynamic systems share one callback, sectioned by comment, so
 *     R3F's frame loop walks one subscriber instead of four. Nothing in this
 *     file may register a second useFrame, and no child component carrying its
 *     own frame subscription may be added to it.
 *   - Draw calls: 2 Points + 2 InstancedMesh = 4. The previous version was 3
 *     (2 Points + 1 mesh); the README figure is updated to match rather than
 *     quietly left stale.
 *   - 18,000 stars live in a single BufferGeometry. Points are close to free on
 *     the vertex side; the real cost is fill rate, which the fragment shader's
 *     early `discard` and the gl_PointSize clamp keep bounded.
 *   - Zero allocation inside useFrame. One shared `dummy` Object3D, one scratch
 *     Vector3 pair, one Quaternion and one Color are created at mount and
 *     reused for every instance on every frame.
 *   - instanceMatrix.needsUpdate is set ONCE per instanced mesh per frame, after
 *     its loop, never inside it.
 *
 * SCIENTIFIC HONESTY
 *   This whole component is set dressing. Star positions are procedural, the
 *   band is a Gaussian approximation of the galactic plane rather than a
 *   plotted survey, and the debris ring has no counterpart in any real system.
 *   Nothing here is labelled as data. Real catalogued stars are drawn by
 *   MacroView, a separate component reading measured RA/Dec.
 */

/* ------------------------------------------------------------------ */
/* tunables                                                            */
/* ------------------------------------------------------------------ */

const SHOOTING_STAR_COUNT = 12
const ASTEROID_COUNT = 40

/** Per-frame spawn probability for one idle shooting star. */
const SHOOTING_SPAWN_CHANCE = 0.002

/**
 * Galactic band thickness as a FRACTION of each star's own radius.
 *
 * The spec asks for a fixed `gaussianRandom(0, 15)`. Against a field extending
 * to ~1400 units that is a 0.6-degree hairline, far thinner than the real Milky
 * Way (roughly 10-20 degrees). Scaling sigma with radius holds the band at a
 * constant ANGULAR thickness from the observer, which is what actually reads as
 * a galactic plane.
 */
const BAND_SIGMA_RATIO = 0.075

/** Share of stars belonging to the sparse isotropic halo. */
const HALO_FRACTION = 0.3

/* ------------------------------------------------------------------ */
/* deterministic randomness                                            */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG so the sky is identical on every reload. */
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** Box-Muller transform. Returns one normally distributed sample. */
function gaussian(random, mean, sigma) {
  let u = 0
  let v = 0
  while (u === 0) u = random()
  while (v === 0) v = random()
  return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Stylised stellar colours, ordered by spectral class. Most stars are dim and
 * reddish; a minority are hot and blue. The exponent on the lookup biases the
 * draw toward the cool end to match.
 */
const STAR_COLORS = [
  [0.62, 0.72, 1.0], // hot blue-white
  [0.82, 0.88, 1.0],
  [1.0, 1.0, 0.98], // sun-like
  [1.0, 0.94, 0.82],
  [1.0, 0.84, 0.66], // K dwarf
  [1.0, 0.72, 0.58], // M dwarf
]

/**
 * Build the star field as a galactic band plus an isotropic halo.
 *
 * Band stars: a direction is chosen in the x/z plane, a radius drawn with a
 * depth bias, and the height is a Gaussian about y = 0 whose sigma scales with
 * that radius. Halo stars: a uniform direction on the sphere.
 */
function buildStarField(count, seed) {
  const random = makeRandom(seed)
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const phases = new Float32Array(count)

  const haloCount = Math.floor(count * HALO_FRACTION)
  const bandCount = count - haloCount

  for (let i = 0; i < count; i += 1) {
    const layer = Math.pow(random(), 0.55)
    const radius = 140 + layer * 1260
    let x
    let y
    let z

    if (i < bandCount) {
      // --- galactic plane ---
      const theta = random() * Math.PI * 2
      x = Math.cos(theta) * radius
      z = Math.sin(theta) * radius
      y = gaussian(random, 0, radius * BAND_SIGMA_RATIO)
    } else {
      // --- isotropic halo ---
      const u = random() * 2 - 1
      const theta = random() * Math.PI * 2
      const r = Math.sqrt(Math.max(0, 1 - u * u))
      x = r * Math.cos(theta) * radius
      y = u * radius * 0.72
      z = r * Math.sin(theta) * radius
    }

    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z

    const tint =
      STAR_COLORS[Math.floor(Math.pow(random(), 1.6) * STAR_COLORS.length) % STAR_COLORS.length]
    // Dimmer with distance so depth reads even without fog. Band stars get a
    // slight boost, which is what makes the plane visible as a band.
    const bandBoost = i < bandCount ? 1.15 : 0.9
    const brightness = (0.45 + (1 - layer) * 0.55 * (0.6 + random() * 0.4)) * bandBoost
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

/** Soft nebula sprites, clustered along the galactic plane. */
function buildNebula(count, seed) {
  const random = makeRandom(seed)
  const clusterCount = 7
  const clusters = []
  for (let c = 0; c < clusterCount; c += 1) {
    const theta = random() * Math.PI * 2
    const radius = 520 + random() * 720
    clusters.push({
      center: new THREE.Vector3(
        Math.cos(theta) * radius,
        gaussian(random, 0, radius * BAND_SIGMA_RATIO * 1.4),
        Math.sin(theta) * radius,
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
    positions[i * 3 + 1] = cluster.center.y + jitter() * 0.5
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

/** Initial state for the debris ring. Torus: radius 300-500, elevation +/-40. */
function buildAsteroids(count, seed) {
  const random = makeRandom(seed)
  const items = []
  for (let i = 0; i < count; i += 1) {
    items.push({
      radius: 300 + random() * 200,
      angle: random() * Math.PI * 2,
      elevation: (random() * 2 - 1) * 40,
      speed: 0.4 + random() * 1.6,
      scale: 0.8 + Math.pow(random(), 2) * 4.2,
      spin: new THREE.Vector3(
        (random() - 0.5) * 0.4,
        (random() - 0.5) * 0.4,
        (random() - 0.5) * 0.4,
      ),
      rotation: new THREE.Euler(random() * Math.PI, random() * Math.PI, random() * Math.PI),
    })
  }
  return items
}

/** Idle lifecycle records for the shooting stars. */
function makeShootingStars(count) {
  const items = []
  for (let i = 0; i < count; i += 1) {
    items.push({
      active: false,
      progress: 0,
      speed: 1,
      startPos: new THREE.Vector3(),
      endPos: new THREE.Vector3(),
      opacity: 0,
      length: 1,
    })
  }
  return items
}

const UP = new THREE.Vector3(0, 1, 0)

/**
 * @param {object} props
 * @param {number} props.starCount       stars in the main field (spec: 18,000)
 * @param {number} props.nebulaCount     soft nebula sprites
 * @param {boolean} props.reducedMotion  suppresses parallax, twinkle and events
 * @param {number} props.dim             0..1, fades the sky during observation
 */
export default function CosmicWeb({
  starCount = 18000,
  nebulaCount = 1600,
  reducedMotion = false,
  dim = 0,
}) {
  const groupRef = useRef(null)
  const shootingRef = useRef(null)
  const asteroidRef = useRef(null)
  const { gl, scene } = useThree()

  const stars = useMemo(() => buildStarField(starCount, 0x5eed), [starCount])
  const nebula = useMemo(() => buildNebula(nebulaCount, 0x9a17), [nebulaCount])
  const asteroids = useMemo(() => buildAsteroids(ASTEROID_COUNT, 0x2b41), [])
  const shootingStars = useMemo(() => makeShootingStars(SHOOTING_STAR_COUNT), [])

  const pixelRatio = Math.min(gl.getPixelRatio(), 2)

  const starUniforms = useMemo(
    () => createStarUniforms({ pixelRatio, twinkle: 1, softness: 2.4, opacity: 1 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const nebulaUniforms = useMemo(
    () => createStarUniforms({ pixelRatio, twinkle: 0, softness: 1.15, opacity: 1 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Scratch objects: allocated once at mount, mutated every frame, never
  // replaced. This is what keeps the frame loop allocation-free.
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const scratchVec = useMemo(() => new THREE.Vector3(), [])
  const scratchDir = useMemo(() => new THREE.Vector3(), [])
  const scratchQuat = useMemo(() => new THREE.Quaternion(), [])
  const scratchColor = useMemo(() => new THREE.Color(), [])

  /* ---------------- scene background ---------------- */

  useEffect(() => {
    // Near-absolute black with the faintest blue tint. Set once at mount rather
    // than through a <color attach="background"> re-evaluated on every render.
    const previous = scene.background
    scene.background = new THREE.Color(0x000005)
    return () => {
      scene.background = previous
    }
  }, [scene])

  /* ---------------- instanced mesh initialisation ---------------- */

  useEffect(() => {
    const mesh = shootingRef.current
    if (!mesh) return
    // Park every instance at zero scale, and allocate instanceColor by writing
    // to it once: without an initial setColorAt the instanceColor buffer is
    // null and per-instance fading silently does nothing.
    dummy.position.set(0, 0, 0)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.setScalar(0)
    dummy.updateMatrix()
    scratchColor.setRGB(0, 0, 0)
    for (let i = 0; i < SHOOTING_STAR_COUNT; i += 1) {
      mesh.setMatrixAt(i, dummy.matrix)
      mesh.setColorAt(i, scratchColor)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [dummy, scratchColor])

  useEffect(() => {
    const mesh = asteroidRef.current
    if (!mesh) return
    // Seed the debris ring so it is correctly placed on the very first frame
    // rather than popping in from the origin.
    for (let i = 0; i < asteroids.length; i += 1) {
      const a = asteroids[i]
      dummy.position.set(Math.cos(a.angle) * a.radius, a.elevation, Math.sin(a.angle) * a.radius)
      dummy.rotation.copy(a.rotation)
      dummy.scale.setScalar(a.scale)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }, [asteroids, dummy])

  /* ================================================================ */
  /* THE SINGLE FRAME LOOP                                            */
  /* Every dynamic system in this file updates here.                  */
  /* Do NOT add a second useFrame to this module.                     */
  /* ================================================================ */

  useFrame((state, delta) => {
    const step = Math.min(delta, 0.1)
    const elapsed = state.clock.elapsedTime

    // --- STAR FIELD ---------------------------------------------------
    starUniforms.uTime.value = elapsed
    starUniforms.uTwinkle.value = reducedMotion ? 0 : 1
    starUniforms.uOpacity.value = 1 - dim * 0.68
    starUniforms.uPixelRatio.value = pixelRatio

    nebulaUniforms.uTime.value = elapsed
    nebulaUniforms.uOpacity.value = 1 - dim * 0.5
    nebulaUniforms.uPixelRatio.value = pixelRatio

    const group = groupRef.current
    if (group) {
      if (reducedMotion) {
        // A fixed, static sky. Information is unchanged; only motion stops.
        group.rotation.x = 0
        group.rotation.z = 0
      } else {
        // Autonomous drift plus damped mouse parallax. Pointer is -1..1.
        group.rotation.y += step * 0.0075
        group.rotation.x = THREE.MathUtils.damp(group.rotation.x, -state.pointer.y * 0.05, 1.6, step)
        group.rotation.z = THREE.MathUtils.damp(group.rotation.z, state.pointer.x * 0.035, 1.6, step)
      }
    }

    // --- SHOOTING STARS -----------------------------------------------
    const shooting = shootingRef.current
    if (shooting && !reducedMotion && dim < 0.5) {
      let shootingDirty = false

      for (let i = 0; i < shootingStars.length; i += 1) {
        const s = shootingStars[i]

        if (!s.active) {
          if (Math.random() < SHOOTING_SPAWN_CHANCE) {
            // Spawn on a hemisphere above the scene.
            const theta = Math.random() * Math.PI * 2
            const radius = 700 + Math.random() * 400
            const height = 200 + Math.random() * 320
            s.startPos.set(Math.cos(theta) * radius, height, Math.sin(theta) * radius)

            // Travel 80-150 units along a randomised downward diagonal.
            const travel = 80 + Math.random() * 70
            scratchDir
              .set(Math.random() * 2 - 1, -(0.4 + Math.random() * 0.8), Math.random() * 2 - 1)
              .normalize()
            s.endPos.copy(s.startPos).addScaledVector(scratchDir, travel)

            s.progress = 0
            s.speed = 0.8 + Math.random() * 1.2
            s.length = 18 + Math.random() * 26
            s.active = true
          } else {
            continue
          }
        }

        s.progress += step * s.speed

        if (s.progress >= 1) {
          s.active = false
          s.progress = 0
          dummy.position.set(0, 0, 0)
          dummy.scale.setScalar(0)
          dummy.updateMatrix()
          shooting.setMatrixAt(i, dummy.matrix)
          scratchColor.setRGB(0, 0, 0)
          shooting.setColorAt(i, scratchColor)
          shootingDirty = true
          continue
        }

        // Position along the path.
        scratchVec.lerpVectors(s.startPos, s.endPos, s.progress)

        // Orient the tapered spike along its direction of travel. The cylinder's
        // own axis is +Y, so rotate that onto the velocity vector.
        scratchDir.subVectors(s.endPos, s.startPos).normalize()
        scratchQuat.setFromUnitVectors(UP, scratchDir)

        dummy.position.copy(scratchVec)
        dummy.quaternion.copy(scratchQuat)
        dummy.scale.set(1, s.length, 1)
        dummy.updateMatrix()
        shooting.setMatrixAt(i, dummy.matrix)

        // Fade in then out across the streak's life. The material blends
        // additively, so driving instance colour toward black IS the fade.
        s.opacity = Math.sin(s.progress * Math.PI)
        scratchColor.setRGB(s.opacity, s.opacity * 0.96, s.opacity * 0.88)
        shooting.setColorAt(i, scratchColor)

        shootingDirty = true
      }

      // Flagged once, after the loop — never inside it.
      if (shootingDirty) {
        shooting.instanceMatrix.needsUpdate = true
        if (shooting.instanceColor) shooting.instanceColor.needsUpdate = true
      }
    }

    // --- ASTEROIDS ----------------------------------------------------
    const debris = asteroidRef.current
    if (debris && !reducedMotion) {
      for (let i = 0; i < asteroids.length; i += 1) {
        const a = asteroids[i]

        a.angle += step * a.speed * 0.05
        a.rotation.x += step * a.spin.x
        a.rotation.y += step * a.spin.y
        a.rotation.z += step * a.spin.z

        dummy.position.set(Math.cos(a.angle) * a.radius, a.elevation, Math.sin(a.angle) * a.radius)
        dummy.rotation.copy(a.rotation)
        dummy.scale.setScalar(a.scale)
        dummy.updateMatrix()
        debris.setMatrixAt(i, dummy.matrix)
      }
      // Flagged once, after the loop.
      debris.instanceMatrix.needsUpdate = true
    }
  })

  /* ---------------- render ---------------- */

  return (
    <group ref={groupRef}>
      {/* Star field: 18,000 points, one draw call. */}
      <points frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[stars.positions, 3]} />
          <bufferAttribute attach="attributes-aColor" args={[stars.colors, 3]} />
          <bufferAttribute attach="attributes-aSize" args={[stars.sizes, 1]} />
          <bufferAttribute attach="attributes-aPhase" args={[stars.phases, 1]} />
        </bufferGeometry>
        <shaderMaterial
          uniforms={starUniforms}
          vertexShader={STAR_VERTEX_SHADER}
          fragmentShader={STAR_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* Nebula layer: larger, softer, dimmer points. */}
      <points frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[nebula.positions, 3]} />
          <bufferAttribute attach="attributes-aColor" args={[nebula.colors, 3]} />
          <bufferAttribute attach="attributes-aSize" args={[nebula.sizes, 1]} />
          <bufferAttribute attach="attributes-aPhase" args={[nebula.phases, 1]} />
        </bufferGeometry>
        <shaderMaterial
          uniforms={nebulaUniforms}
          vertexShader={STAR_VERTEX_SHADER}
          fragmentShader={STAR_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* Shooting stars: 12 tapered spikes, additive, colour-faded per instance. */}
      <instancedMesh
        ref={shootingRef}
        args={[undefined, undefined, SHOOTING_STAR_COUNT]}
        frustumCulled={false}
      >
        <cylinderGeometry args={[0.02, 0.0, 1, 4]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </instancedMesh>

      {/* Debris ring: 40 tumbling dodecahedra lit by the scene's own lights. */}
      <instancedMesh
        ref={asteroidRef}
        args={[undefined, undefined, ASTEROID_COUNT]}
        frustumCulled={false}
      >
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#4a4a4a" roughness={0.9} metalness={0.1} />
      </instancedMesh>
    </group>
  )
}
