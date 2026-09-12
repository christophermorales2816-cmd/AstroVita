import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html, Line, useCursor } from '@react-three/drei'
import * as THREE from 'three'
import { teffToColor } from '../services/dataNormalizer.js'

/**
 * FILE: src/components/OrbitEngine.jsx
 *
 * PURPOSE
 *   The SYSTEM navigation tier. Renders ONE star system: its host star at the
 *   origin, and that star's planets on their own orbits around it.
 *
 * WHAT CHANGED FROM THE PREVIOUS VERSION
 *   It used to lay the whole catalog out as concentric rings around an abstract
 *   "observatory origin", with orbit radius derived from each planet's DISTANCE
 *   FROM EARTH — a layout device with no physical meaning. Now that the macro
 *   tier owns catalog-wide navigation, this component is scoped to a single
 *   system and can use the real orbital elements instead:
 *
 *     orbital radius  <- measured semi-major axis (log-compressed)
 *     angular speed   <- measured orbital period (Kepler ordering preserved)
 *     orbit tilt      <- measured inclination, where published
 *     body size       <- measured planetary radius (log-compressed)
 *
 *   Relative ORDERING and relative PERIOD RATIOS are therefore faithful within a
 *   system. Absolute scale is not: a star drawn 2 units across with a planet 8
 *   units away is not to scale, and the HUD carries a permanent VISUALIZED
 *   ORBIT SCALE label for that reason.
 *
 * DEPENDENCIES
 *   @react-three/drei  Line (orbit rings), Html (labels), useCursor
 *   dataNormalizer     teffToColor for the host star
 *
 * PERFORMANCE-CRITICAL DECISIONS
 *   - A system holds a handful of planets, not hundreds, so per-planet meshes
 *     are correct here; instancing would cost more in complexity than it saves.
 *   - No React state is touched in useFrame. Orbital angles live in a ref-held
 *     Map; world positions are published into the shared positionsRef.
 *   - Ring geometry is precomputed per orbit in useMemo, never rebuilt per frame.
 *
 * DELIBERATE DEVIATION FROM SPEC
 *   The spec places the camera entry tween and the single TWEEN.update() call in
 *   this component. That deadlocks: OrbitEngine unmounts when the user returns
 *   to MACRO, so the zoom-out tween would stop being updated mid-flight, never
 *   fire onComplete, and leave isTransitioning stuck at true — a permanently
 *   dead "Regresar a Casa" button. All tweening therefore stays in CameraRig,
 *   which is mounted in every view mode and already owns the tween group.
 */

const RING_SEGMENTS = 96
const ORBIT_MIN = 6
const ORBIT_MAX = 46

/** Visual radius bounds for the host star, in scene units. */
const STAR_MIN = 0.9
const STAR_MAX = 3.4

function hashToUnit(seed, salt) {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** Measured planetary radius -> visual body size. */
function bodySizeFor(radiusEarth) {
  if (radiusEarth === null) return 0.34
  return 0.24 + Math.log10(1 + radiusEarth) * 0.62
}

/** Measured orbital period -> angular speed. Shorter period spins faster. */
function angularSpeedFor(periodDays) {
  const p = periodDays === null ? 365 : Math.max(periodDays, 0.2)
  return 0.03 + 0.55 / (1 + Math.pow(p, 0.62))
}

/** Host star visual radius from its measured radius in solar radii. */
function starSizeFor(starRadiusSolar) {
  if (starRadiusSolar === null || !Number.isFinite(starRadiusSolar)) return 1.2
  return THREE.MathUtils.clamp(STAR_MIN + Math.sqrt(Math.max(starRadiusSolar, 0)) * 1.1, STAR_MIN, STAR_MAX)
}

/** Pre-computed circle for one orbit ring, in the orbit's own plane. */
function ringPoints(radius) {
  const pts = []
  for (let i = 0; i <= RING_SEGMENTS; i += 1) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2
    pts.push([Math.cos(a) * radius, 0, Math.sin(a) * radius])
  }
  return pts
}

/**
 * Lay out one system.
 *
 * Semi-major axes inside a single system can span three orders of magnitude
 * (TRAPPIST-1 b at 0.011 AU vs HR 8799 b at 68 AU), so the mapping is log
 * compressed against that system's own min/max. Ordering is exact; ratios are
 * not preserved, which the HUD label covers.
 */
