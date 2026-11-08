import type { MatterAPI } from 'homebridge'

import type { EnergyState, EnergyStore } from '../energy.js'
import type { ControlMySpaPlatform } from '../platform.js'

import { describe, expect, it } from 'vitest'

import { DEFAULT_WATTS, maxGapFor } from '../energy.js'
import { versionAtLeast } from '../platform.js'
import { ENERGY_PART_ID, energyDisplayName, SpaEnergyAccessory, toMilliwattHours } from './spaEnergy.js'

const BRIDGED_NODE = { name: 'BridgedNode' }
const OUTLET = { name: 'OnOffOutlet' }

/** A stand-in for api.matter that records every state update */
function fakeMatter(options: { failFirstRegister?: boolean } = {}) {
  const updates: Array<{ cluster: string, attributes: any, partId?: string }> = []
  let registered = false
  let registerCalls = 0
  const matter = {
    uuid: {
      generate: (seed: string) => `uuid:${seed}`,
    },
    deviceTypes: { BridgedNode: BRIDGED_NODE, OnOffOutlet: OUTLET },
    registerPlatformAccessories: async () => {
      registerCalls += 1
      if (options.failFirstRegister && registerCalls === 1) {
        // the registration landed, but the call reports a failure - as a
        // duplicate-UUID refusal does after a retry
        registered = true
        throw new Error('Accessory already registered')
      }
      registered = true
    },
    unregisterPlatformAccessories: async () => {},
    updateAccessoryState: async (_uuid: string, cluster: string, attributes: any, partId?: string) => {
      updates.push({ cluster, attributes, partId })
    },
    getAccessoryState: async () => (registered
      ? { onOff: true }
      : undefined),
  } as unknown as MatterAPI
  return {
    matter,
    updates,
    registerCalls: () => registerCalls,
  }
}

function fakePlatform() {
  const logs: string[] = []
  const debug: string[] = []
  const log = async (m: string) => void logs.push(m)
  const platform = {
    version: '9.9.9',
    debugLog: async (m: string) => void debug.push(m),
    infoLog: log,
    warnLog: log,
  } as unknown as ControlMySpaPlatform
  return { platform, logs, debug }
}

/** An in-memory store, so tests do not touch the disk */
function memoryStore(initial: Record<string, EnergyState> = {}) {
  const states = { ...initial }
  const store = {
    get: (id: string) => states[id] ?? { totalWh: 0 },
    set: (id: string, state: EnergyState) => void (states[id] = state),
  } as unknown as EnergyStore
  return Object.assign(store, { saved: states })
}

function makeAccessory(store: ReturnType<typeof memoryStore> = memoryStore(), matterOptions = {}) {
  const { matter, updates, registerCalls } = fakeMatter(matterOptions)
  const { platform, logs, debug } = fakePlatform()
  const accessory = new SpaEnergyAccessory(
    platform,
    matter,
    { _id: 'spa123', serialNumber: 'SN-42' },
    'Hot Tub',
    DEFAULT_WATTS,
    store,
    maxGapFor(60),
  )
  return {
    accessory,
    updates,
    logs,
    debug,
    store,
    registerCalls,
  }
}

describe('the energy accessory Homebridge is given', () => {
  it('is a bridged node with one outlet part - the only type Apple Home shows wattage on', () => {
    const { accessory } = makeAccessory()
    const built = accessory.build()
    expect(built.deviceType).toBe(BRIDGED_NODE as any)
    expect(built.parts).toHaveLength(1)
    expect(built.parts![0].id).toBe(ENERGY_PART_ID)
    expect(built.parts![0].deviceType).toBe(OUTLET as any)
  })

  it('declares power and cumulative imported energy, so Homebridge adds the measurement clusters', () => {
    const { accessory } = makeAccessory(memoryStore({
      spa123: { totalWh: 1.5 },
    }))
    const clusters = accessory.build().parts![0].clusters as any
    expect(clusters.onOff).toEqual({ onOff: true })
    expect(clusters.electricalPowerMeasurement).toEqual({ activePower: null })
    expect(clusters.electricalEnergyMeasurement).toEqual({
      cumulativeEnergyImported: { energy: 1500 },
    })
  })

  it('has an identity apart from the HAP accessory', () => {
    const { accessory } = makeAccessory()
    expect(accessory.uuid).toBe('uuid:spa123:energy')
  })

  it('keeps its name within Matter\'s 32 characters', () => {
    expect(energyDisplayName('Hot Tub')).toBe('Hot Tub Energy')
    expect(energyDisplayName('The Really Rather Long Garden Hot Tub').length).toBeLessThanOrEqual(32)
  })

  it('carries energy in milliwatt-hours', () => {
    expect(toMilliwattHours(2.8)).toBe(2800)
  })
})

