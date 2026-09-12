import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import {
  STAR_FRAGMENT_SHADER,
  STAR_VERTEX_SHADER,
  createStarUniforms,
} from '../shaders/starShaders.js'

/**
 * FILE: src/components/MacroView.jsx
 *
 * PURPOSE
 *   The MACRO navigation tier. Renders every catalogued host star as one vertex
 *   of a single THREE.Points cloud, positioned from its real (RA, Dec, distance)
 *   and coloured from its real effective temperature. Clicking a star selects
 *   that system and hands control to OrbitEngine.
 *
 * DEPENDENCIES
 *   ../shaders/starShaders.js  shared glow shader (also used by CosmicWeb)
 *   dataNormalizer             StarSystem.direction / .color are precomputed there
 *
 * PERFORMANCE-CRITICAL DECISIONS
 *   - ONE Points object for the entire catalog. ~4,000 host stars as individual
 *     meshes would be ~4,000 draw calls; as one buffer geometry it is one.
 *   - Hover feedback is written straight into the size BufferAttribute inside
 *     useFrame (`array[i] = ...; needsUpdate = true`). No React state is read or
 *     written on the frame loop. The hovered index lives in a ref.
 *   - The parent is notified of a hover ONLY when the index actually changes,
 *     from the pointer event handler rather than from useFrame, so the label
 *     re-render happens a few times per second rather than 60.
 *   - Typed arrays are built once in useMemo, keyed on the systems Map.
 *
 * TWO DELIBERATE DEVIATIONS FROM SPEC, both load-bearing:
 *
 *   1. The spec's normalization, "divide by maxDist * 500", divides by the
 *      PRODUCT and collapses every star to within 1/500 of a unit of the
 *      origin — a black screen. The correct operation is multiplication by
 *      (500 / maxDist), which is what runs below.
 *
 *   2. Even corrected, a LINEAR radial scale is unusable here. The catalog
 *      spans Proxima Centauri at 1.3 pc to systems beyond 2,500 pc; linearly
 *      normalized, every naked-eye neighbour lands inside the innermost 0.3%
 *      of the sphere and cannot be picked. The radius is therefore
 *      log-compressed, which preserves distance ORDERING exactly while keeping
 *      the near field navigable. Direction is untouched and remains the real
 *      sky position. The HUD labels this as a visualized scale.
 */

/** Outer radius of the macro sphere, in scene units. */
const MACRO_RADIUS = 500

/** Point size bounds required by spec, in the shader's base-size units. */
const SIZE_MIN = 1.5
const SIZE_MAX = 6.0

/** Extra size added to the hovered star, and to the selected one. */
const HOVER_BOOST = 5.0
const SELECT_BOOST = 3.5

/**
 * Raycasting against a Points cloud uses a fixed world-space threshold, and the
 * three.js default is 1 unit. Across a 500-unit sphere that makes individual
 * stars essentially unclickable. This is scaled to the cloud, not the viewport.
 */
const POINTS_RAYCAST_THRESHOLD = 6

/**
 * Log-compressed radial mapping. Monotonic in distance, so ordering is exact.
 * A system with no distance measurement is parked at the outer shell rather
 * than being assigned an invented one.
 */
function radialFor(distPc, maxDistPc) {
  if (distPc === null || !Number.isFinite(distPc)) return MACRO_RADIUS
  const d = Math.max(distPc, 0.1)
  const t = Math.log10(1 + d) / Math.log10(1 + maxDistPc)
  // Floor at 4% so the nearest handful of systems are still separable.
  return MACRO_RADIUS * (0.04 + 0.96 * THREE.MathUtils.clamp(t, 0, 1))
}

/** Star radius -> point size, clamped to the spec's bounds. */
function sizeFor(starRadiusSolar) {
  if (starRadiusSolar === null || !Number.isFinite(starRadiusSolar)) return SIZE_MIN
  // sqrt keeps supergiants from swamping the field while staying monotonic.
  const scaled = SIZE_MIN + Math.sqrt(Math.max(starRadiusSolar, 0)) * 1.9
  return THREE.MathUtils.clamp(scaled, SIZE_MIN, SIZE_MAX)
}

