import type { HistoryEntry } from './history.js'

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildReport, historyFile, historyIndexFile, HistoryRecorder, laneLabels, readHistory } from './history.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const GAP = 10 * MIN

const storage = () => mkdtempSync(join(tmpdir(), 'cms-history-'))

function dash(pump: string, heater = 'OFF', temp = '100.0') {
  return {
    isOnline: true,
    currentTemp: temp,
    desiredTemp: '102',
    components: [
      { componentType: 'HEATER', port: '0', value: heater },
      { componentType: 'PUMP', port: '0', value: pump },
      { componentType: 'FILTER', port: '0', value: 'OFF' },
      { componentType: 'GATEWAY', port: null, value: null },
    ],
  }
}

describe('recording the history', () => {
  it('writes a reading each refresh and an event only when something changes', () => {
    const dir = storage()
    const recorder = new HistoryRecorder(dir, 'spa1', 'Spa Pool')
    recorder.record(dash('OFF') as any, 400, 0)
    recorder.record(dash('OFF') as any, 400, MIN)
    recorder.record(dash('HIGH') as any, 2600, 2 * MIN)
    const entries = readHistory(historyFile(dir, 'spa1'))
    const events = entries.filter((e: any) => e.k)
    // the first refresh records every tracked component, then only the jets changing
    expect(events.map((e: any) => `${e.k}=${e.v}`)).toEqual([
      'HEATER:0=OFF',
      'PUMP:0=OFF',
      'FILTER:0=OFF',
      'PUMP:0=HIGH',
    ])
    expect(entries.filter((e: any) => !e.k)).toHaveLength(3)
    expect(entries[0]).toEqual({ t: 0, temp: 100, set: 102, w: 400 })
  })

  it('keeps the spa name for the dashboard\'s picker', () => {
    const dir = storage()
    void new HistoryRecorder(dir, 'spa1', 'Spa Pool')
    expect(JSON.parse(readFileSync(historyIndexFile(dir), 'utf-8')).spas.spa1.name).toBe('Spa Pool')
  })

  it('notes when the spa was offline, with no reading', () => {
    const dir = storage()
    new HistoryRecorder(dir, 'spa1', 'Spa').record({ isOnline: false } as any, undefined, 0)
    expect(readHistory(historyFile(dir, 'spa1'))).toEqual([
      { t: 0, off: 1 },
    ])
  })

  it('skips a line cut short, rather than losing the file', () => {
    const dir = storage()
    new HistoryRecorder(dir, 'spa1', 'Spa').record(dash('OFF') as any, 0, 0)
    writeFileSync(historyFile(dir, 'spa1'), `${readFileSync(historyFile(dir, 'spa1'), 'utf-8')}{"t":12,"te`)
    expect(readHistory(historyFile(dir, 'spa1')).length).toBeGreaterThanOrEqual(1)
  })

  it('trims entries past 30 days, keeping each component\'s last state', () => {
    const dir = storage()
    const recorder = new HistoryRecorder(dir, 'spa1', 'Spa')
    recorder.record(dash('HIGH') as any, 2200, 0)
    recorder.record(dash('HIGH') as any, 2200, 31 * DAY)
    const entries = readHistory(historyFile(dir, 'spa1'))
    // the old reading is gone; the jets' HIGH carries forward to the cut
    expect(entries.some(e => e.t === 0)).toBe(false)
    expect(entries.some((e: any) => e.k === 'PUMP:0' && e.v === 'HIGH')).toBe(true)
  })

  it('makes a spa id safe to use in a file name', () => {
    expect(historyFile('/x', '../../etc/passwd')).toBe('/x/controlmyspa/history-______etc_passwd.jsonl')
  })
})

