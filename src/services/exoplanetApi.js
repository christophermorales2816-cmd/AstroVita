/**
 * FILE: src/services/exoplanetApi.js
 *
 * PURPOSE
 *   Sole entry point for every remote or cached catalog read. Fetches the FULL
 *   confirmed-exoplanet catalog from the NASA Exoplanet Archive TAP service
 *   (no row cap), validates it, and hands normalized structures to the app.
 *   React components never call fetch() directly.
 *
 * DEPENDENCIES
 *   ../data/exoplanet_registry.json  bundled offline snapshot
 *   ./dataNormalizer.js              normalizeCatalog / normalizeArchiveRow
 *
 * PERFORMANCE-CRITICAL DECISIONS
 *   - The full catalog is ~6,000 rows x 21 columns, roughly 2-3 MB of JSON.
 *     localStorage quota is typically 5 MB PER ORIGIN, and a single setItem of
 *     that size can throw QuotaExceededError even when nominally under the cap
 *     (UTF-16 storage doubles the byte cost of the string). Hence the chunked
 *     cache below: payloads over 4.5 MB are split across numbered keys with a
 *     manifest, and reassembled on read.
 *   - The manifest is written LAST and cleared FIRST. An interrupted write can
 *     therefore never be mistaken for a complete one, which would otherwise
 *     deserialize into truncated JSON and throw on every subsequent boot.
 *   - The ADQL query is sent once. There is no pagination loop; TAP returns the
 *     whole result set in one response and chunking happens at the cache layer.
 *
 * RELIABILITY STRATEGY (in order):
 *   1. LIVE    successful TAP query, written to the chunked cache.
 *   2. CACHED  last successful response, with its real age surfaced to the UI.
 *              Never presented as live.
 *   3. OFFLINE bundled snapshot, explicitly labelled as a snapshot.
 *
 * VERIFICATION NOTE
 *   The `pl_controv_flag` predicate could not be executed against the live
 *   service from the build environment (outbound access to
 *   exoplanetarchive.ipac.caltech.edu is blocked there). The query therefore
 *   runs a two-attempt strategy: the filtered query first, and on an
 *   archive-side query error a single retry without that predicate. This costs
 *   nothing when the column exists and prevents a hard fallback to the offline
 *   snapshot if it does not.
 */

import registry from '../data/exoplanet_registry.json'
import {
  annotateWithSnapshot,
  normalizeArchiveRow,
  normalizeCatalog,
  normalizeRegistryEntry,
} from './dataNormalizer.js'

const TAP_ENDPOINT = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync'

/** Optional server-side pass-through. Empty in the default static deployment. */
const PROXY_BASE = (import.meta.env?.VITE_EXOPLANET_PROXY ?? '').trim()

const CACHE_PREFIX = 'astrovita_cache_'
const CACHE_MANIFEST_KEY = 'cache_manifest'
const CACHE_SCHEMA = 2

/** Split threshold. Below this the payload goes into a single chunk. */
const CACHE_CHUNK_THRESHOLD = 4_500_000

/** Characters per chunk once splitting kicks in. */
const CACHE_CHUNK_SIZE = 2_000_000

/** Cached responses are reusable for 24 hours, per spec. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** The full catalog is a large response; allow a generous but bounded wait. */
const REQUEST_TIMEOUT_MS = 45_000

export const DATA_STATUS = {
  LIVE: 'LIVE',
  CACHED: 'CACHED',
  OFFLINE: 'OFFLINE',
}

/* ------------------------------------------------------------------ */
/* query                                                               */
/* ------------------------------------------------------------------ */

const COLUMNS = [
  'pl_name',
  'hostname',
  'sy_pnum',
  'sy_snum',
  'pl_orbper',
  'pl_orbsmax',
  'pl_rade',
  'pl_bmasse',
  'pl_orbeccen',
  'pl_orbincl',
  'pl_eqt',
  'discoverymethod',
  'disc_year',
  'st_spectype',
  'st_teff',
  'st_rad',
  'st_mass',
  'sy_vmag',
  'ra',
  'dec',
  'sy_dist',
].join(',')

/**
 * @param {boolean} withControvFilter include the `pl_controv_flag = 0` predicate
 */
function buildAdql(withControvFilter) {
  // sy_dist is required: without a distance a host star cannot be placed in the
  // macro view at all, and inventing one would fabricate a measurement.
  const predicates = ['sy_dist is not null']
  if (withControvFilter) predicates.push('pl_controv_flag = 0')
  return `select ${COLUMNS} from pscomppars where ${predicates.join(' and ')} order by sy_dist asc`
}

