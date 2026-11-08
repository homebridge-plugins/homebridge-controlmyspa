/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * history.ts: @homebridge-plugins/homebridge-controlmyspa
 *
 * A record of each spa's water temperature, estimated power, and every time a
 * component turned on or off - written by the plugin on each refresh, and read
 * back by the settings page to draw the dashboard.
 *
 * One JSON object per line, appended, so each refresh writes a few dozen bytes
 * rather than rewriting the whole file (Homebridge often runs from an SD card).
 * Entries older than the retention period are trimmed every few hours.
 */

import type { CmsComponent, CmsDashboard } from './settings.js'

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HISTORY_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const COMPACT_EVERY_MS = 6 * 60 * 60 * 1000

/** A reading from one refresh. Temperatures are fahrenheit, as the api sends them. */
export interface HistorySample {
  t: number
  /** water temperature, °F */
  temp?: number
  /** set temperature, °F */
  set?: number
  /** estimated draw, W */
  w?: number
  /** 1 when the spa displays celsius */
  c?: 1
  /** 1 when the spa was offline at this refresh */
  off?: 1
}

/** A component changing state, e.g. { k: 'PUMP:0', v: 'HIGH' } */
export interface HistoryEvent {
  t: number
  k: string
  v: string
}

export type HistoryEntry = HistorySample | HistoryEvent

export function isEvent(entry: HistoryEntry): entry is HistoryEvent {
  return typeof (entry as HistoryEvent).k === 'string'
}

// What the dashboard's activity timeline shows, in the order it shows them
export const TRACKED_TYPES = [
  'HEATER',
  'PUMP',
  'BLOWER',
  'CIRCULATION_PUMP',
  'FILTER',
  'LIGHT',
  'OZONE',
]

/** The key a component's events are recorded under */
export function componentKey(component: Pick<CmsComponent, 'componentType' | 'port'>): string {
  return `${component.componentType}:${component.port ?? ''}`
}

/** A spa id made safe to put in a file name */
export function safeId(spaId: string): string {
  return spaId.replace(/[^\w-]/g, '_')
}

export function historyDir(storagePath: string): string {
  return join(storagePath, 'controlmyspa')
}

export function historyFile(storagePath: string, spaId: string): string {
  return join(historyDir(storagePath), `history-${safeId(spaId)}.jsonl`)
}

export function historyIndexFile(storagePath: string): string {
  return join(historyDir(storagePath), 'history-index.json')
}

function parseTemp(value: unknown): number | undefined {
  const parsed = typeof value === 'string'
    ? Number.parseFloat(value)
    : typeof value === 'number'
      ? value
      : Number.NaN
  // the api reports 0 for "no reading"
  return Number.isFinite(parsed) && parsed !== 0
    ? parsed
    : undefined
}

/**
 * Read a history file, skipping any line that is not a whole entry (the last
 * line of a file cut short by a power cut, say).
 * @param path - the history file
 */
export function readHistory(path: string): HistoryEntry[] {
  if (!existsSync(path)) {
    return []
  }
  const entries: HistoryEntry[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line) {
      continue
    }
    try {
      const entry = JSON.parse(line)
      if (typeof entry?.t === 'number' && Number.isFinite(entry.t)) {
        entries.push(entry)
      }
    } catch {
      // a partial line - skip it
    }
  }
  return entries
}

/**
 * Writes one spa's history as the plugin polls it.
 */
export class HistoryRecorder {
  private readonly path: string
  private lastValues = new Map<string, string>()
  private lastCompactAt = 0
  private failed = false

  constructor(
    private readonly storagePath: string,
    private readonly spaId: string,
    spaName: string,
    private readonly onError: (message: string) => void = () => {},
  ) {
    this.path = historyFile(storagePath, spaId)
    try {
      mkdirSync(historyDir(storagePath), { recursive: true })
      this.writeIndex(spaName)
    } catch (e: any) {
      this.reportError(`Could not set up the spa history in ${historyDir(storagePath)}: ${e?.message ?? e}`)
    }
  }

