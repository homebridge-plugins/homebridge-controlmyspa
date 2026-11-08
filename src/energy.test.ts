import type { CmsComponent } from './settings.js'

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { accumulate, DEFAULT_WATTS, describeEstimate, EnergyStore, estimatePower, formatWatts, isDrawingPower, maxGapFor, resolveWatts } from './energy.js'

const HOUR = 3_600_000

/**
 * The components from a real dashboard, as captured in @haresik's test data
 * (Data02): heater firing, jets 1 on high, blower, circulation pump and light
 * all on - and the filter and ozone, which carry no wattage of their own.
 */
const BUSY_SPA: CmsComponent[] = [
  { componentType: 'HEATER', port: '0', value: 'ON' },
  { componentType: 'GATEWAY', port: null, value: null },
  { componentType: 'FILTER', port: '0', value: 'OFF' },
  { componentType: 'OZONE', port: null, value: 'OFF' },
  {
    componentType: 'PUMP',
    port: '0',
    value: 'HIGH',
    availableValues: ['OFF', 'LOW', 'HIGH'],
  },
  {
    componentType: 'PUMP',
    port: '1',
    value: 'OFF',
    availableValues: ['OFF', 'LOW', 'HIGH'],
  },
  { componentType: 'BLOWER', port: '0', value: 'HIGH' },
  { componentType: 'CIRCULATION_PUMP', port: null, value: 'HIGH' },
  { componentType: 'LIGHT', port: '0', value: 'HIGH' },
]

describe('the wattage for each component', () => {
  it('falls back to the defaults when nothing is configured', () => {
    expect(resolveWatts(undefined)).toEqual(DEFAULT_WATTS)
  })

  it('uses what the owner configured', () => {
    const watts = resolveWatts({ heaterWatts: 4000, pumpWatts: 1500, standbyWatts: 15 })
    expect(watts.heater).toBe(4000)
    expect(watts.pumpHigh).toBe(1500)
    expect(watts.standby).toBe(15)
    expect(watts.blower).toBe(DEFAULT_WATTS.blower)
  })

  it('ignores a value that cannot be right', () => {
    // kW typed with an extra zero, a negative, and a string from a hand-edited config
    const watts = resolveWatts({ heaterWatts: 280000, pumpWatts: -1, blowerWatts: '900' as unknown as number })
    expect(watts.heater).toBe(DEFAULT_WATTS.heater)
    expect(watts.pumpHigh).toBe(DEFAULT_WATTS.pumpHigh)
    expect(watts.blower).toBe(DEFAULT_WATTS.blower)
  })

  it('allows zero, to leave a component out', () => {
    expect(resolveWatts({ lightWatts: 0 }).light).toBe(0)
  })
})

describe('whether a component is drawing power', () => {
  it('running values are', () => {
    for (const value of ['ON', 'HIGH', 'LOW', 'MED']) {
      expect(isDrawingPower(value)).toBe(true)
    }
  })

  it('a heater WAITING is not - it is enabled but not firing', () => {
    expect(isDrawingPower('WAITING')).toBe(false)
  })

  it('off, disabled and missing values are not', () => {
    for (const value of ['OFF', 'DISABLED', null, undefined]) {
      expect(isDrawingPower(value)).toBe(false)
    }
  })
})

describe('the estimated draw', () => {
  it('adds up everything running', () => {
    const estimate = estimatePower(BUSY_SPA, DEFAULT_WATTS)
    // heater 2800 + jets 2200 + blower 900 + circulation 400 + light 10
    expect(estimate.watts).toBe(6310)
    expect(estimate.heaterReported).toBe(true)
  })

  it('counts a two-speed pump on low at the low wattage', () => {
    const estimate = estimatePower([
      { componentType: 'PUMP', port: '0', value: 'LOW' },
    ], DEFAULT_WATTS)
    expect(estimate.watts).toBe(DEFAULT_WATTS.pumpLow)
  })

  it('counts every heater and pump, not just the first', () => {
    const estimate = estimatePower([
      { componentType: 'HEATER', port: '0', value: 'ON' },
      { componentType: 'HEATER', port: '1', value: 'ON' },
      { componentType: 'PUMP', port: '0', value: 'HIGH' },
      { componentType: 'PUMP', port: '1', value: 'HIGH' },
    ], DEFAULT_WATTS)
    expect(estimate.watts).toBe(2 * DEFAULT_WATTS.heater + 2 * DEFAULT_WATTS.pumpHigh)
  })

  it('is the standby draw alone for a spa with everything off', () => {
    const estimate = estimatePower([
      { componentType: 'PUMP', port: '0', value: 'OFF' },
    ], { ...DEFAULT_WATTS, standby: 12 })
    expect(estimate.watts).toBe(12)
  })

  it('says when the spa does not report a heater at all', () => {
    // Two of the three captured dashboards list no HEATER component
    const estimate = estimatePower([
      { componentType: 'PUMP', port: '0', value: 'HIGH' },
    ], DEFAULT_WATTS)
    expect(estimate.heaterReported).toBe(false)
  })

  it('copes with a dashboard that has no components', () => {
    expect(estimatePower(undefined, DEFAULT_WATTS).watts).toBe(0)
  })
})