describe('the dashboard report', () => {
  const now = 10 * DAY
  // jets on for 30 minutes, heater on for the hour after, water rising
  const entries: HistoryEntry[] = []
  for (let m = 0; m <= 120; m += 1) {
    const t = now - 120 * MIN + m * MIN
    const jets = m < 30
    const heater = m >= 30 && m < 90
    entries.push({
      t,
      temp: 98 + m / 60,
      set: 102,
      w: (jets ? 2200 : 0) + (heater ? 2800 : 0) + 400,
    })
    if (m === 0) {
      entries.push({ t, k: 'PUMP:0', v: 'HIGH' }, { t, k: 'HEATER:0', v: 'OFF' }, { t, k: 'FILTER:0', v: 'OFF' })
    }
    if (m === 30) {
      entries.push({ t, k: 'PUMP:0', v: 'OFF' }, { t, k: 'HEATER:0', v: 'ON' })
    }
    if (m === 90) {
      entries.push({ t, k: 'HEATER:0', v: 'WAITING' })
    }
  }
  const report = buildReport(entries, { hours: 24, maxGapMs: GAP, now })

  it('adds up the energy at full resolution', () => {
    // 0.5 h x 2.2 kW + 1 h x 2.8 kW + 2 h x 0.4 kW
    expect(report.totalKWh).toBeCloseTo(1.1 + 2.8 + 0.8, 2)
    const hourly = report.energy.reduce((sum, b) => sum + b.kWh, 0)
    expect(hourly).toBeCloseTo(report.totalKWh, 2)
    expect(report.bucket).toBe('hour')
  })

  it('draws each component\'s runs, with WAITING counted as off', () => {
    const jets = report.lanes.find(l => l.key === 'PUMP:0')!
    const heater = report.lanes.find(l => l.key === 'HEATER:0')!
    expect(jets.label).toBe('Jets')
    expect(jets.onMs).toBe(30 * MIN)
    expect(heater.onMs).toBe(60 * MIN)
    expect(report.lanes.find(l => l.key === 'FILTER:0')!.segments).toHaveLength(0)
  })

  it('lists the changes newest first, without the first readings as changes', () => {
    expect(report.changes.map(c => `${c.label} ${c.from}>${c.to}`)).toEqual([
      'Heater ON>WAITING',
      'Heater OFF>ON',
      'Jets HIGH>OFF',
    ])
  })

  it('does not count a restart repeating a state as a change', () => {
    const repeated = [
      ...entries,
      { t: now - MIN, k: 'PUMP:0', v: 'OFF' },
    ]
    expect(buildReport(repeated, { hours: 24, maxGapMs: GAP, now }).changes).toHaveLength(3)
  })

  it('shows the latest reading, in the spa\'s own unit', () => {
    expect(report.unit).toBe('F')
    expect(report.latest?.temp).toBe(100)
    const celsius = buildReport([
      {
        t: now,
        temp: 104,
        set: 104,
        w: 0,
        c: 1,
      },
    ], { hours: 24, maxGapMs: GAP, now })
    expect(celsius.unit).toBe('C')
    expect(celsius.latest?.temp).toBe(40)
  })

  it('leaves a gap where there are no readings, rather than drawing through it', () => {
    expect(report.points.filter(p => p.temp === null).length).toBeGreaterThan(0)
    expect(report.points.filter(p => p.temp !== null).length).toBeGreaterThan(0)
  })

  it('does not count energy across a long gap', () => {
    const gapped: HistoryEntry[] = [
      { t: now - 5 * HOUR, w: 3000 },
      { t: now - HOUR, w: 0 },
      { t: now, w: 0 },
    ]
    expect(buildReport(gapped, { hours: 24, maxGapMs: GAP, now }).totalKWh).toBe(0)
  })

  it('splits energy per day at the viewer\'s midnight', () => {
    // 2 kW from 23:00 to 01:00 in a zone 10 hours ahead of UTC
    const offset = 600
    const midnightLocal = 5 * DAY - offset * MIN
    const run: HistoryEntry[] = []
    for (let m = -60; m <= 60; m += 1) {
      run.push({
        t: midnightLocal + m * MIN,
        w: m < 60
          ? 2000
          : 0,
      })
    }
    const week = buildReport(run, {
      hours: 168,
      maxGapMs: GAP,
      tzOffsetMinutes: offset,
      now: 6 * DAY,
    })
    expect(week.bucket).toBe('day')
    const days = week.energy.filter(b => b.kWh > 0)
    expect(days).toHaveLength(2)
    expect(days[0].kWh).toBeCloseTo(2, 2)
    expect(days[1].kWh).toBeCloseTo(2, 2)
  })

  it('is empty for a spa with no readings', () => {
    expect(buildReport([], { hours: 24, maxGapMs: GAP, now }).empty).toBe(true)
  })
})

describe('the names on the timeline', () => {
  it('numbers a kind only when there is more than one of it', () => {
    const labels = laneLabels([
      'PUMP:0',
      'PUMP:1',
      'BLOWER:0',
      'CIRCULATION_PUMP:',
      'FILTER:0',
      'FILTER:1',
    ])
    expect(labels.get('PUMP:0')).toBe('Jets 1')
    expect(labels.get('PUMP:1')).toBe('Jets 2')
    expect(labels.get('BLOWER:0')).toBe('Blower')
    expect(labels.get('CIRCULATION_PUMP:')).toBe('Circulation pump')
    expect(labels.get('FILTER:1')).toBe('Filter cycle 2')
  })
})