  private writeIndex(spaName: string) {
    const path = historyIndexFile(this.storagePath)
    let index: { spas?: Record<string, { name: string }> } = {}
    try {
      index = existsSync(path)
        ? JSON.parse(readFileSync(path, 'utf-8'))
        : {}
    } catch {
      index = {}
    }
    index.spas = {
      ...index.spas,
      [this.spaId]: { name: spaName },
    }
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(index, null, 2))
    renameSync(temp, path)
  }

  /**
   * Record one refresh: a reading, plus an event for each component whose
   * state has changed since the last one (all of them, the first time).
   * @param dashboard - the spa's live state
   * @param watts - the estimated draw, when known
   * @param now - when it was fetched
   */
  record(dashboard: CmsDashboard, watts: number | undefined, now: number = Date.now()): void {
    const lines: HistoryEntry[] = []
    if (dashboard.isOnline === false) {
      lines.push({ t: now, off: 1 })
    } else {
      const sample: HistorySample = { t: now }
      const temp = parseTemp(dashboard.currentTemp)
      const set = parseTemp(dashboard.desiredTemp)
      if (temp !== undefined) {
        sample.temp = temp
      }
      if (set !== undefined) {
        sample.set = set
      }
      if (watts !== undefined) {
        sample.w = watts
      }
      if (dashboard.isCelsius) {
        sample.c = 1
      }
      lines.push(sample)
      for (const component of dashboard.components ?? []) {
        if (!TRACKED_TYPES.includes(component.componentType)) {
          continue
        }
        const key = componentKey(component)
        const value = component.value ?? 'OFF'
        if (this.lastValues.get(key) !== value) {
          this.lastValues.set(key, value)
          lines.push({ t: now, k: key, v: value })
        }
      }
    }
    try {
      appendFileSync(this.path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
      this.failed = false
    } catch (e: any) {
      this.reportError(`Could not write the spa history to ${this.path}: ${e?.message ?? e}`)
    }
    if (now - this.lastCompactAt >= COMPACT_EVERY_MS) {
      this.compact(now)
    }
  }

  /**
   * Drop entries older than the retention period, keeping the last event of
   * each component from before the cut so its state at the start is known.
   * @param now - the current time
   */
  compact(now: number = Date.now()): void {
    this.lastCompactAt = now
    try {
      const cutoff = now - HISTORY_RETENTION_DAYS * DAY_MS
      const entries = readHistory(this.path)
      if (entries.length === 0 || entries[0].t >= cutoff) {
        return
      }
      const carried = new Map<string, HistoryEvent>()
      const kept: HistoryEntry[] = []
      for (const entry of entries) {
        if (entry.t >= cutoff) {
          kept.push(entry)
        } else if (isEvent(entry)) {
          carried.set(entry.k, { ...entry, t: cutoff })
        }
      }
      const all = [
        ...carried.values(),
        ...kept,
      ]
      const temp = `${this.path}.tmp`
      writeFileSync(temp, all.length
        ? `${all.map(entry => JSON.stringify(entry)).join('\n')}\n`
        : '')
      renameSync(temp, this.path)
    } catch (e: any) {
      this.reportError(`Could not trim the spa history in ${this.path}: ${e?.message ?? e}`)
    }
  }

  private reportError(message: string) {
    // once per run of failures, so a full disk does not fill the log as well
    if (!this.failed) {
      this.failed = true
      this.onError(message)
    }
  }
}

// ---------------------------------------------------------------------------
// Reading it back for the dashboard
// ---------------------------------------------------------------------------

export interface HistoryQuery {
  /** the window to show: it ends now and starts this many hours ago */
  hours: number
  /** the viewer's offset from UTC in minutes (as -Date.getTimezoneOffset()), so days start at their midnight */
  tzOffsetMinutes?: number
  /** the longest gap between readings that still counts toward the energy total */
  maxGapMs: number
  /** how many points each line chart is reduced to */
  points?: number
  now?: number
}

export interface ChartPoint {
  t: number
  /** water temperature, in the display unit; null where there is no reading */
  temp: number | null
  set: number | null
  /** average estimated draw over the point's span, W */
  w: number | null
}

export interface EnergyBucket {
  /** start of the hour or day */
  t: number
  kWh: number
}

export interface ActivitySegment {
  from: number
  to: number
  /** the state while it ran - ON, HIGH, LOW */
  v: string
}

export interface ActivityLane {
  key: string
  label: string
  segments: ActivitySegment[]
  /** total time it ran in the window, ms */
  onMs: number
}

export interface ChangeRow {
  t: number
  label: string
  from: string
  to: string
}

