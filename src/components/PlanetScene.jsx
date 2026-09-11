import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  createSurfaceUniforms,
  updateSurfaceUniforms,
  vertexShader as surfaceVertex,
  fragmentShader as surfaceFragment,
} from '../shaders/PlanetSurfaceShader.js'
import {
  createAtmosphereUniforms,
  updateAtmosphereUniforms,
  vertexShader as atmosphereVertex,
  fragmentShader as atmosphereFragment,
} from '../shaders/AtmosphericShader.js'

/**
 * ASTROVITA — high-detail observation target.
 *
 * Renders the currently selected planet with the procedural surface and
 * atmosphere shaders. One instance exists at a time; when the selection
 * changes the uniforms are updated in place so no shader is recompiled and
 * no GPU resource churns.
 *
 * Geometry is unit-radius and the whole group is scaled, so changing the
 * visual radius never rebuilds a buffer. All Three resources are created
 * declaratively and disposed by react-three-fiber on unmount.
 */

const LIGHT_DIRECTION = new THREE.Vector3(1, 0.35, 0.6).normalize()
const SCRATCH = new THREE.Vector3()

export default function PlanetScene({
  planet,
  getPosition,
  targetScale = 1.6,
  autoRotate = true,
  reducedMotion = false,
  highDetail = true,
  showLock = true,
}) {
  const groupRef = useRef(null)
  const bodyRef = useRef(null)
  const pulseRef = useRef(null)
  const reticleOuterRef = useRef(null)
  const reticleInnerRef = useRef(null)
  const pulsePhase = useRef(0)

  const surfaceUniforms = useMemo(
    () => createSurfaceUniforms(planet.palette, planet.seed, highDetail),
    // Created once; updated imperatively when the planet changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const atmosphereUniforms = useMemo(
    () =>
      createAtmosphereUniforms(planet.palette.glow, planet.palette.atmosphereDensity, 1.0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    updateSurfaceUniforms(surfaceUniforms, planet.palette, planet.seed, highDetail)
    updateAtmosphereUniforms(
      atmosphereUniforms,
      planet.palette.glow,
      planet.palette.atmosphereDensity,
      1.0,
    )
    surfaceUniforms.uLightDir.value.copy(LIGHT_DIRECTION)
    atmosphereUniforms.uLightDir.value.copy(LIGHT_DIRECTION)
    // Reset rotation so a newly acquired target presents its seeded face.
    if (bodyRef.current) bodyRef.current.rotation.set(0.12, planet.seed * Math.PI * 2, 0)
  }, [planet, highDetail, surfaceUniforms, atmosphereUniforms])

  const glowColor = useMemo(() => new THREE.Color(planet.palette.glow), [planet.palette.glow])
  const segments = highDetail ? 96 : 56

  useFrame((state, delta) => {
    const group = groupRef.current
    if (!group) return

    const step = Math.min(delta, 0.1)
    const t = state.clock.elapsedTime

    // Follow the orbit-engine position of this planet.
    const position = getPosition ? getPosition(SCRATCH) : null
    if (position) group.position.copy(position)

    // Smoothly grow/shrink between navigation and observation scales.
    const current = group.scale.x
    const next = THREE.MathUtils.damp(current, targetScale, reducedMotion ? 9 : 4.2, step)
    group.scale.setScalar(next)

    surfaceUniforms.uTime.value = reducedMotion ? 0 : t
    atmosphereUniforms.uTime.value = reducedMotion ? 0 : t

    if (bodyRef.current && autoRotate && !reducedMotion) {
      bodyRef.current.rotation.y += step * 0.07
    }

    // Camera-facing lock reticle.
    if (pulseRef.current) {
      pulseRef.current.quaternion.copy(state.camera.quaternion)
      if (!reducedMotion) {
        pulsePhase.current = (pulsePhase.current + step * 0.42) % 1
        const p = pulsePhase.current
        pulseRef.current.scale.setScalar(1.28 + p * 0.55)
        pulseRef.current.material.opacity = (1 - p) * 0.55
      } else {
        pulseRef.current.scale.setScalar(1.45)
        pulseRef.current.material.opacity = 0.32
      }
    }
    if (reticleOuterRef.current) {
      reticleOuterRef.current.quaternion.copy(state.camera.quaternion)
      if (!reducedMotion) reticleOuterRef.current.rotateZ(step * 0.35)
    }
    if (reticleInnerRef.current) {
      reticleInnerRef.current.quaternion.copy(state.camera.quaternion)
      if (!reducedMotion) reticleInnerRef.current.rotateZ(-step * 0.55)
    }
  })

  return (
    <group ref={groupRef} scale={0.9}>
      <mesh ref={bodyRef}>
        <sphereGeometry args={[1, segments, segments]} />
        <shaderMaterial
          uniforms={surfaceUniforms}
          vertexShader={surfaceVertex}
          fragmentShader={surfaceFragment}
        />
      </mesh>

      <mesh scale={1.075}>
        <sphereGeometry args={[1, 48, 48]} />
        <shaderMaterial
          uniforms={atmosphereUniforms}
          vertexShader={atmosphereVertex}
          fragmentShader={atmosphereFragment}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
        />
      </mesh>

      {showLock && (
        <>
          <mesh ref={pulseRef}>
            <ringGeometry args={[0.985, 1.0, 96]} />
            <meshBasicMaterial
              color={glowColor}
              transparent
              opacity={0.4}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh ref={reticleOuterRef} scale={1.62}>
            <ringGeometry args={[0.99, 1.0, 4, 1, 0, Math.PI * 0.42]} />
            <meshBasicMaterial
              color={glowColor}
              transparent
              opacity={0.75}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh ref={reticleInnerRef} scale={1.5}>
            <ringGeometry args={[0.992, 1.0, 64, 1, Math.PI, Math.PI * 0.75]} />
            <meshBasicMaterial
              color="#ffffff"
              transparent
              opacity={0.35}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
        </>
      )}
    </group>
  )
}
