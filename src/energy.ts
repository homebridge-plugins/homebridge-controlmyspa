/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * energy.ts: @homebridge-plugins/homebridge-controlmyspa
 *
 * An ESTIMATE of the spa's power draw and energy use. A Balboa spa has no
 * electricity meter and the ControlMySpa cloud reports none, so - like
 * @haresik's Home Assistant integration - the plugin takes the components the
 * spa says are running on each poll, multiplies by a wattage per component,
 * and adds up the energy over time. Good for trends, not for billing.
 */

import type { CmsComponent, energyConfig } from './settings.js'

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The wattage used for each kind of component while it runs.
 */
export interface EnergyWatts {
  heater: number
  pumpHigh: number
  pumpLow: number
  blower: number
  circulationPump: number
  light: number
  standby: number
}

/**
 * Defaults. Heater, jet pump, blower and circulation pump match the Home
 * Assistant integration's, so the two give the same figures out of the box.
 * That integration counts a pump on LOW at full power; a two-speed pump on
 * low draws far less, so LOW has its own, lower default here.
 */
export const DEFAULT_WATTS: EnergyWatts = {
  heater: 2800,
  pumpHigh: 2200,
  pumpLow: 500,
  blower: 900,
  circulationPump: 400,
  light: 10,
  standby: 0,
}

// Nothing on a domestic spa circuit draws more than this - a larger number is
// a typo (kW entered as W, an extra zero) and would swamp the estimate
export const MAXIMUM_COMPONENT_WATTS = 15000

/**
 * The wattages to use: each configured value that is a sane number, the
 * default for everything else.
 * @param config - the `options.energy` block of the plugin config
 */
export function resolveWatts(config?: energyConfig): EnergyWatts {
  const pick = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAXIMUM_COMPONENT_WATTS
      ? value
      : fallback
  return {
    heater: pick(config?.heaterWatts, DEFAULT_WATTS.heater),
    pumpHigh: pick(config?.pumpWatts, DEFAULT_WATTS.pumpHigh),
    pumpLow: pick(config?.pumpLowWatts, DEFAULT_WATTS.pumpLow),
    blower: pick(config?.blowerWatts, DEFAULT_WATTS.blower),
    circulationPump: pick(config?.circulationPumpWatts, DEFAULT_WATTS.circulationPump),
    light: pick(config?.lightWatts, DEFAULT_WATTS.light),
    standby: pick(config?.standbyWatts, DEFAULT_WATTS.standby),
  }
}

/**
 * Whether a reported component value means it is drawing power. A heater
 * reports WAITING while it is enabled but not firing (flow check, or the
 * water is already at temperature), which draws nothing.
 * @param value - the component's reported value
 */
export function isDrawingPower(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && value !== 'OFF' && value !== 'WAITING' && value !== 'DISABLED'
}

export interface PowerEstimatePart {
  /** What was counted, as written in the log - "heater", "jets 2 low" */
  label: string
  watts: number
}

export interface PowerEstimate {
  /** Estimated draw right now, in watts */
  watts: number
  /** Whether the spa reports a HEATER component at all - without one the heater cannot be counted */
  heaterReported: boolean
  /** Each component that was counted, in the order the spa lists them, standby last */
  parts: PowerEstimatePart[]
}

const COMPONENT_LABELS: Record<string, string> = {
  HEATER: 'heater',
  PUMP: 'jets',
  BLOWER: 'blower',
  CIRCULATION_PUMP: 'circulation pump',
  LIGHT: 'light',
}

/**
 * Estimate the spa's draw from the components in a dashboard.
 * @param components - the dashboard's components list
 * @param watts - the wattage for each kind of component
 */
export function estimatePower(components: CmsComponent[] | undefined, watts: EnergyWatts): PowerEstimate {
  const list = components ?? []
  const parts: PowerEstimatePart[] = []
  const heaterReported = list.some(component => component.componentType === 'HEATER')
  // Number a component only when the spa has more than one of its kind, the
  // way the HomeKit tiles are named - "jets 2", but just "blower"
  const countOf = (type: string) => list.filter(component => component.componentType === type).length

  for (const component of list) {
    if (!isDrawingPower(component.value)) {
      continue
    }
    let draw: number
    switch (component.componentType) {
      case 'HEATER':
        draw = watts.heater
        break
      case 'PUMP':
        draw = component.value === 'LOW'
          ? watts.pumpLow
          : watts.pumpHigh
        break
      case 'BLOWER':
        draw = watts.blower
        break
      case 'CIRCULATION_PUMP':
        draw = watts.circulationPump
        break
      case 'LIGHT':
        draw = watts.light
        break
      default:
        // Filters, ozone, gateway, controller - no wattage of their own here
        continue
    }
    if (draw === 0) {
      continue
    }
    let label = COMPONENT_LABELS[component.componentType]
    const port = Number.parseInt(component.port ?? '', 10)
    if (countOf(component.componentType) > 1 && !Number.isNaN(port)) {
      label += ` ${port + 1}`
    }
    if (component.componentType === 'PUMP') {
      label += component.value === 'LOW'
        ? ' low'
        : ' high'
    }
    parts.push({ label, watts: draw })
  }
  if (watts.standby > 0) {
    parts.push({ label: 'standby', watts: watts.standby })
  }
  return {
    watts: parts.reduce((sum, part) => sum + part.watts, 0),
    heaterReported,
    parts,
  }
}