export interface HistoryReport {
  from: number
  to: number
  unit: 'C' | 'F'
  /** the most recent reading, whatever the window */
  latest?: { t: number, temp: number | null, set: number | null, w: number | null, offline: boolean }
  points: ChartPoint[]
  /** per hour for a window of two days or less, per day otherwise */
  bucket: 'hour' | 'day'
  energy: EnergyBucket[]
  totalKWh: number
  lanes: ActivityLane[]
  /** state changes in the window, newest first */
  changes: ChangeRow[]
  /** whether there is any reading at all */
  empty: boolean
}

const TYPE_LABELS: Record<string, string> = {
  HEATER: 'Heater',
  PUMP: 'Jets',
  BLOWER: 'Blower',
  CIRCULATION_PUMP: 'Circulation pump',
  FILTER: 'Filter cycle',
  LIGHT: 'Light',
  OZONE: 'Ozone',
}

/**
 * The names the dashboard shows - numbered only when the spa has more than one
 * of a kind, the way the HomeKit tiles are named.
 * @param keys - every component key in the history
 */
export function laneLabels(keys: string[]): Map<string, string> {
  const labels = new Map<string, string>()
  const byType = new Map<string, string[]>()
  for (const key of keys) {
    const type = key.slice(0, key.lastIndexOf(':'))
    byType.set(type, [
      ...(byType.get(type) ?? []),
      key,
    ])
  }
  for (const [type, ofType] of byType) {
    for (const key of ofType) {
      const port = Number.parseInt(key.slice(key.lastIndexOf(':') + 1), 10)
      const base = TYPE_LABELS[type] ?? type.toLowerCase()
      labels.set(key, ofType.length > 1 && !Number.isNaN(port)
        ? `${base} ${port + 1}`
        : base)
    }
  }
  return labels
}

/** Whether a recorded state means running (WAITING and DISABLED do not) */
export function isRunningValue(value: string): boolean {
  return value !== 'OFF' && value !== 'WAITING' && value !== 'DISABLED'
}

const toC = (f: number) => Math.round(((f - 32) * 5 / 9) * 10) / 10

/**
 * Turn the raw history into what the dashboard draws.
 * @param entries - the spa's history, oldest first
 * @param query - the window and options
 */