function buildLayout(planets) {
  const axes = planets.map((p) => p.semiMajorAxisAu).filter((a) => a !== null && a > 0)
  const minA = axes.length ? Math.min(...axes) : 0.05
  const maxA = axes.length ? Math.max(...axes) : 1
  const span = Math.log10(maxA / minA) || 1

  return planets.map((planet, index) => {
    const a = planet.semiMajorAxisAu
    let radius
    if (a !== null && a > 0) {
      const t = axes.length > 1 ? THREE.MathUtils.clamp(Math.log10(a / minA) / span, 0, 1) : 0.5
      radius = ORBIT_MIN + t * (ORBIT_MAX - ORBIT_MIN)
    } else {
      // No measured semi-major axis: park it outside the measured orbits rather
      // than inventing a distance. Spread by index so they do not overlap.
      radius = ORBIT_MAX + 4 + index * 2.4
    }

    // Measured inclination where available. 90 degrees is edge-on, which is why
    // nearly every transiting multi-planet system renders close to coplanar —
    // that flatness is the real geometry, not a rendering shortcut.
    const incl = planet.orbitalInclinationDeg
    const tiltX =
      incl !== null && Number.isFinite(incl)
        ? THREE.MathUtils.degToRad(incl - 90) * 1.6
        : (hashToUnit(planet.seed, 2) - 0.5) * 0.22

    return {
      planet,
      radius,
      size: bodySizeFor(planet.radiusEarth),
      speed: angularSpeedFor(planet.orbitalPeriodDays),
      phase: hashToUnit(planet.seed, 1) * Math.PI * 2,
      tiltX,
      tiltZ: (hashToUnit(planet.seed, 3) - 0.5) * 0.12,
      color: new THREE.Color(planet.palette.glow),
      ring: ringPoints(radius),
      hasMeasuredOrbit: a !== null && a > 0,
    }
  })
}

/* ------------------------------------------------------------------ */
/* host star                                                           */
/* ------------------------------------------------------------------ */

function HostStar({ starSystem, reducedMotion }) {
  const coronaRef = useRef(null)

  const { color, size, lightIntensity } = useMemo(() => {
    const c = teffToColor(starSystem.starTeff)
    const s = starSizeFor(starSystem.starRadius)
    // Hotter stars light the system more strongly. Bounded so an A-type host
    // does not blow out the planet shaders.
    const teff = starSystem.starTeff ?? 5000
    const intensity = THREE.MathUtils.clamp(1.4 + (teff - 3000) / 4000, 1.0, 3.2)
    return { color: c, size: s, lightIntensity: intensity }
  }, [starSystem])

  useFrame((state) => {
    if (!coronaRef.current || reducedMotion) return
    // Slow breathing corona. Scale only — no allocation, no state.
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 0.6) * 0.04
    coronaRef.current.scale.setScalar(pulse)
  })

  return (
    <group>
      <pointLight position={[0, 0, 0]} intensity={lightIntensity} distance={260} decay={1.6} color={color} />

      {/* Photosphere. */}
      <mesh scale={size}>
        <sphereGeometry args={[1, 40, 40]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>

      {/* Inner glow. */}
      <mesh ref={coronaRef} scale={size * 1.45}>
        <sphereGeometry args={[1, 24, 24]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.3}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Outer corona. */}
      <mesh scale={size * 2.6}>
        <sphereGeometry args={[1, 20, 20]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.09}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  )
}

/* ------------------------------------------------------------------ */
/* planet body                                                         */
/* ------------------------------------------------------------------ */

function OrbitBody({ entry, isSelected, isHovered, dimmed, onHover, onSelect, registerBody }) {
  const meshRef = useRef(null)
  useCursor(isHovered)

  useEffect(() => {
    registerBody(entry.planet.id, meshRef.current)
    return () => registerBody(entry.planet.id, null)
  }, [entry.planet.id, registerBody])

  const { planet, size, color } = entry
  const showLabel = isHovered && !isSelected

  return (
    <mesh
      ref={meshRef}
      visible={!isSelected}
      onPointerOver={(event) => {
        event.stopPropagation()
        onHover(planet.id)
      }}
      onPointerOut={(event) => {
        event.stopPropagation()
        onHover(null)
      }}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(planet.id)
      }}
      scale={size}
    >
      <sphereGeometry args={[1, 24, 24]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={isHovered ? 1.5 : 0.45}
        roughness={0.55}
        metalness={0.1}
        transparent
        opacity={dimmed ? 0.22 : 1}
      />
      <mesh scale={isHovered ? 2.2 : 1.55}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={dimmed ? 0.05 : isHovered ? 0.26 : 0.12}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {showLabel && (
        <Html center distanceFactor={18} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="pointer-events-none whitespace-nowrap border border-signal-cyan/40 bg-void-900/85 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-signal-cyan backdrop-blur-sm">
            {planet.name}
            <span className="ml-2 text-slate-400">{planet.classification}</span>
          </div>
        </Html>
      )}
    </mesh>
  )
}