/**
 * A whole number of watts with thousands separators, the same on every
 * machine whatever its locale - "3,200 W".
 * @param watts - the number of watts
 */
export function formatWatts(watts: number): string {
  return `${String(Math.round(watts)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} W`
}

/**
 * What the estimate is made of, for the log:
 * "3,200 W: heater 2,800 + circulation pump 400".
 * @param estimate - the estimate to describe
 */
export function describeEstimate(estimate: PowerEstimate): string {
  if (estimate.parts.length === 0) {
    return `${formatWatts(estimate.watts)}: nothing running`
  }
  const parts = estimate.parts.map(part => `${part.label} ${formatWatts(part.watts).slice(0, -2)}`)
  return `${formatWatts(estimate.watts)}: ${parts.join(' + ')}`
}

/**
 * The running total for one spa, as persisted between restarts.
 */
export interface EnergyState {
  /** Cumulative estimated energy, in watt-hours. Only ever increases. */
  totalWh: number
  /** When the last sample was taken (ms since epoch) */
  lastSampleAt?: number
  /** The draw at the last sample, in watts - what the spa is assumed to have drawn until the next one */
  lastWatts?: number
}

export interface AccumulateResult {
  state: EnergyState
  /** Energy added by this sample, in watt-hours */
  addedWh: number
  /** Set when the time since the last sample was too long (or negative) to count */
  skippedMs?: number
}

/**
 * Add the energy used since the last sample and record this one.
 *
 * The draw seen at a poll is assumed to hold until the next poll, so the energy
 * for an interval is the PREVIOUS sample's watts times the time elapsed. A gap
 * longer than `maxGapMs` (Homebridge was down, the cloud was out) is not
 * counted at all: nobody knows what ran during it, and guessing either way
 * would put a step in the total that cannot be taken back - Matter's cumulative
 * energy only ever goes up.
 * @param state - the state before this sample
 * @param now - the time of this sample (ms since epoch)
 * @param watts - the draw seen at this sample, or undefined when it is unknown (spa offline)
 * @param maxGapMs - the longest interval that is counted
 */
export function accumulate(state: EnergyState, now: number, watts: number | undefined, maxGapMs: number): AccumulateResult {
  let addedWh = 0
  let skippedMs: number | undefined
  if (state.lastSampleAt !== undefined && state.lastWatts !== undefined) {
    const elapsed = now - state.lastSampleAt
    if (elapsed > 0 && elapsed <= maxGapMs) {
      addedWh = state.lastWatts * elapsed / 3_600_000
    } else if (elapsed !== 0) {
      skippedMs = elapsed
    }
  }
  return {
    state: {
      totalWh: state.totalWh + addedWh,
      lastSampleAt: now,
      lastWatts: watts,
    },
    addedWh,
    skippedMs,
  }
}

/**
 * The longest polling gap that still counts toward the total: three missed
 * polls, and never less than ten minutes so a post-command refresh or a slow
 * cloud response does not lose an interval.
 * @param refreshRateSeconds - the configured polling interval
 */
export function maxGapFor(refreshRateSeconds: number): number {
  return Math.max(10 * 60 * 1000, refreshRateSeconds * 3 * 1000)
}

/**
 * Keeps each spa's running total on disk, so a restart does not reset the
 * kWh figure Apple Home has already seen (a cumulative total that goes
 * backwards reads as a meter replacement, or is ignored).
 */
export class EnergyStore {
  private states: Record<string, EnergyState> = {}

  constructor(private readonly path: string, private readonly onError: (message: string) => void = () => {}) {
    this.load()
  }

  private load() {
    if (!existsSync(this.path)) {
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8'))
      for (const [spaId, value] of Object.entries(parsed?.spas ?? {})) {
        const state = sanitiseState(value)
        if (state) {
          this.states[spaId] = state
        }
      }
    } catch (e: any) {
      // A damaged file costs the running totals, not the plugin
      this.onError(`Could not read the saved energy totals from ${this.path}, starting from zero: ${e?.message ?? e}`)
    }
  }

  get(spaId: string): EnergyState {
    return this.states[spaId] ?? { totalWh: 0 }
  }

  set(spaId: string, state: EnergyState): void {
    this.states[spaId] = state
    this.save()
  }

  private save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Write then rename, so a crash mid-write cannot leave half a file
      const temp = `${this.path}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, spas: this.states }, null, 2))
      renameSync(temp, this.path)
    } catch (e: any) {
      this.onError(`Could not save the energy totals to ${this.path}: ${e?.message ?? e}`)
    }
  }
}

function sanitiseState(value: any): EnergyState | undefined {
  if (typeof value?.totalWh !== 'number' || !Number.isFinite(value.totalWh) || value.totalWh < 0) {
    return undefined
  }
  const state: EnergyState = { totalWh: value.totalWh }
  if (typeof value.lastSampleAt === 'number' && Number.isFinite(value.lastSampleAt)) {
    state.lastSampleAt = value.lastSampleAt
  }
  if (typeof value.lastWatts === 'number' && Number.isFinite(value.lastWatts) && value.lastWatts >= 0) {
    state.lastWatts = value.lastWatts
  }
  return state
}