export function buildReport(entries: HistoryEntry[], query: HistoryQuery): HistoryReport {
  const to = query.now ?? Date.now()
  const from = to - query.hours * 60 * 60 * 1000
  const offsetMs = (query.tzOffsetMinutes ?? 0) * 60_000
  const bucket: 'hour' | 'day' = query.hours <= 48
    ? 'hour'
    : 'day'
  const bucketMs = bucket === 'hour'
    ? 60 * 60 * 1000
    : DAY_MS
  const bucketStart = (t: number) => Math.floor((t + offsetMs) / bucketMs) * bucketMs - offsetMs

  const samples = entries.filter((entry): entry is HistorySample => !isEvent(entry))
  const events = entries.filter(isEvent)

  const lastWithTemp = [...samples].reverse().find(sample => sample.temp !== undefined || sample.off)
  const unit: 'C' | 'F' = [...samples].reverse().find(sample => !sample.off)?.c
    ? 'C'
    : 'F'
  const display = (f: number | undefined) => (f === undefined
    ? null
    : unit === 'C'
      ? toC(f)
      : f)

  const lastSample = samples.at(-1)
  const latest = lastSample
    ? {
        t: lastSample.t,
        temp: display(lastSample.off ? lastWithTemp?.temp : lastSample.temp),
        set: display(lastSample.set),
        w: lastSample.w ?? null,
        offline: lastSample.off === 1,
      }
    : undefined

  // --- energy, integrated at full resolution (each reading's watts held until the next)
  const energyMap = new Map<number, number>()
  for (let t = bucketStart(from); t < to; t += bucketMs) {
    energyMap.set(bucketStart(t), 0)
  }
  let totalWh = 0
  for (let i = 0; i < samples.length - 1; i += 1) {
    const sample = samples[i]
    const next = samples[i + 1]
    if (sample.w === undefined || sample.off) {
      continue
    }
    const start = Math.max(sample.t, from)
    const end = Math.min(next.t, to)
    const span = next.t - sample.t
    if (end <= start || span > query.maxGapMs) {
      continue
    }
    // split across bucket boundaries, so an interval spanning midnight lands on both days
    let cursor = start
    while (cursor < end) {
      const boundary = bucketStart(cursor) + bucketMs
      const pieceEnd = Math.min(end, boundary)
      const wh = sample.w * (pieceEnd - cursor) / 3_600_000
      const key = bucketStart(cursor)
      energyMap.set(key, (energyMap.get(key) ?? 0) + wh)
      totalWh += wh
      cursor = pieceEnd
    }
  }
  const energy = [
    ...energyMap.entries(),
  ]
    .filter(([t]) => t + bucketMs > from)
    .sort((a, b) => a[0] - b[0])
    .map(([t, wh]) => ({ t, kWh: Math.round(wh) / 1000 }))

  // --- line chart points: the window split into equal slots, each the average of its readings
  const slots = Math.max(10, query.points ?? 300)
  const slotMs = (to - from) / slots
  const sums = Array.from({ length: slots }, () => ({
    temp: 0,
    tempN: 0,
    w: 0,
    wN: 0,
    set: undefined as number | undefined,
  }))
  for (const sample of samples) {
    if (sample.t < from || sample.t > to || sample.off) {
      continue
    }
    const slot = sums[Math.min(slots - 1, Math.floor((sample.t - from) / slotMs))]
    if (sample.temp !== undefined) {
      slot.temp += sample.temp
      slot.tempN += 1
    }
    if (sample.w !== undefined) {
      slot.w += sample.w
      slot.wN += 1
    }
    if (sample.set !== undefined) {
      slot.set = sample.set
    }
  }
  const points: ChartPoint[] = sums.map((slot, i) => ({
    t: Math.round(from + slotMs * (i + 0.5)),
    temp: slot.tempN
      ? display(slot.temp / slot.tempN)
      : null,
    set: display(slot.set),
    w: slot.wN
      ? Math.round(slot.w / slot.wN)
      : null,
  }))
  for (const point of points) {
    if (point.temp !== null && unit === 'F') {
      point.temp = Math.round(point.temp * 10) / 10
    }
  }

  // --- activity lanes: each component's runs, clipped to the window
  const keys = [
    ...new Set(events.map(event => event.k)),
  ]
  const labels = laneLabels(keys)
  const typeOrder = (key: string) => {
    const index = TRACKED_TYPES.indexOf(key.slice(0, key.lastIndexOf(':')))
    return index === -1
      ? TRACKED_TYPES.length
      : index
  }
  keys.sort((a, b) => typeOrder(a) - typeOrder(b) || a.localeCompare(b))

  // The end of what is known: a run still going is drawn up to the last reading
  const knownUntil = Math.min(to, lastSample?.t ?? to)
  const lanes: ActivityLane[] = []
  const changes: ChangeRow[] = []
  for (const key of keys) {
    const label = labels.get(key) ?? key
    const ofKey = events.filter(event => event.k === key)
    const segments: ActivitySegment[] = []
    let current: { v: string, since: number } | undefined
    let previousValue: string | undefined
    for (const event of ofKey) {
      if (event.v === previousValue) {
        // a repeat (the plugin restarted) - not a change
        continue
      }
      if (event.t >= from && previousValue !== undefined) {
        changes.push({
          t: event.t,
          label,
          from: previousValue,
          to: event.v,
        })
      }
      if (current && isRunningValue(current.v)) {
        const start = Math.max(current.since, from)
        const end = Math.min(event.t, to)
        if (end > start) {
          segments.push({ from: start, to: end, v: current.v })
        }
      }
      current = { v: event.v, since: event.t }
      previousValue = event.v
    }
    if (current && isRunningValue(current.v)) {
      const start = Math.max(current.since, from)
      if (knownUntil > start) {
        segments.push({ from: start, to: knownUntil, v: current.v })
      }
    }
    lanes.push({
      key,
      label,
      segments,
      onMs: segments.reduce((sum, s) => sum + (s.to - s.from), 0),
    })
  }
  changes.sort((a, b) => b.t - a.t)

  return {
    from,
    to,
    unit,
    latest,
    points,
    bucket,
    energy,
    totalKWh: Math.round(totalWh) / 1000,
    lanes,
    changes,
    empty: samples.length === 0,
  }
}