/* ------------------------------------------------------------------ */
/* system view                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {object} props
 * @param {object} props.starSystem   REQUIRED. The system to render.
 * @param {string|null} props.selectedId
 * @param {string|null} props.hoveredId
 * @param {Function} props.onHover
 * @param {Function} props.onSelect
 * @param {boolean}  props.paused         freeze orbital motion (observation lock)
 * @param {boolean}  props.reducedMotion
 * @param {boolean}  props.dimOthers      fade non-selected bodies
 * @param {React.MutableRefObject<Map>} props.positionsRef  id -> world Vector3
 */
export default function OrbitEngine({
  starSystem,
  selectedId,
  hoveredId,
  onHover,
  onSelect,
  paused = false,
  reducedMotion = false,
  dimOthers = false,
  positionsRef,
}) {
  const planets = starSystem?.planets ?? []
  const layout = useMemo(() => buildLayout(planets), [planets])
  const bodies = useRef(new Map())
  const angles = useRef(new Map())
  const groupRefs = useRef(new Map())

  const registerBody = useMemo(
    () => (id, mesh) => {
      if (mesh) bodies.current.set(id, mesh)
      else bodies.current.delete(id)
    },
    [],
  )

  // Drop stale positions when the visible set changes so the camera never
  // targets a body that has left the scene.
  useEffect(() => {
    const live = new Set(layout.map((e) => e.planet.id))
    const map = positionsRef.current
    for (const id of Array.from(map.keys())) {
      // Hostnames also live in this Map (published by MacroView); only planet
      // ids are managed here.
      if (id.startsWith('host:')) continue
      if (!live.has(id)) map.delete(id)
    }
  }, [layout, positionsRef])

  useFrame((_, delta) => {
    const step = Math.min(delta, 0.1)
    const advance = paused || reducedMotion ? 0 : step

    for (let i = 0; i < layout.length; i += 1) {
      const entry = layout[i]
      const id = entry.planet.id
      const mesh = bodies.current.get(id)
      const tiltGroup = groupRefs.current.get(id)
      if (!mesh || !tiltGroup) continue

      const angle = (angles.current.get(id) ?? entry.phase) + advance * entry.speed
      angles.current.set(id, angle)

      mesh.position.set(Math.cos(angle) * entry.radius, 0, Math.sin(angle) * entry.radius)

      // Publish the world-space position for the camera rig and PlanetScene.
      tiltGroup.updateMatrixWorld()
      const world = positionsRef.current.get(id) ?? new THREE.Vector3()
      world.copy(mesh.position)
      tiltGroup.localToWorld(world)
      positionsRef.current.set(id, world)

      // Hover growth, damped rather than snapped.
      const targetScale = entry.size * (id === hoveredId ? 1.35 : 1)
      const s = THREE.MathUtils.damp(mesh.scale.x, targetScale, 10, step)
      mesh.scale.setScalar(s)
    }
  })

  if (!starSystem) return null

  return (
    <group>
      <HostStar starSystem={starSystem} reducedMotion={reducedMotion} />

      {layout.map((entry) => {
        const id = entry.planet.id
        const isSelected = id === selectedId
        const isHovered = id === hoveredId
        const dimmed = dimOthers && !isSelected

        return (
          <group
            key={id}
            rotation={[entry.tiltX, 0, entry.tiltZ]}
            ref={(node) => {
              if (node) groupRefs.current.set(id, node)
              else groupRefs.current.delete(id)
            }}
          >
            <Line
              points={entry.ring}
              color={isSelected ? entry.color : '#5ff0ff'}
              transparent
              opacity={isSelected ? 0.55 : dimmed ? 0.05 : isHovered ? 0.32 : 0.14}
              lineWidth={isSelected ? 1.4 : 0.8}
              // A dashed ring marks an orbit whose semi-major axis is not
              // measured, so a placed body is never mistaken for a plotted one.
              dashed={!entry.hasMeasuredOrbit}
              dashSize={1.4}
              gapSize={1.4}
              depthWrite={false}
            />
            <OrbitBody
              entry={entry}
              isSelected={isSelected}
              isHovered={isHovered}
              dimmed={dimmed}
              onHover={onHover}
              onSelect={onSelect}
              registerBody={registerBody}
            />
          </group>
        )
      })}
    </group>
  )
}