/**
 * @param {object} props
 * @param {Map<string, object>} props.starSystems
 * @param {(system: object) => void} props.onSelectSystem
 * @param {(system: object|null) => void} props.onHoverSystem
 * @param {string|null} props.selectedHostname
 * @param {React.MutableRefObject<Map>} props.positionsRef  hostname -> world Vector3
 * @param {boolean} props.reducedMotion
 */
export default function MacroView({
  starSystems,
  onSelectSystem,
  onHoverSystem,
  selectedHostname = null,
  positionsRef,
  reducedMotion = false,
}) {
  const pointsRef = useRef(null)
  const hoveredIndex = useRef(-1)
  const hoverPulse = useRef(0)
  // Indices whose size attribute this component last wrote a boost into.
  const boostedHover = useRef(-1)
  const boostedSelect = useRef(-1)
  const { raycaster, gl } = useThree()

  /* ---------------- geometry ---------------- */

  const cloud = useMemo(() => {
    const systems = Array.from(starSystems.values())
    const count = systems.length

    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const sizes = new Float32Array(count)
    const baseSizes = new Float32Array(count)
    const phases = new Float32Array(count)

    let maxDistPc = 1
    for (const s of systems) {
      if (s.dist !== null && Number.isFinite(s.dist) && s.dist > maxDistPc) maxDistPc = s.dist
    }

    systems.forEach((system, i) => {
      const radius = radialFor(system.dist, maxDistPc)
      const dir = system.direction

      const x = dir.x * radius
      const y = dir.y * radius
      const z = dir.z * radius

      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z

      // Cache the world position on the system object, per spec, and publish it
      // through the shared Map ref so the camera rig can tween straight to it.
      system.worldPosition = new THREE.Vector3(x, y, z)

      const c = system.color
      // Distant stars are dimmed so the cloud reads as a volume, not a shell.
      const fade = 0.45 + 0.55 * (1 - radius / MACRO_RADIUS)
      colors[i * 3] = c.r * fade
      colors[i * 3 + 1] = c.g * fade
      colors[i * 3 + 2] = c.b * fade

      const size = sizeFor(system.starRadius)
      sizes[i] = size
      baseSizes[i] = size
      phases[i] = (i * 0.6180339887) % 1
    })

    return { systems, positions, colors, sizes, baseSizes, phases, count, maxDistPc }
  }, [starSystems])

  const uniforms = useMemo(
    () =>
      createStarUniforms({
        pixelRatio: Math.min(gl.getPixelRatio(), 2),
        twinkle: reducedMotion ? 0 : 0.7,
        softness: 2.0,
        opacity: 1,
        sizeScale: 1,
      }),
    // Built once. Values are mutated in useFrame; a new object would rebuild
    // the material and force a shader recompile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /* ---------------- shared position map ---------------- */

  useEffect(() => {
    const map = positionsRef.current
    // Namespaced so a hostname can never collide with a planet id: OrbitEngine
    // publishes into the same Map and prunes anything it does not own.
    for (const system of cloud.systems) {
      if (system.worldPosition) map.set(`host:${system.hostname}`, system.worldPosition)
    }
    return () => {
      for (const system of cloud.systems) map.delete(`host:${system.hostname}`)
    }
  }, [cloud, positionsRef])

  /* ---------------- raycaster tuning ---------------- */

  useEffect(() => {
    const previous = raycaster.params.Points?.threshold
    if (!raycaster.params.Points) raycaster.params.Points = { threshold: POINTS_RAYCAST_THRESHOLD }
    else raycaster.params.Points.threshold = POINTS_RAYCAST_THRESHOLD
    return () => {
      // Restore, or the tuned threshold leaks into the system view where the
      // orbit bodies are ordinary meshes at a completely different scale.
      if (raycaster.params.Points && previous !== undefined) {
        raycaster.params.Points.threshold = previous
      }
    }
  }, [raycaster])

  /* ---------------- interaction ---------------- */

  // Defined outside JSX so R3F never sees a new handler identity per render.
  const handlePointerMove = useCallback(
    (event) => {
      const index = event.index
      if (index === undefined || index === hoveredIndex.current) return
      event.stopPropagation()
      hoveredIndex.current = index
      hoverPulse.current = 0
      onHoverSystem?.(cloud.systems[index] ?? null)
    },
    [cloud.systems, onHoverSystem],
  )

  const handlePointerOut = useCallback(() => {
    if (hoveredIndex.current === -1) return
    hoveredIndex.current = -1
    onHoverSystem?.(null)
  }, [onHoverSystem])

  const handlePointerDown = useCallback(
    (event) => {
      const index = event.index
      if (index === undefined) return
      event.stopPropagation()
      const system = cloud.systems[index]
      if (system) onSelectSystem?.(system)
    },
    [cloud.systems, onSelectSystem],
  )

  /* ---------------- frame loop ---------------- */

  const selectedIndex = useMemo(() => {
    if (!selectedHostname) return -1
    return cloud.systems.findIndex((s) => s.hostname === selectedHostname)
  }, [cloud.systems, selectedHostname])

  useFrame((state, delta) => {
    const points = pointsRef.current
    if (!points) return

    uniforms.uTime.value = state.clock.elapsedTime

    // Slow autonomous drift so the catalog never looks like a static print.
    if (!reducedMotion) {
      points.rotation.y += Math.min(delta, 0.1) * 0.008
    }

    const sizeAttr = points.geometry.getAttribute('aSize')
    if (!sizeAttr) return

    const array = sizeAttr.array
    const base = cloud.baseSizes
    const hovered = hoveredIndex.current

    hoverPulse.current += Math.min(delta, 0.1)

    // Restore only the indices this component boosted on the PREVIOUS frame,
    // then re-apply. Tracking the two dirty slots keeps the per-frame cost O(1)
    // instead of sweeping the whole catalog every frame.
    let dirty = false
    const prevHover = boostedHover.current
    const prevSelect = boostedSelect.current

    if (prevHover !== -1 && prevHover !== hovered && prevHover < array.length) {
      array[prevHover] = base[prevHover]
      dirty = true
    }
    if (prevSelect !== -1 && prevSelect !== selectedIndex && prevSelect < array.length) {
      array[prevSelect] = base[prevSelect]
      dirty = true
    }

    if (selectedIndex >= 0 && selectedIndex < array.length) {
      array[selectedIndex] = base[selectedIndex] + SELECT_BOOST
      dirty = true
    }
    boostedSelect.current = selectedIndex

    if (hovered >= 0 && hovered < array.length) {
      const pulse = reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(hoverPulse.current * 6)
      array[hovered] = base[hovered] + HOVER_BOOST * pulse
      dirty = true
    }
    boostedHover.current = hovered

    if (dirty) sizeAttr.needsUpdate = true
  })

  /* ---------------- render ---------------- */

  const hoveredSystem = hoveredIndex.current >= 0 ? cloud.systems[hoveredIndex.current] : null
  const selectedSystem = selectedIndex >= 0 ? cloud.systems[selectedIndex] : null
  const labelSystem = selectedSystem ?? hoveredSystem

  return (
    <group
      // RA/Dec puts the celestial pole on +Z; three.js wants +Y up. Rotating the
      // whole group keeps the projection maths in dataNormalizer readable as
      // textbook astronomy instead of pre-swizzled axes.
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <points
        ref={pointsRef}
        frustumCulled={false}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onPointerDown={handlePointerDown}
      >
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[cloud.positions, 3]} />
          <bufferAttribute attach="attributes-aColor" args={[cloud.colors, 3]} />
          <bufferAttribute attach="attributes-aSize" args={[cloud.sizes, 1]} />
          <bufferAttribute attach="attributes-aPhase" args={[cloud.phases, 1]} />
        </bufferGeometry>
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={STAR_VERTEX_SHADER}
          fragmentShader={STAR_FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {labelSystem?.worldPosition && (
        <group position={labelSystem.worldPosition}>
          <Html center distanceFactor={260} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
            <div className="pointer-events-none -translate-y-8 whitespace-nowrap border border-signal-cyan/40 bg-void-900/90 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-signal-cyan backdrop-blur-sm">
              {labelSystem.hostname}
              <span className="ml-2 text-slate-400">
                {labelSystem.planets.length} {labelSystem.planets.length === 1 ? 'PLANET' : 'PLANETS'}
              </span>
              {!labelSystem.hasSkyPosition && (
                <span className="ml-2 text-signal-amber/80">SYNTHETIC BEARING</span>
              )}
            </div>
          </Html>
        </group>
      )}
    </group>
  )
}
