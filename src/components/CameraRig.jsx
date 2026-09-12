import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Easing, Group, Tween } from '@tweenjs/tween.js'
import * as THREE from 'three'

/**
 * ASTROVITA — camera system.
 *
 * Camera states:
 *   intro        far, high, slowly sinking; the title screen
 *   sky          the observer's own position: camera at the origin, looking
 *                out at the horizon dome. SkyView owns the gaze in this state
 *                and OrbitControls is disabled and NOT updated.
 *   macro        wide-field view of the whole catalog of host stars
 *   system       settled viewing distance for one star system
 *   observation  cinematic approach and close orbit around the selected planet
 *   detail       stable presentation offset so HUD text can be read
 *
 * This component owns THE ONLY TWEEN.update() CALL IN THE APPLICATION. It is
 * mounted in every view mode, which is precisely why the tween group lives
 * here: a tween driven from a component that unmounts mid-transition (such as
 * OrbitEngine during a return to MACRO) would stop being stepped, never fire
 * onComplete, and strand the UI with isTransitioning stuck at true.
 *
 * Every state change is interpolated with @tweenjs/tween.js. There is no code
 * path that sets camera.position directly to a destination: even reduced-motion
 * transitions are short tweens rather than cuts, so orientation is never lost.
 *
 * While a tween runs, OrbitControls is disabled so user input and the tween
 * never fight; it is re-enabled on completion with limits appropriate to the
 * new state.
 */

// The macro sphere has a radius of 500 units (see MacroView), so the wide view
// has to sit well outside it; the system view is the spec's [0, 30, 80].
const STATE_MACRO = { position: new THREE.Vector3(0, 240, 620), target: new THREE.Vector3(0, 0, 0) }
// The observer stands at the origin looking north along the horizon.
const STATE_SKY = { position: new THREE.Vector3(0, 0, 0), target: new THREE.Vector3(0, 0.18, -1) }
const STATE_SYSTEM = { position: new THREE.Vector3(0, 30, 80), target: new THREE.Vector3(0, 0, 0) }
const STATE_INTRO = { position: new THREE.Vector3(0, 300, 900), target: new THREE.Vector3(0, 6, 0) }

const UP = new THREE.Vector3(0, 1, 0)
const scratchDir = new THREE.Vector3()
const scratchSide = new THREE.Vector3()
const scratchTarget = new THREE.Vector3()
const scratchPosition = new THREE.Vector3()

function observationPose(planetPosition, distance, lift, swing) {
  // Approach from the outside of the field so the planet stays framed against
  // deep space rather than against the busy inner orbits.
  scratchDir.copy(planetPosition)
  if (scratchDir.lengthSq() < 1e-6) scratchDir.set(0, 0, 1)
  scratchDir.normalize()

  scratchSide.crossVectors(UP, scratchDir).normalize()

  scratchPosition
    .copy(planetPosition)
    .addScaledVector(scratchDir, distance)
    .addScaledVector(scratchSide, swing)
    .addScaledVector(UP, lift)

  scratchTarget.copy(planetPosition)
  return { position: scratchPosition.clone(), target: scratchTarget.clone() }
}

/**
 * @param {object} props
 * @param {'intro'|'universe'|'observation'|'detail'} props.mode
 * @param {string|null} props.targetId
 * @param {React.MutableRefObject<Map>} props.positionsRef
 * @param {boolean} props.reducedMotion
 * @param {number} props.resetToken    increment to replay the current state
 * @param {(mode: string) => void} [props.onArrive]
 */