describe('the breakdown written to the log', () => {
  it('names each part and its wattage', () => {
    // the reading an owner saw jump to after the jets went off: the heater
    // starting, alongside the circulation pump
    const estimate = estimatePower([
      { componentType: 'HEATER', port: '0', value: 'ON' },
      { componentType: 'PUMP', port: '0', value: 'OFF' },
      { componentType: 'CIRCULATION_PUMP', port: null, value: 'HIGH' },
    ], DEFAULT_WATTS)
    expect(describeEstimate(estimate)).toBe('3,200 W: heater 2,800 + circulation pump 400')
  })

  it('numbers pumps only when there is more than one, and gives their speed', () => {
    const estimate = estimatePower([
      { componentType: 'PUMP', port: '0', value: 'HIGH' },
      { componentType: 'PUMP', port: '1', value: 'LOW' },
      { componentType: 'BLOWER', port: '0', value: 'HIGH' },
    ], DEFAULT_WATTS)
    expect(describeEstimate(estimate)).toBe('3,600 W: jets 1 high 2,200 + jets 2 low 500 + blower 900')
    const single = estimatePower([
      { componentType: 'PUMP', port: '0', value: 'HIGH' },
    ], DEFAULT_WATTS)
    expect(describeEstimate(single)).toBe('2,200 W: jets high 2,200')
  })

  it('lists the standby draw last, and leaves out parts set to 0 W', () => {
    const estimate = estimatePower([
      { componentType: 'LIGHT', port: '0', value: 'HIGH' },
    ], { ...DEFAULT_WATTS, light: 0, standby: 15 })
    expect(describeEstimate(estimate)).toBe('15 W: standby 15')
  })

  it('says when nothing is running', () => {
    expect(describeEstimate(estimatePower([], DEFAULT_WATTS))).toBe('0 W: nothing running')
  })

  it('formats large readings the same on every machine', () => {
    expect(formatWatts(12345.6)).toBe('12,346 W')
    expect(formatWatts(400)).toBe('400 W')
  })
})

describe('adding up the energy', () => {
  const GAP = maxGapFor(60)

  it('adds nothing on the very first sample - there is no interval yet', () => {
    const result = accumulate({ totalWh: 0 }, 1_000_000, 3000, GAP)
    expect(result.addedWh).toBe(0)
    expect(result.state.lastWatts).toBe(3000)
  })

  it('charges an interval at the draw seen at its start', () => {
    // 3 kW for 5 minutes, then everything off
    const first = accumulate({ totalWh: 0 }, 0, 3000, GAP)
    const second = accumulate(first.state, 5 * 60_000, 0, GAP)
    expect(second.addedWh).toBeCloseTo(250, 6)
    // and nothing for the next interval, since the spa was off at its start
    const third = accumulate(second.state, 10 * 60_000, 0, GAP)
    expect(third.addedWh).toBe(0)
    expect(third.state.totalWh).toBeCloseTo(250, 6)
  })

  it('reaches the expected kWh over an hour of minute polls', () => {
    let state = { totalWh: 0 } as ReturnType<typeof accumulate>['state']
    for (let minute = 0; minute <= 60; minute += 1) {
      state = accumulate(state, minute * 60_000, 2800, GAP).state
    }
    expect(state.totalWh).toBeCloseTo(2800, 6)
  })

  it('does not count a gap too long to know what ran', () => {
    const first = accumulate({ totalWh: 100 }, 0, 6000, GAP)
    const second = accumulate(first.state, 2 * HOUR, 0, GAP)
    expect(second.addedWh).toBe(0)
    expect(second.skippedMs).toBe(2 * HOUR)
    expect(second.state.totalWh).toBe(100)
  })

  it('does not count time while the spa was offline', () => {
    const offline = accumulate({ totalWh: 0, lastSampleAt: 0, lastWatts: 3000 }, 60_000, undefined, GAP)
    expect(offline.addedWh).toBeCloseTo(50, 6)
    // the interval that started offline is unknown, so it adds nothing
    const back = accumulate(offline.state, 120_000, 3000, GAP)
    expect(back.addedWh).toBe(0)
  })

  it('never goes backwards when the clock does', () => {
    const result = accumulate({ totalWh: 10, lastSampleAt: 1_000_000, lastWatts: 3000 }, 500_000, 3000, GAP)
    expect(result.addedWh).toBe(0)
    expect(result.state.totalWh).toBe(10)
  })

  it('allows at least ten minutes between samples, or three polls when they are slower', () => {
    expect(maxGapFor(60)).toBe(10 * 60_000)
    expect(maxGapFor(600)).toBe(30 * 60_000)
  })
})

describe('keeping the totals across restarts', () => {
  const tempFile = () => join(mkdtempSync(join(tmpdir(), 'cms-energy-')), 'controlmyspa', 'energy.json')

  it('reads back what it saved', () => {
    const path = tempFile()
    new EnergyStore(path).set('spa-1', { totalWh: 1234.5, lastSampleAt: 99, lastWatts: 400 })
    expect(new EnergyStore(path).get('spa-1')).toEqual({ totalWh: 1234.5, lastSampleAt: 99, lastWatts: 400 })
  })

  it('starts a spa it has never seen at zero', () => {
    expect(new EnergyStore(tempFile()).get('unknown')).toEqual({ totalWh: 0 })
  })

  it('survives a damaged file, and says so', () => {
    const path = tempFile()
    new EnergyStore(path).set('spa-1', { totalWh: 5 })
    writeFileSync(path, '{ not json')
    const errors: string[] = []
    const store = new EnergyStore(path, message => void errors.push(message))
    expect(store.get('spa-1')).toEqual({ totalWh: 0 })
    expect(errors).toHaveLength(1)
  })

  it('drops an entry that cannot be a total', () => {
    const path = tempFile()
    new EnergyStore(path).set('ok', { totalWh: 5 })
    const saved = JSON.parse(readFileSync(path, 'utf-8'))
    saved.spas.bad = { totalWh: -3 }
    writeFileSync(path, JSON.stringify(saved))
    const store = new EnergyStore(path)
    expect(store.get('ok').totalWh).toBe(5)
    expect(store.get('bad')).toEqual({ totalWh: 0 })
  })
})