describe('publishing the estimate', () => {
  const busy = {
    isOnline: true,
    components: [
      { componentType: 'HEATER', port: '0', value: 'ON' },
    ],
  }
  const idle = {
    isOnline: true,
    components: [
      { componentType: 'HEATER', port: '0', value: 'OFF' },
    ],
  }

  it('registers, and brings a restored accessory up to date straight away', async () => {
    const { accessory, updates } = makeAccessory(memoryStore({
      spa123: { totalWh: 10 },
    }))
    expect(await accessory.register()).toBe(true)
    const energy = updates.find(u => u.cluster === 'electricalEnergyMeasurement')
    expect(energy?.attributes).toEqual({
      cumulativeEnergyImported: { energy: 10_000 },
    })
    expect(energy?.partId).toBe(ENERGY_PART_ID)
  })

  it('treats a refused retry of a registration that landed as registered', async () => {
    const { accessory, registerCalls } = makeAccessory(memoryStore(), { failFirstRegister: true })
    expect(await accessory.register()).toBe(true)
    expect(registerCalls()).toBe(1)
  })

  it('reports watts in milliwatts and adds up the kWh between polls', async () => {
    const { accessory, updates, store } = makeAccessory()
    await accessory.register()
    updates.length = 0

    // polls are tens of seconds apart, so each push lands before the next sample
    accessory.update(busy as any, 0)
    await accessory.flush()
    accessory.update(idle as any, 6 * 60_000)
    await accessory.flush()

    const power = updates.filter(u => u.cluster === 'electricalPowerMeasurement').map(u => u.attributes.activePower)
    expect(power).toEqual([2_800_000, 0])
    // 2800 W for six minutes
    expect(store.saved.spa123.totalWh).toBeCloseTo(280, 6)
    const energy = updates.filter(u => u.cluster === 'electricalEnergyMeasurement')
    expect(energy.at(-1)?.attributes).toEqual({
      cumulativeEnergyImported: { energy: 280_000 },
    })
  })

  it('only sends energy when the total has moved', async () => {
    const { accessory, updates } = makeAccessory()
    await accessory.register()
    updates.length = 0
    accessory.update(idle as any, 0)
    accessory.update(idle as any, 60_000)
    accessory.update(idle as any, 120_000)
    await accessory.flush()
    expect(updates.filter(u => u.cluster === 'electricalEnergyMeasurement')).toHaveLength(0)
  })

  it('shows the spa unreachable while it is offline, and counts no time for it', async () => {
    const { accessory, updates, store } = makeAccessory()
    await accessory.register()
    updates.length = 0
    accessory.update({ isOnline: false } as any, 0)
    await accessory.flush()
    accessory.update(busy as any, 60_000)
    await accessory.flush()
    const reach = updates.filter(u => u.cluster === 'bridgedDeviceBasicInformation').map(u => u.attributes.reachable)
    expect(reach).toEqual([false, true])
    expect(store.saved.spa123.totalWh).toBe(0)
  })

  it('says once that a spa without a heater component cannot have its heater counted', async () => {
    const { accessory, logs } = makeAccessory()
    const noHeater = {
      isOnline: true,
      components: [
        { componentType: 'PUMP', port: '0', value: 'HIGH' },
      ],
    }
    accessory.update(noHeater as any, 0)
    accessory.update(noHeater as any, 60_000)
    expect(logs.filter(l => l.includes('does not report its heater'))).toHaveLength(1)
  })
})

describe('the reading in the log', () => {
  const heating = {
    isOnline: true,
    components: [
      { componentType: 'HEATER', port: '0', value: 'ON' },
      { componentType: 'CIRCULATION_PUMP', port: null, value: 'HIGH' },
    ],
  }
  const resting = {
    isOnline: true,
    components: [
      { componentType: 'HEATER', port: '0', value: 'WAITING' },
      { componentType: 'CIRCULATION_PUMP', port: null, value: 'HIGH' },
    ],
  }

  it('gets a line each time it changes, and not when it stays the same', () => {
    const { accessory, logs, debug } = makeAccessory()
    accessory.update(resting as any, 0)
    accessory.update(resting as any, 60_000)
    accessory.update(heating as any, 120_000)
    const shown = logs.filter(l => l.startsWith('Hot Tub Energy '))
    expect(shown).toHaveLength(2)
    expect(shown[0]).toBe('Hot Tub Energy 400 W: circulation pump 400 (total 0.000 kWh)')
    // 400 W for the minute before the heater came on
    expect(shown[1]).toBe('Hot Tub Energy 3,200 W: heater 2,800 + circulation pump 400 (total 0.013 kWh)')
    // the unchanged middle reading went to the debug log instead
    expect(debug.filter(l => l.includes('400 W: circulation pump 400'))).toHaveLength(1)
  })
})

describe('two samples before either push has gone out', () => {
  it('publishes the latest state, so a spa back online is not left unreachable', async () => {
    const { accessory, updates } = makeAccessory()
    await accessory.register()
    updates.length = 0
    accessory.update({ isOnline: false } as any, 0)
    accessory.update({ isOnline: true, components: [] } as any, 1_000)
    await accessory.flush()
    const reach = updates.filter(u => u.cluster === 'bridgedDeviceBasicInformation').map(u => u.attributes.reachable)
    // it may be sent nothing at all (it never stopped being reachable as far as
    // the controller saw), but it must not end on false
    expect(reach.at(-1) ?? true).toBe(true)
  })
})

describe('the Homebridge version check', () => {
  it('accepts the minimum and anything later', () => {
    expect(versionAtLeast('2.3.0', '2.3.0')).toBe(true)
    expect(versionAtLeast('2.5.0', '2.3.0')).toBe(true)
    expect(versionAtLeast('3.0.0', '2.3.0')).toBe(true)
    expect(versionAtLeast('2.3.0-beta.4', '2.3.0')).toBe(true)
  })

  it('refuses anything earlier', () => {
    expect(versionAtLeast('2.2.1', '2.3.0')).toBe(false)
    expect(versionAtLeast('1.11.4', '2.3.0')).toBe(false)
    expect(versionAtLeast(undefined, '2.3.0')).toBe(false)
  })
})
