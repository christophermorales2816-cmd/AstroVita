import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import {
  STAR_FRAGMENT_SHADER,
  STAR_VERTEX_SHADER,
  createStarUniforms,
} from '../shaders/starShaders.js'
import {
  equatorialToHorizontal,
  gazeToBearing,
  horizontalToScene,
  julianDate,
  localSiderealTime,
} from '../services/skyPosition.js'

/**
 * FILE: src/components/SkyView.jsx
 *
 * PURPOSE
 *   The main portal. Every catalogued exoplanet host star, drawn where it
 *   actually is in the sky RIGHT NOW from the observer's chosen location, on a
 *   dome the viewer stands in the middle of and looks around 360 degrees.
 *   Hovering a star shows its name, planet count and distance; clicking it
 *   enters that system.
 *
 * DEPENDENCIES
 *   ../services/skyPosition.js  verified equatorial -> horizontal reduction
 *   ../shaders/starShaders.js   shared glow shader
 *
 * PERFORMANCE-CRITICAL DECISIONS
 *   - ONE Points object for ~4,500 host stars: one draw call.
 *   - The sky is recomputed every SKY_REFRESH_SECONDS (2 s), not every frame.
 *     Sidereal motion is 0.25 degrees per minute; a 2-second cadence moves a
 *     star by 0.008 degrees, far below one pixel. The recompute is ~4,500
 *     trig evaluations written straight into the position/colour attributes —
 *     no geometry rebuild, no React state.
 *   - Look-around is a first-person yaw/pitch held in refs and applied to the
 *     camera in useFrame. OrbitControls is unsuitable for this (it orbits a
 *     target; we need to rotate in place) and is disabled by CameraRig while
 *     this view is active.
 *   - The current bearing is written into `bearingRef` every frame. The DOM
 *     readout samples that ref on a slow interval; no 60 Hz React state.
 *   - Hover/selection size boosts are direct BufferAttribute writes with O(1)
 *     restore, identical to MacroView.
 *
 * SCIENTIFIC HONESTY
 *   Directions are real: measured RA/Dec reduced to the local horizon. Every
 *   star is drawn at the same dome radius because the eye cannot perceive
 *   stellar distance either — distance is shown as a number in the tooltip,
 *   never encoded as depth. Systems from the offline snapshot carry no
 *   catalogued RA/Dec; they receive a stable pseudo-position and the tooltip
 *   says so.
 */

/** Dome radius in scene units. Matches CameraRig's macro tier. */
const DOME_RADIUS = 500

/** How often the sky is re-reduced for the current time. */
const SKY_REFRESH_SECONDS = 2

const SIZE_MIN = 1.5
const SIZE_MAX = 6.0
const HOVER_BOOST = 5.0
const SELECT_BOOST = 3.5

/** Points raycast threshold; the three.js default of 1 is unusable at R=500. */
const POINTS_RAYCAST_THRESHOLD = 5

/** Pointer travel (px) below which a press counts as a click, not a drag. */
const CLICK_SLOP_PX = 6

/** Look sensitivity, radians per CSS pixel. */
const LOOK_SENSITIVITY = 0.0032

/** Pitch limits so the viewer cannot flip over the zenith. */
const PITCH_MIN = -0.35
const PITCH_MAX = Math.PI / 2 - 0.02

const RAD = 180 / Math.PI
const DEG = Math.PI / 180

function sizeFor(starRadiusSolar) {
  if (starRadiusSolar === null || !Number.isFinite(starRadiusSolar)) return SIZE_MIN
  const scaled = SIZE_MIN + Math.sqrt(Math.max(starRadiusSolar, 0)) * 1.9
  return THREE.MathUtils.clamp(scaled, SIZE_MIN, SIZE_MAX)
}

/**
 * Systems without catalogued coordinates (the bundled snapshot) are given a
 * pseudo RA/Dec recovered from their stable pseudo-direction, so they still
 * rise and set with the sky instead of hanging motionless.
 */
function raDecFor(system) {
  if (system.hasSkyPosition && system.ra !== null && system.dec !== null) {
    return [system.ra, system.dec]
  }
  const d = system.direction
  const dec = Math.asin(THREE.MathUtils.clamp(d.z, -1, 1)) * RAD
  const ra = ((Math.atan2(d.y, d.x) * RAD) + 360) % 360
  return [ra, dec]
}