export default function CameraRig({
  mode,
  targetId,
  positionsRef,
  reducedMotion = false,
  resetToken = 0,
  onArrive,
}) {
  const { camera } = useThree()
  const controlsRef = useRef(null)
  const tweenGroup = useMemo(() => new Group(), [])
  const flying = useRef(false)
  const idleTime = useRef(0)
  const userActive = useRef(false)
  // A target selected from the catalog may not have a published position yet
  // (its orbit body mounts on the same commit). We wait for it instead of
  // flying to the wrong place.
  const awaitingTarget = useRef(false)
  const previousMode = useRef(mode)
  const [retry, setRetry] = useState(0)

  // One mutable object drives every tween; no allocations on the frame loop.
  const state = useRef({
    px: STATE_INTRO.position.x,
    py: STATE_INTRO.position.y,
    pz: STATE_INTRO.position.z,
    tx: STATE_INTRO.target.x,
    ty: STATE_INTRO.target.y,
    tz: STATE_INTRO.target.z,
  })

  useEffect(() => {
    camera.position.copy(STATE_INTRO.position)
    camera.lookAt(STATE_INTRO.target)
    // Cleanup: stop every tween so nothing writes into a detached camera.
    return () => tweenGroup.removeAll()
  }, [camera, tweenGroup])

  useEffect(() => {
    const controls = controlsRef.current
    const current = state.current

    // Start from where the camera actually is (a user may have orbited).
    current.px = camera.position.x
    current.py = camera.position.y
    current.pz = camera.position.z
    if (previousMode.current === 'sky' || !controls) {
      // SkyView drove the gaze directly; OrbitControls' target is stale.
      camera.getWorldDirection(scratchDir)
      current.tx = camera.position.x + scratchDir.x
      current.ty = camera.position.y + scratchDir.y
      current.tz = camera.position.z + scratchDir.z
    } else {
      current.tx = controls.target.x
      current.ty = controls.target.y
      current.tz = controls.target.z
    }
    previousMode.current = mode

    let destination
    let duration
    let waypoint = null

    if (mode === 'intro') {
      destination = STATE_INTRO
      duration = 1400
    } else if (mode === 'sky') {
      destination = STATE_SKY
      duration = 2600
    } else if (mode === 'macro') {
      destination = STATE_MACRO
      // The return home covers a long distance; give it room to breathe.
      duration = 2600
    } else if (mode === 'system') {
      destination = STATE_SYSTEM
      duration = 2000
    } else {
      const planetPosition = targetId ? positionsRef.current.get(targetId) : null
      if (!planetPosition) {
        if (targetId) {
          // Hold position; the frame loop re-arms this effect once the orbit
          // engine has published the body's world position.
          awaitingTarget.current = true
          return undefined
        }
        destination = STATE_SYSTEM
        duration = 1600
      } else if (mode === 'detail') {
        destination = observationPose(planetPosition, 4.6, 0.9, 2.2)
        duration = 1500
      } else {
        // Two-stage cinematic: swing wide toward the system, then settle in.
        waypoint = observationPose(planetPosition, 14, 5.5, -4)
        destination = observationPose(planetPosition, 5.4, 1.3, 0)
        duration = 2600
      }
    }

    if (reducedMotion) duration = Math.min(duration, 520)

    awaitingTarget.current = false
    tweenGroup.removeAll()
    flying.current = true
    if (controls) controls.enabled = false

    const finish = () => {
      flying.current = false
      idleTime.current = 0
      if (controls) {
        // In the sky state SkyView owns the camera; controls stay off.
        controls.enabled = mode !== 'sky'
        controls.target.set(current.tx, current.ty, current.tz)
        controls.update()
      }
      if (onArrive) onArrive(mode)
    }

    const applyPose = () => {
      camera.position.set(current.px, current.py, current.pz)
      camera.lookAt(current.tx, current.ty, current.tz)
      if (controls) controls.target.set(current.tx, current.ty, current.tz)
    }

    const easing = reducedMotion ? Easing.Quadratic.Out : Easing.Cubic.InOut

    const settle = new Tween(current, tweenGroup)
      .to(
        {
          px: destination.position.x,
          py: destination.position.y,
          pz: destination.position.z,
          tx: destination.target.x,
          ty: destination.target.y,
          tz: destination.target.z,
        },
        waypoint && !reducedMotion ? duration * 0.55 : duration,
      )
      .easing(waypoint && !reducedMotion ? Easing.Quadratic.Out : easing)
      .onUpdate(applyPose)
      .onComplete(finish)

    if (waypoint && !reducedMotion) {
      const approach = new Tween(current, tweenGroup)
        .to(
          {
            px: waypoint.position.x,
            py: waypoint.position.y,
            pz: waypoint.position.z,
            tx: waypoint.target.x,
            ty: waypoint.target.y,
            tz: waypoint.target.z,
          },
          duration * 0.45,
        )
        .easing(Easing.Quadratic.In)
        .onUpdate(applyPose)
        .chain(settle)
      tweenGroup.add(approach)
      approach.start(performance.now())
    } else {
      tweenGroup.add(settle)
      settle.start(performance.now())
    }
    // positionsRef is a stable ref; targetId/mode/resetToken are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetId, resetToken, reducedMotion, camera, tweenGroup, retry])

  useFrame((frameState, delta) => {
    tweenGroup.update(performance.now())

    if (awaitingTarget.current && targetId && positionsRef.current.has(targetId)) {
      awaitingTarget.current = false
      setRetry((n) => n + 1)
    }

    const controls = controlsRef.current
    if (!controls || flying.current) return

    // SkyView applies yaw/pitch directly; an OrbitControls.update() here would
    // overwrite it with a lookAt every frame. Hands off.
    if (mode === 'sky') return

    // Gentle autonomous drift in the wide view when the user is idle, so the
    // observatory never looks frozen. Suppressed under reduced motion.
    if ((mode === 'macro' || mode === 'system') && !reducedMotion && !userActive.current) {
      idleTime.current += delta
      if (idleTime.current > 4) {
        const angle = delta * 0.02
        const x = camera.position.x
        const z = camera.position.z
        camera.position.x = x * Math.cos(angle) - z * Math.sin(angle)
        camera.position.z = x * Math.sin(angle) + z * Math.cos(angle)
        camera.lookAt(controls.target)
      }
    }
    controls.update()
  })

  const isObserving = mode === 'observation' || mode === 'detail'
  const isMacro = mode === 'macro' || mode === 'intro'

  // Zoom limits are per tier: the macro sphere is 500 units across, a system is
  // ~50, and an observed planet is a couple of units wide. One shared range
  // would make at least two of the three unusable.
  const minDistance = isObserving ? 2.6 : isMacro ? 60 : 14
  const maxDistance = isObserving ? 16 : isMacro ? 1400 : 180

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      enablePan={false}
      rotateSpeed={0.55}
      zoomSpeed={0.7}
      enabled={mode !== 'sky'}
      minDistance={minDistance}
      maxDistance={maxDistance}
      minPolarAngle={0.15}
      maxPolarAngle={Math.PI - 0.15}
      onStart={() => {
        userActive.current = true
        idleTime.current = 0
      }}
      onEnd={() => {
        userActive.current = false
        idleTime.current = 0
      }}
    />
  )
}