function buildQueryUrl(adql) {
  const params = new URLSearchParams({ query: adql, format: 'json' })
  if (PROXY_BASE) {
    const separator = PROXY_BASE.includes('?') ? '&' : '?'
    return `${PROXY_BASE}${separator}${params.toString()}`
  }
  return `${TAP_ENDPOINT}?${params.toString()}`
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

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
      // Public read-only service; no credentials are ever sent.
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
 * External data is never structurally trusted. Anything that is not a plain
 * object with a usable planet name is dropped before it can reach the renderer.
 */
function validateRows(payload) {
  if (!Array.isArray(payload)) throw new Error('archive payload was not an array')
  const rows = payload.filter(
    (row) =>
      row && typeof row === 'object' && !Array.isArray(row) && typeof row.pl_name === 'string',
  )
  if (!rows.length) throw new Error('archive payload contained no usable rows')
  return rows
}

/* ------------------------------------------------------------------ */
/* chunked cache                                                       */
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

/** Remove every chunk plus the manifest. Safe to call when nothing is cached. */
export function clearCatalogCache() {
  const store = safeLocalStorage()
  if (!store) return
  try {
    const manifest = JSON.parse(store.getItem(CACHE_MANIFEST_KEY) ?? 'null')
    const count = Number.isInteger(manifest?.chunks) ? manifest.chunks : 0
    // Clear a generous superset in case a previous manifest was itself lost.
    for (let i = 0; i < Math.max(count, 8); i += 1) {
      store.removeItem(`${CACHE_PREFIX}${i}`)
    }
    store.removeItem(CACHE_MANIFEST_KEY)
  } catch {
    /* best effort */
  }
}

/**
 * Read and reassemble the cache.
 * @returns {{rows: Array, fetchedAt: number}|null}
 */
export function readCache() {
  const store = safeLocalStorage()
  if (!store) return null
  try {
    const manifest = JSON.parse(store.getItem(CACHE_MANIFEST_KEY) ?? 'null')
    if (!manifest || manifest.schema !== CACHE_SCHEMA) return null
    if (!Number.isInteger(manifest.chunks) || manifest.chunks < 1) return null
    if (typeof manifest.fetchedAt !== 'number') return null

    // Expired entries are dropped rather than silently served as fresh.
    if (Date.now() - manifest.fetchedAt > CACHE_TTL_MS) {
      clearCatalogCache()
      return null
    }

    let serialized = ''
    for (let i = 0; i < manifest.chunks; i += 1) {
      const part = store.getItem(`${CACHE_PREFIX}${i}`)
      if (part === null) {
        // A missing chunk means a partial write or an eviction. Unusable.
        clearCatalogCache()
        return null
      }
      serialized += part
    }

    const rows = JSON.parse(serialized)
    if (!Array.isArray(rows) || !rows.length) {
      clearCatalogCache()
      return null
    }
    return { rows, fetchedAt: manifest.fetchedAt }
  } catch {
    clearCatalogCache()
    return null
  }
}

/**
 * Serialize and write the catalog, splitting across numbered keys when the
 * payload exceeds the single-key threshold.
 *
 * Any failure purges the whole cache: a half-written chunk set would fail to
 * parse on every future boot, which is worse than no cache at all.
 */
function writeCache(rows) {
  const store = safeLocalStorage()
  if (!store) return

  let serialized
  try {
    serialized = JSON.stringify(rows)
  } catch {
    return
  }

  // Always start from a clean slate so stale chunks from a larger previous
  // payload cannot be appended onto a smaller new one.
  clearCatalogCache()

  try {
    const chunkSize =
      serialized.length > CACHE_CHUNK_THRESHOLD ? CACHE_CHUNK_SIZE : serialized.length
    const chunkCount = Math.max(1, Math.ceil(serialized.length / chunkSize))

    for (let i = 0; i < chunkCount; i += 1) {
      store.setItem(`${CACHE_PREFIX}${i}`, serialized.slice(i * chunkSize, (i + 1) * chunkSize))
    }

    // Written LAST: until the manifest exists the chunks are invisible to
    // readCache(), so an interrupted write cannot be read back as complete.
    store.setItem(
      CACHE_MANIFEST_KEY,
      JSON.stringify({
        schema: CACHE_SCHEMA,
        chunks: chunkCount,
        bytes: serialized.length,
        rowCount: rows.length,
        source: 'NASA Exoplanet Archive',
        datasetVersion: registry.meta.schemaVersion,
        fetchedAt: Date.now(),
        ttlMs: CACHE_TTL_MS,
      }),
    )
  } catch {
    // Quota exceeded or storage disabled. Caching is an optimisation, never a
    // requirement; drop the partial write and carry on.
    clearCatalogCache()
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

/**
 * Fetch the raw row array from the archive.
 *
 * Named export required by spec. Resolves to the validated raw rows; rejects
 * only on transport failure or an unusable payload. Callers that want the
 * graceful fallback chain should use loadExoplanetCatalog() instead.
 *
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function fetchExoplanetCatalog({ signal } = {}) {
  try {
    const payload = await fetchWithTimeout(buildQueryUrl(buildAdql(true)), { signal })
    return validateRows(payload)
  } catch (error) {
    if (signal?.aborted) throw error
    // A malformed-query response is the signature of a column that does not
    // exist on this table. Retry once without the controversial-flag predicate
    // rather than degrading the whole catalog to the offline snapshot.
    const retryable = /\b(400|500)\b|query|column|syntax|ADQL/i.test(error.message)
    if (!retryable) throw error
    const payload = await fetchWithTimeout(buildQueryUrl(buildAdql(false)), { signal })
    return validateRows(payload)
  }
}

function buildMeta({ status, fetchedAt, count, systemCount, note }) {
  return {
    status,
    source: status === DATA_STATUS.OFFLINE ? 'LOCAL CATALOG SNAPSHOT' : 'NASA EXOPLANET ARCHIVE',
    sourceUrl: 'https://exoplanetarchive.ipac.caltech.edu/',
    fetchedAt: fetchedAt ?? null,
    ageMs: fetchedAt ? Date.now() - fetchedAt : null,
    isLive: status === DATA_STATUS.LIVE,
    count,
    systemCount,
    note,
    queryLimit: null,
  }
}

/**
 * Load the catalog with the full fallback chain.
 *
 * @param {object} options
 * @param {AbortSignal} [options.signal]
 * @param {(stage: string) => void} [options.onStage]
 * @param {boolean} [options.forceRefresh]
 * @returns {Promise<{planets: Array, starSystems: Map, meta: object}>}
 *          Always resolves. The observatory has no failure state, only a
 *          degraded data source.
 */
export async function loadExoplanetCatalog({ signal, onStage, forceRefresh = false } = {}) {
  const snapshot = getSnapshotPlanets()
  const report = (stage) => {
    if (typeof onStage === 'function') onStage(stage)
  }

  const buildResult = (rows, status, fetchedAt, note) => {
    const planets = annotateWithSnapshot(rows.map(normalizeArchiveRow).filter(Boolean), snapshot)
    const { starSystems, allPlanets } = normalizeCatalog(planets)
    return {
      planets: allPlanets,
      starSystems,
      meta: buildMeta({
        status,
        fetchedAt,
        count: allPlanets.length,
        systemCount: starSystems.size,
        note,
      }),
    }
  }

  const cached = readCache()

  // A valid, unexpired cache short-circuits the network entirely. The archive
  // is a shared public service; re-querying several megabytes on every reload
  // is neither necessary nor polite.
  if (cached && !forceRefresh) {
    report('READING LOCAL OBSERVATORY CACHE')
    try {
      return buildResult(
        validateRows(cached.rows),
        DATA_STATUS.CACHED,
        cached.fetchedAt,
        'Served from a cached archive response.',
      )
    } catch {
      clearCatalogCache()
    }
  }

  report('CONNECTING TO NASA EXOPLANET ARCHIVE')

  try {
    const rows = await fetchExoplanetCatalog({ signal })
    report('NORMALIZING STELLAR PARAMETERS')
    const result = buildResult(
      rows,
      DATA_STATUS.LIVE,
      Date.now(),
      `Live TAP query, ${rows.length} confirmed planets.`,
    )
    if (!result.planets.length) throw new Error('no rows survived normalization')
    writeCache(rows)
    return result
  } catch (error) {
    if (signal?.aborted) throw error

    report('REMOTE CATALOG UNAVAILABLE — SWITCHING TO LOCAL CACHE')

    if (cached) {
      try {
        return buildResult(
          validateRows(cached.rows),
          DATA_STATUS.CACHED,
          cached.fetchedAt,
          `Archive unreachable (${error.message}). Showing the last successful response.`,
        )
      } catch {
        clearCatalogCache()
      }
    }

    report('LOADING BUNDLED CATALOG SNAPSHOT')
    const { starSystems, allPlanets } = normalizeCatalog(snapshot)
    return {
      planets: allPlanets,
      starSystems,
      meta: buildMeta({
        status: DATA_STATUS.OFFLINE,
        fetchedAt: null,
        count: allPlanets.length,
        systemCount: starSystems.size,
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