/** Alpha for a star at a given altitude: gone below the horizon, dim near it. */
function horizonFade(altitudeDeg) {
  if (altitudeDeg <= 0) return 0
  if (altitudeDeg >= 12) return 1
  return altitudeDeg / 12
}

/* ------------------------------------------------------------------ */
/* horizon dressing                                                    */
/* ------------------------------------------------------------------ */

const CARDINALS = [
  { label: 'N', azimuth: 0 },
  { label: 'E', azimuth: 90 },
  { label: 'S', azimuth: 180 },
  { label: 'W', azimuth: 270 },
]

function Horizon() {
  const cardinalPositions = useMemo(
    () =>
      CARDINALS.map((c) => {
        const v = horizontalToScene(1.6, c.azimuth, new THREE.Vector3())
        return { ...c, position: v.multiplyScalar(DOME_RADIUS * 0.985) }
      }),
    [],
  )

  return (
    <group>
      {/* Ground: opaque so nothing below the horizon leaks through. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]}>
        <circleGeometry args={[DOME_RADIUS * 1.2, 96]} />
        <meshBasicMaterial color="#04050c" />
      </mesh>

      {/* Horizon glow band. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.4, 0]}>
        <ringGeometry args={[DOME_RADIUS * 0.9, DOME_RADIUS * 1.02, 128]} />
        <meshBasicMaterial
          color="#3a1e2a"
          transparent
          opacity={0.55}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Crisp horizon line. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]}>
        <ringGeometry args={[DOME_RADIUS * 0.996, DOME_RADIUS * 1.004, 192]} />
        <meshBasicMaterial color="#5ff0ff" transparent opacity={0.28} depthWrite={false} />
      </mesh>

      {cardinalPositions.map((c) => (
        <group key={c.label} position={c.position}>
          <Html center distanceFactor={420} zIndexRange={[18, 0]} style={{ pointerEvents: 'none' }}>
            <div className="pointer-events-none select-none font-display text-[13px] font-bold tracking-[0.3em] text-signal-cyan/70">
              {c.label}
            </div>
          </Html>
        </group>
      ))}
    </group>
  )
}

/* ------------------------------------------------------------------ */
/* sky view                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {object} props
 * @param {Map<string, object>} props.starSystems
 * @param {{latitude: number, longitude: number}} props.location
 * @param {(system: object) => void} props.onSelectSystem
 * @param {(system: object|null) => void} props.onHoverSystem
 * @param {string|null} props.selectedHostname
 * @param {React.MutableRefObject<{azimuth:number, altitude:number}>} props.bearingRef
 * @param {boolean} props.active   true when this view owns the camera
 * @param {boolean} props.reducedMotion
 */
export default function SkyView({
  starSystems,
  location,
  onSelectSystem,
  onHoverSystem,
  selectedHostname = null,
  bearingRef,
  active = true,
  reducedMotion = false,
}) {
  const pointsRef = useRef(null)
  const { camera, gl, raycaster } = useThree()

  const hoveredIndex = useRef(-1)
  const hoverPulse = useRef(0)
  const boostedHover = useRef(-1)
  const boostedSelect = useRef(-1)

  // First-person gaze. Yaw 0 / pitch 0 looks due north along the horizon.
  const yaw = useRef(0)
  const pitch = useRef(0.18)
  const drag = useRef({ active: false, id: -1, x: 0, y: 0, startX: 0, startY: 0, moved: 0 })
  const refreshClock = useRef(SKY_REFRESH_SECONDS) // force an immediate first pass
  const scratch = useMemo(() => ({ x: 0, y: 0, z: 0 }), [])

  /* ---------------- static per-star data ---------------- */

  const cloud = useMemo(() => {
    const systems = Array.from(starSystems.values())
    const count = systems.length

    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const baseColors = new Float32Array(count * 3)
    const sizes = new Float32Array(count)
    const baseSizes = new Float32Array(count)
    const phases = new Float32Array(count)
    const raDec = new Float32Array(count * 2)
    const altAz = new Float32Array(count * 2)

    systems.forEach((system, i) => {
      const [ra, dec] = raDecFor(system)
      raDec[i * 2] = ra
      raDec[i * 2 + 1] = dec

      const c = system.color
      baseColors[i * 3] = c.r
      baseColors[i * 3 + 1] = c.g
      baseColors[i * 3 + 2] = c.b

      const size = sizeFor(system.starRadius)
      sizes[i] = size
      baseSizes[i] = size
      phases[i] = (i * 0.6180339887) % 1
    })

    return { systems, positions, colors, baseColors, sizes, baseSizes, phases, raDec, altAz, count }
  }, [starSystems])

  const uniforms = useMemo(
    () =>
      createStarUniforms({
        pixelRatio: Math.min(gl.getPixelRatio(), 2),
        twinkle: reducedMotion ? 0 : 0.8,
        softness: 2.0,
        opacity: 1,
        // Everything sits at R=500; the shader's distance attenuation needs
        // compensating or the whole sky is sub-pixel.
        sizeScale: 3.4,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /* ---------------- real-time reduction ---------------- */

  const recompute = useCallback(
    (now) => {
      const points = pointsRef.current
      if (!points) return
      const lst = localSiderealTime(julianDate(now), location.longitude)
      const lat = location.latitude
      const { positions, colors, baseColors, raDec, altAz, count } = cloud

      for (let i = 0; i < count; i += 1) {
        const { altitude, azimuth } = equatorialToHorizontal(
          raDec[i * 2],
          raDec[i * 2 + 1],
          lat,
          lst,
        )
        altAz[i * 2] = altitude
        altAz[i * 2 + 1] = azimuth

        horizontalToScene(altitude, azimuth, scratch)
        positions[i * 3] = scratch.x * DOME_RADIUS
        positions[i * 3 + 1] = scratch.y * DOME_RADIUS
        positions[i * 3 + 2] = scratch.z * DOME_RADIUS

        const fade = horizonFade(altitude)
        colors[i * 3] = baseColors[i * 3] * fade
        colors[i * 3 + 1] = baseColors[i * 3 + 1] * fade
        colors[i * 3 + 2] = baseColors[i * 3 + 2] * fade
      }

      const geom = points.geometry
      geom.getAttribute('position').needsUpdate = true
      geom.getAttribute('aColor').needsUpdate = true
      geom.computeBoundingSphere()
    },
    [cloud, location.latitude, location.longitude, scratch],
  )

  // A location change must not wait for the 2-second cadence.
  useEffect(() => {
    refreshClock.current = SKY_REFRESH_SECONDS
  }, [location.latitude, location.longitude])

  /* ---------------- raycaster ---------------- */

  useEffect(() => {
    const previous = raycaster.params.Points?.threshold
    if (!raycaster.params.Points) raycaster.params.Points = { threshold: POINTS_RAYCAST_THRESHOLD }
    else raycaster.params.Points.threshold = POINTS_RAYCAST_THRESHOLD
    return () => {
      if (raycaster.params.Points && previous !== undefined) {
        raycaster.params.Points.threshold = previous
      }
    }
  }, [raycaster])

  /* ---------------- look-around + click ---------------- */

  useEffect(() => {
    if (!active) return undefined
    const el = gl.domElement
    const d = drag.current

    const onDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return
      d.active = true
      d.id = e.pointerId
      d.x = e.clientX
      d.y = e.clientY
      d.startX = e.clientX
      d.startY = e.clientY
      d.moved = 0
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* capture unsupported */
      }
    }

    const onMove = (e) => {
      if (!d.active || e.pointerId !== d.id) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      d.x = e.clientX
      d.y = e.clientY
      d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.startX, e.clientY - d.startY))
      if (reducedMotion && d.moved < CLICK_SLOP_PX) return
      // Dragging right turns the view right, like grabbing the sky.
      yaw.current -= dx * LOOK_SENSITIVITY
      pitch.current = THREE.MathUtils.clamp(pitch.current + dy * LOOK_SENSITIVITY, PITCH_MIN, PITCH_MAX)
    }

    const onUp = (e) => {
      if (!d.active || e.pointerId !== d.id) return
      d.active = false
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      // A press that barely moved is a click on whatever is under the cursor.
      if (d.moved < CLICK_SLOP_PX && hoveredIndex.current >= 0) {
        const system = cloud.systems[hoveredIndex.current]
        if (system) onSelectSystem?.(system)
      }
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      d.active = false
    }
  }, [active, gl, cloud.systems, onSelectSystem, reducedMotion])

  // Keyboard look for accessibility: arrows pan the view.
  useEffect(() => {
    if (!active) return undefined
    const onKey = (e) => {
      const target = e.target
      if (target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return
      const step = 4 * DEG
      switch (e.key) {
        case 'a':
        case 'A':
          yaw.current += step
          break
        case 'd':
        case 'D':
          yaw.current -= step
          break
        case 'w':
        case 'W':
          pitch.current = Math.min(PITCH_MAX, pitch.current + step)
          break
        case 's':
        case 'S':
          pitch.current = Math.max(PITCH_MIN, pitch.current - step)
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  /* ---------------- hover ---------------- */

  const handlePointerMove = useCallback(
    (event) => {
      const index = event.index
      if (index === undefined || index === hoveredIndex.current) return
      // Stars below the horizon are invisible; never let them be hovered.
      if (cloud.altAz[index * 2] <= 0) return
      event.stopPropagation()
      hoveredIndex.current = index
      hoverPulse.current = 0
      gl.domElement.style.cursor = 'pointer'
      onHoverSystem?.(cloud.systems[index] ?? null)
    },
    [cloud, gl, onHoverSystem],
  )

  const handlePointerOut = useCallback(() => {
    if (hoveredIndex.current === -1) return
    hoveredIndex.current = -1
    gl.domElement.style.cursor = ''
    onHoverSystem?.(null)
  }, [gl, onHoverSystem])

  useEffect(
    () => () => {
      gl.domElement.style.cursor = ''
    },
    [gl],
  )

  const selectedIndex = useMemo(() => {
    if (!selectedHostname) return -1
    return cloud.systems.findIndex((s) => s.hostname === selectedHostname)
  }, [cloud.systems, selectedHostname])

  /* ---------------- frame loop ---------------- */

  useFrame((state, delta) => {
    const points = pointsRef.current
    if (!points) return
    const step = Math.min(delta, 0.1)

    uniforms.uTime.value = state.clock.elapsedTime

    // --- real-time sky ---
    refreshClock.current += step
    if (refreshClock.current >= SKY_REFRESH_SECONDS) {
      refreshClock.current = 0
      recompute(Date.now())
    }

    // --- camera ---
    if (active) {
      camera.position.set(0, 0, 0)
      camera.rotation.set(pitch.current, yaw.current, 0, 'YXZ')
      if (bearingRef) {
        const b = gazeToBearing(yaw.current, pitch.current)
        bearingRef.current.azimuth = b.azimuth
        bearingRef.current.altitude = b.altitude
      }
    }

    // --- hover / selection boosts, O(1) ---
    const sizeAttr = points.geometry.getAttribute('aSize')
    if (!sizeAttr) return
    const array = sizeAttr.array
    const base = cloud.baseSizes
    const hovered = hoveredIndex.current
    hoverPulse.current += step

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
  const labelIndex = hoveredIndex.current >= 0 ? hoveredIndex.current : selectedIndex
  const labelSystem = hoveredSystem ?? (selectedIndex >= 0 ? cloud.systems[selectedIndex] : null)
  const labelPosition =
    labelIndex >= 0
      ? [
          cloud.positions[labelIndex * 3],
          cloud.positions[labelIndex * 3 + 1],
          cloud.positions[labelIndex * 3 + 2],
        ]
      : null

  return (
    <group>
      <Horizon />

      <points
        ref={pointsRef}
        frustumCulled={false}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
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

      {labelSystem && labelPosition && (
        <group position={labelPosition}>
          <Html distanceFactor={300} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
            <div className="pointer-events-none ml-5 -mt-2 min-w-[200px] select-none rounded-lg border border-white/15 bg-void-900/90 px-4 py-3 backdrop-blur-md shadow-hud">
              <div className="font-display text-[15px] font-bold tracking-wide text-white">
                {labelSystem.hostname}
              </div>
              <div className="mt-1 font-mono text-[12px] text-slate-300">
                {labelSystem.planets.length} {labelSystem.planets.length === 1 ? 'planet' : 'planets'}
                {' · '}
                {labelSystem.distanceLy === null ? 'distance unknown' : `${labelSystem.distanceLy.toFixed(1)} ly`}
              </div>
              {!labelSystem.hasSkyPosition && (
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-signal-amber/80">
                  synthetic bearing · no catalogued RA/Dec
                </div>
              )}
              <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-slate-500">
                click to explore
              </div>
            </div>
          </Html>
        </group>
      )}
    </group>
  )
}
