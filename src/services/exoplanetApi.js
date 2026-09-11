/**
 * ASTROVITA — astronomical data access layer.
 *
 * Single entry point for every remote or cached catalog read. React components
 * never call `fetch` themselves; they consume the normalized result of
 * `loadExoplanetCatalog()`.
 *
 * Source of truth is the NASA Exoplanet Archive TAP service, queried over its
 * public synchronous endpoint. No API key exists for this service and none is
 * required — nothing secret is ever embedded in this bundle.
 *
 * Reliability strategy, in order:
 *   1. LIVE    — a successful TAP query, cached to localStorage on success.
 *   2. CACHED  — the most recent successful TAP response, with its real age
 *                surfaced to the UI. Never presented as live.
 *   3. OFFLINE — the bundled snapshot in src/data/exoplanet_registry.json,
 *                labelled as a snapshot.
 *
 * The archive does not always send permissive CORS headers from every network,
 * so a browser call can fail even when the service is healthy. That is treated
 * as a normal, expected condition rather than an error state: the observatory
 * degrades to the cache or the snapshot and keeps every feature working.
 * `VITE_EXOPLANET_PROXY` can be pointed at a server-side pass-through later
 * without touching any component.
 */

import registry from '../data/exoplanet_registry.json'
import { annotateWithSnapshot, normalizeArchiveRow, normalizeRegistryEntry } from './dataNormalizer.js'

const TAP_ENDPOINT = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync'

/** Optional server-side pass-through. Empty in the default static deployment. */
const PROXY_BASE = (import.meta.env?.VITE_EXOPLANET_PROXY ?? '').trim()

/**
 * Number of rows requested from the archive. The full table holds thousands of
 * planets; the observatory renders a navigable subset, so pulling the nearest
 * few hundred keeps the payload small and the star field readable.
 */
export const CATALOG_LIMIT = 400

const CACHE_KEY = 'astrovita.catalog.v1'
const CACHE_SCHEMA = 1

/** Consider a cached response stale (but still usable) after six hours. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000

const REQUEST_TIMEOUT_MS = 14000

export const DATA_STATUS = {
  LIVE: 'LIVE',
  CACHED: 'CACHED',
  OFFLINE: 'OFFLINE',
}

const ADQL = [
  'select top',
  CATALOG_LIMIT,
  'pl_name,hostname,sy_snum,sy_pnum,discoverymethod,disc_year,pl_orbper,pl_orbsmax,',
  'pl_rade,pl_bmasse,pl_orbeccen,pl_eqt,st_spectype,st_teff,st_rad,st_mass,sy_vmag,sy_dist',
  'from pscomppars',
  'where sy_dist is not null and pl_rade is not null',
  'order by sy_dist asc',
].join(' ')

function buildQueryUrl() {
  const params = new URLSearchParams({ query: ADQL, format: 'json' })
  if (PROXY_BASE) {
    const separator = PROXY_BASE.includes('?') ? '&' : '?'
    return `${PROXY_BASE}${separator}${params.toString()}`
  }
  return `${TAP_ENDPOINT}?${params.toString()}`
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * fetch with a hard timeout, wired so an external AbortSignal (React unmount)
 * also cancels the in-flight request.
 */
