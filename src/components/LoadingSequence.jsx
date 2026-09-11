import { useEffect, useRef, useState } from 'react'

/**
 * ASTROVITA — observatory boot and title screen.
 *
 * Two phases in one overlay:
 *   booting   progress readout while the catalog loads (never blocks: the
 *             data layer resolves to a snapshot if the archive is unreachable)
 *   ready     title reveal and the ENTER OBSERVATORY call to action
 *
 * The overlay is a DOM layer over the live 3D canvas, so the star field is
 * already alive behind the title.
 */

const BOOT_STEPS = [
  'INITIALIZING OBSERVATORY',
  'CONNECTING TO EXOPLANET CATALOG',
  'LOADING STELLAR DATABASE',
  'CALIBRATING OPTICS',
  'OBSERVATORY ONLINE',
]

export default function LoadingSequence({ stage, ready, dataMeta, onEnter, reducedMotion }) {
  const [displayedSteps, setDisplayedSteps] = useState([])
  const [progress, setProgress] = useState(0)
  const enterRef = useRef(null)

  // Reveal the scripted boot lines on a timer, but let a real data stage
  // (from the service layer) splice into the readout so the log is truthful.
  useEffect(() => {
    let index = 0
    let cancelled = false
    let timer = null
    const interval = reducedMotion ? 120 : 420

    const tick = () => {
      if (cancelled) return
      if (index < BOOT_STEPS.length - 1) {
        const line = BOOT_STEPS[index]
        setDisplayedSteps((prev) => (prev.includes(line) ? prev : [...prev, line]))
        setProgress(Math.min(0.9, (index + 1) / BOOT_STEPS.length))
        index += 1
        timer = setTimeout(tick, interval)
      }
    }
    timer = setTimeout(tick, interval)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [reducedMotion])

  useEffect(() => {
    if (!stage) return
    setDisplayedSteps((prev) => (prev.includes(stage) ? prev : [...prev, stage]))
  }, [stage])

  useEffect(() => {
    if (ready) {
      setDisplayedSteps((prev) =>
        prev.includes(BOOT_STEPS[BOOT_STEPS.length - 1]) ? prev : [...prev, BOOT_STEPS[BOOT_STEPS.length - 1]],
      )
      setProgress(1)
      // Move focus to the primary action for keyboard users.
      const id = setTimeout(() => enterRef.current?.focus(), 80)
      return () => clearTimeout(id)
    }
    return undefined
  }, [ready])

  const statusLine = dataMeta
    ? dataMeta.status === 'LIVE'
      ? 'NASA EXOPLANET ARCHIVE · LIVE'
      : dataMeta.status === 'CACHED'
        ? 'NASA EXOPLANET ARCHIVE · CACHED'
        : 'LOCAL CATALOG SNAPSHOT · OFFLINE'
    : 'AWAITING CATALOG'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="ASTROVITA observatory boot sequence"
      className="pointer-events-auto absolute inset-0 z-40 flex flex-col items-center justify-center bg-gradient-to-b from-void-900/70 via-void-900/40 to-void-900/85 px-6"
    >
      <div className="hud-grid pointer-events-none absolute inset-0 opacity-30" aria-hidden="true" />

      <div className="relative flex w-full max-w-xl flex-col items-center text-center">
        <p className="hud-label mb-3 animate-hud-in">Immersive Exoplanet Observatory</p>
        <h1 className="animate-hud-in font-display text-4xl font-black tracking-[0.35em] text-white text-shadow-glow sm:text-6xl">
          ASTROVITA
        </h1>
        <p className="mt-3 max-w-md animate-hud-in font-mono text-xs uppercase tracking-[0.22em] text-slate-300">
          Explore real worlds beyond our solar system.
        </p>

        <div className="mt-10 w-full max-w-md">
          <div
            className="relative h-px w-full overflow-hidden bg-signal-cyan/15"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label="Observatory initialization progress"
          >
            <div
              className="absolute inset-y-0 left-0 bg-signal-cyan shadow-glow transition-[width] duration-500 ease-out"
              style={{ width: `${progress * 100}%` }}
            />
          </div>

          <ol className="mt-4 min-h-[7.5rem] space-y-1 text-left" aria-live="polite">
            {displayedSteps.map((line, index) => {
              const isLast = index === displayedSteps.length - 1
              return (
                <li
                  key={line}
                  className={`animate-hud-in font-mono text-[11px] uppercase tracking-[0.2em] ${
                    isLast && !ready ? 'text-signal-cyan' : 'text-slate-400'
                  }`}
                >
                  <span className="mr-2 text-signal-cyan/60">{isLast && !ready ? '▸' : '✓'}</span>
                  {line}
                </li>
              )
            })}
          </ol>

          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
            DATA SOURCE: <span className="text-slate-300">{statusLine}</span>
          </p>
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            ref={enterRef}
            type="button"
            onClick={onEnter}
            disabled={!ready}
            className="hud-button clip-notch !px-8 !py-3 !text-xs !tracking-[0.35em] disabled:opacity-30"
          >
            {ready ? 'ENTER OBSERVATORY' : 'CALIBRATING…'}
          </button>
          {!ready && (
            <button
              type="button"
              onClick={onEnter}
              className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500 underline-offset-4 hover:text-slate-300 hover:underline"
            >
              Skip intro
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
