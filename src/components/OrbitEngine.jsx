import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html, Line, useCursor } from '@react-three/drei'
import * as THREE from 'three'

/**
 * ASTROVITA — orbit engine.
 *
 * Lays the visible catalog out as a navigable field of orbits around the
 * observatory origin and drives the subtle orbital motion, hover feedback and
 * selection indicator without touching React state on the frame loop.
 *
 * VISUALIZED ORBIT SCALE. The layout is a data-driven arrangement, not a map:
 *   - orbital radius  <- log of the system's distance from Earth
 *   - body size       <- log of the measured planetary radius
 *   - angular speed   <- inverse log of the measured orbital period
 *   - tilt / phase    <- deterministic hash of the planet id
 * Real exoplanets orbit their own stars, not a common centre. The HUD carries
 * a permanent VISUALIZED ORBIT SCALE label for exactly this reason.
 */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const ORBIT_MIN = 7
const ORBIT_MAX = 50
const RING_SEGMENTS = 96

function hashToUnit(seed, salt) {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function orbitRadiusFor(distanceLy) {
  // Unknown distance goes to the outer edge rather than being invented.
  const d = distanceLy === null ? 3000 : Math.max(distanceLy, 1)
  const t = THREE.MathUtils.clamp(Math.log10(d + 1) / Math.log10(3001), 0, 1)
  return ORBIT_MIN + t * (ORBIT_MAX - ORBIT_MIN)
}

function bodySizeFor(radiusEarth) {
  if (radiusEarth === null) return 0.34
  return 0.22 + Math.log10(1 + radiusEarth) * 0.55
}

function angularSpeedFor(periodDays) {
  const p = periodDays === null ? 100 : Math.max(periodDays, 0.2)
  return 0.012 + 0.05 / (1 + Math.log10(1 + p))
}

/** Pre-computed circle for one orbit ring. */
function ringPoints(radius) {
  const pts = []
  for (let i = 0; i <= RING_SEGMENTS; i += 1) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2
    pts.push([Math.cos(a) * radius, 0, Math.sin(a) * radius])
  }
  return pts
}

function buildLayout(planets) {
  return planets.map((planet, index) => {
    const seed = planet.seed
    return {
      planet,
      radius: orbitRadiusFor(planet.distanceLy),
      size: bodySizeFor(planet.radiusEarth),
      speed: angularSpeedFor(planet.orbitalPeriodDays),
      phase: index * GOLDEN_ANGLE + hashToUnit(seed, 1) * 0.6,
      tiltX: (hashToUnit(seed, 2) - 0.5) * 0.42,
      tiltZ: (hashToUnit(seed, 3) - 0.5) * 0.42,
      color: new THREE.Color(planet.palette.glow),
      ring: ringPoints(orbitRadiusFor(planet.distanceLy)),
    }
  })
}

function OrbitBody({
  entry,
  isSelected,
  isHovered,
  dimmed,
  onHover,
  onSelect,
  registerBody,
}) {
  const meshRef = useRef(null)
  const glowRef = useRef(null)
  useCursor(isHovered)

  useEffect(() => {
    registerBody(entry.planet.id, meshRef.current)
    return () => registerBody(entry.planet.id, null)
  }, [entry.planet.id, registerBody])

  const { planet, size, color } = entry
  const showLabel = isHovered && !isSelected

  return (
    <group>
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
          emissiveIntensity={isHovered ? 1.6 : 0.55}
          roughness={0.55}
          metalness={0.1}
          transparent
          opacity={dimmed ? 0.22 : 1}
        />
        {/* Halo sprite-like shell for a readable glow at distance. */}
        <mesh ref={glowRef} scale={isHovered ? 2.2 : 1.55}>
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
    </group>
  )
}

/**
 * @param {object}   props
 * @param {Array}    props.planets        normalized planets to display (already capped)
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
  planets,
  selectedId,
  hoveredId,
  onHover,
  onSelect,
  paused = false,
  reducedMotion = false,
  dimOthers = false,
  positionsRef,
}) {
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
  // targets a body that is no longer in the field.
  useEffect(() => {
    const live = new Set(layout.map((e) => e.planet.id))
    for (const id of Array.from(positionsRef.current.keys())) {
      if (!live.has(id)) positionsRef.current.delete(id)
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

  return (
    <group>
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
              opacity={isSelected ? 0.55 : dimmed ? 0.035 : isHovered ? 0.28 : 0.09}
              lineWidth={isSelected ? 1.4 : 0.8}
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