async function fetchWithTimeout(url, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)

  const forwardAbort = () => controller.abort(signal?.reason ?? new Error('aborted'))
  if (signal) {
    if (signal.aborted) forwardAbort()
    else signal.addEventListener('abort', forwardAbort, { once: true })
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      // The archive is a public read-only service; no credentials are sent.
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(`archive responded ${response.status} ${response.statusText}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', forwardAbort)
  }
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * External data is never trusted structurally. Anything that is not a plain
 * object carrying a usable planet name is dropped rather than allowed to reach
 * the renderer.
 */
function validateRows(payload) {
  if (!Array.isArray(payload)) {
    throw new Error('archive payload was not an array')
  }
  const rows = payload.filter(
    (row) => row && typeof row === 'object' && !Array.isArray(row) && typeof row.pl_name === 'string',
  )
  if (!rows.length) {
    throw new Error('archive payload contained no usable rows')
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* cache                                                               */
/* ------------------------------------------------------------------ */

function safeLocalStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    // Private-mode browsers expose localStorage but throw on write.
    const probe = '__astrovita_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}

export function readCache() {
  const store = safeLocalStorage()
  if (!store) return null
  try {
    const raw = store.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.schema !== CACHE_SCHEMA || !Array.isArray(parsed.rows)) return null
    if (typeof parsed.fetchedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(rows) {
  const store = safeLocalStorage()
  if (!store) return
  try {
    store.setItem(
      CACHE_KEY,
      JSON.stringify({
        schema: CACHE_SCHEMA,
        datasetVersion: registry.meta.schemaVersion,
        source: 'NASA Exoplanet Archive',
        fetchedAt: Date.now(),
        rowCount: rows.length,
        rows,
      }),
    )
  } catch {
    // Quota exceeded or storage disabled: caching is an optimisation, not a
    // requirement. The observatory keeps working without it.
  }
}

export function clearCatalogCache() {
  const store = safeLocalStorage()
  if (!store) return
  try {
    store.removeItem(CACHE_KEY)
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* snapshot                                                            */
/* ------------------------------------------------------------------ */

let snapshotCache = null

/** Normalized bundled snapshot. Computed once per session. */
export function getSnapshotPlanets() {
  if (!snapshotCache) {
    snapshotCache = registry.planets.map(normalizeRegistryEntry).filter(Boolean)
  }
  return snapshotCache
}

/** Curated astronomy facts used by the DID YOU KNOW prompts. */
export function getCatalogFacts() {
  return Array.isArray(registry.facts) ? registry.facts : []
}

export function getRegistryMeta() {
  return registry.meta
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

function buildMeta({ status, fetchedAt, count, note }) {
  return {
    status,
    source:
      status === DATA_STATUS.OFFLINE ? 'LOCAL CATALOG SNAPSHOT' : 'NASA EXOPLANET ARCHIVE',
    sourceUrl: 'https://exoplanetarchive.ipac.caltech.edu/',
    fetchedAt: fetchedAt ?? null,
    ageMs: fetchedAt ? Date.now() - fetchedAt : null,
    isLive: status === DATA_STATUS.LIVE,
    count,
    note,
    queryLimit: CATALOG_LIMIT,
  }
}

/**
 * Load the exoplanet catalog.
 *
 * @param {object} options
 * @param {AbortSignal} [options.signal]  cancels the network request on unmount
 * @param {(stage: string) => void} [options.onStage]  boot-sequence progress
 * @param {boolean} [options.forceRefresh]  bypass a fresh cache entry
 * @returns {Promise<{planets: Array, meta: object}>} always resolves; the
 *          observatory has no failure state, only a degraded data source.
 */
export async function loadExoplanetCatalog({ signal, onStage, forceRefresh = false } = {}) {
  const snapshot = getSnapshotPlanets()
  const report = (stage) => {
    if (typeof onStage === 'function') onStage(stage)
  }

  const cached = readCache()
  const cacheIsFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS

  // A fresh cache short-circuits the network entirely: the archive is a shared
  // public service and there is no reason to re-query it on every reload.
  if (cached && cacheIsFresh && !forceRefresh) {
    report('READING LOCAL OBSERVATORY CACHE')
    try {
      const planets = validateRows(cached.rows).map(normalizeArchiveRow).filter(Boolean)
      return {
        planets: annotateWithSnapshot(planets, snapshot),
        meta: buildMeta({
          status: DATA_STATUS.CACHED,
          fetchedAt: cached.fetchedAt,
          count: planets.length,
          note: 'Served from a recent cached archive response.',
        }),
      }
    } catch {
      clearCatalogCache()
    }
  }

  report('CONNECTING TO NASA EXOPLANET ARCHIVE')

  try {
    const payload = await fetchWithTimeout(buildQueryUrl(), { signal })
    const rows = validateRows(payload)
    report('NORMALIZING STELLAR PARAMETERS')
    const planets = rows.map(normalizeArchiveRow).filter(Boolean)
    if (!planets.length) throw new Error('no rows survived normalization')
    writeCache(rows)
    return {
      planets: annotateWithSnapshot(planets, snapshot),
      meta: buildMeta({
        status: DATA_STATUS.LIVE,
        fetchedAt: Date.now(),
        count: planets.length,
        note: `Live TAP query, nearest ${CATALOG_LIMIT} systems with a measured radius.`,
      }),
    }
  } catch (error) {
    if (signal?.aborted) throw error

    report('REMOTE CATALOG UNAVAILABLE — SWITCHING TO LOCAL CACHE')

    if (cached) {
      try {
        const planets = validateRows(cached.rows).map(normalizeArchiveRow).filter(Boolean)
        return {
          planets: annotateWithSnapshot(planets, snapshot),
          meta: buildMeta({
            status: DATA_STATUS.CACHED,
            fetchedAt: cached.fetchedAt,
            count: planets.length,
            note: `Archive unreachable (${error.message}). Showing the last successful response.`,
          }),
        }
      } catch {
        clearCatalogCache()
      }
    }

    report('LOADING BUNDLED CATALOG SNAPSHOT')
    return {
      planets: snapshot,
      meta: buildMeta({
        status: DATA_STATUS.OFFLINE,
        fetchedAt: null,
        count: snapshot.length,
        note: `Archive unreachable (${error.message}). Showing the bundled offline snapshot.`,
      }),
    }
  }
}

/** Human-readable cache age, e.g. "CACHED 3 HOURS AGO". */
export function describeAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return null
  const minutes = Math.floor(ageMs / 60000)
  if (minutes < 1) return 'CACHED MOMENTS AGO'
  if (minutes < 60) return `CACHED ${minutes} MIN AGO`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `CACHED ${hours} HOUR${hours === 1 ? '' : 'S'} AGO`
  const days = Math.floor(hours / 24)
  return `CACHED ${days} DAY${days === 1 ? '' : 'S'} AGO`
}
