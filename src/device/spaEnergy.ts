/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * spaEnergy.ts: @homebridge-plugins/homebridge-controlmyspa
 */

import type { MatterAccessory, MatterAPI } from 'homebridge'

import type { EnergyState, EnergyStore, EnergyWatts } from '../energy.js'
import type { ControlMySpaPlatform } from '../platform.js'
import type { CmsDashboard, CmsSpaSummary } from '../settings.js'

import { accumulate, describeEstimate, estimatePower } from '../energy.js'
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings.js'

// The one endpoint under the bridged node. Never rename it: it is part of the
// accessory's identity in Apple Home.
export const ENERGY_PART_ID = 'energy'

// Matter's NodeLabel holds 32 characters; a longer name fails the registration
const MATTER_LABEL_MAX = 32

// Registration can be refused or dropped while the bridge's Matter server is
// still starting, so it is retried for a while before giving up
const REGISTER_ATTEMPTS = 10
const REGISTER_RETRY_MS = 10_000
const VERIFY_ATTEMPTS = 5
const VERIFY_INTERVAL_MS = 1_000

// How long after a tap on the tile before the switch is put back on
const KEEP_ON_DELAY_MS = 1_000

/**
 * The identity seed for a spa's energy accessory. Kept apart from the HAP
 * accessory's seed (the bare spa id) so the two can never collide.
 * @param spaId - the spa's ControlMySpa id
 */
export function energySeedFor(spaId: string): string {
  return `${spaId}:energy`
}

/**
 * The accessory's name, cut to what Matter will accept.
 * @param spaName - the spa's display name
 */
export function energyDisplayName(spaName: string): string {
  const name = `${spaName} Energy`
  return name.length > MATTER_LABEL_MAX
    ? name.slice(0, MATTER_LABEL_MAX).trimEnd()
    : name
}

/**
 * Watt-hours to the milliwatt-hours Matter carries, as a whole number.
 * @param wh - energy in watt-hours
 */
export function toMilliwattHours(wh: number): number {
  return Math.round(wh * 1000)
}

/**
 * A spa's estimated power and energy, published over Matter as an outlet.
 *
 * Apple Home only shows live wattage on outlet-type accessories, so the spa
 * appears as a plug whose tile reads the estimated draw, and whose usage is
 * added to the Home's Energy totals. It switches nothing: the spa is
 * controlled through the existing HomeKit accessory, and a tap on this tile
 * is put back to on.
 *
 * Shaped like the accessories in homebridge-shelly-matter - a bridged node with
 * the outlet as its one part - since that is the shape Apple Home is known to
 * handle well behind a Homebridge Matter bridge.
 */
export class SpaEnergyAccessory {
  public readonly uuid: string
  public readonly spaId: string
  public readonly displayName: string

  private state: EnergyState
  private currentWatts: number | null = null
  private reachable = true
  private registered = false
  private stopped = false
  private heaterNoteLogged = false
  // The last breakdown written to the log, so an unchanged reading is not
  // repeated every refresh
  private lastLoggedReading?: string
  private lastPushed: { mw?: number | null, mwh?: number, reachable?: boolean } = {}
  private keepOnTimer?: ReturnType<typeof setTimeout>
  // Pushes run one after another: each compares against what the last one
  // sent, so two in flight at once could both skip a change (a spa coming back
  // online straight after going offline would stay "No Response")
  private pushQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly platform: ControlMySpaPlatform,
    private readonly matter: MatterAPI,
    private readonly spa: CmsSpaSummary,
    spaName: string,
    private readonly watts: EnergyWatts,
    private readonly store: EnergyStore,
    private readonly maxGapMs: number,
  ) {
    this.spaId = spa._id
    this.uuid = matter.uuid.generate(energySeedFor(spa._id))
    this.displayName = energyDisplayName(spaName)
    this.state = store.get(spa._id)
  }

  /**
   * The accessory as handed to Homebridge. Its structure must never change
   * between releases: Apple Home corrupts the record of an accessory that
   * comes back under the same identity with a different shape.
   */
  build(): MatterAccessory {
    const keepOn = () => this.scheduleKeepOn()
    return {
      UUID: this.uuid,
      displayName: this.displayName,
      deviceType: this.matter.deviceTypes.BridgedNode,
      manufacturer: 'Balboa Water Group',
      model: 'ControlMySpa Energy Estimate',
      serialNumber: `${this.spa.serialNumber ?? this.spa._id}-E`.slice(0, MATTER_LABEL_MAX),
      firmwareRevision: this.platform.version ?? '1.0.0',
      context: { spaId: this.spa._id },
      parts: [
        {
          id: ENERGY_PART_ID,
          displayName: this.displayName,
          deviceType: this.matter.deviceTypes.OnOffOutlet,
          clusters: {
            onOff: { onOff: true },
            electricalPowerMeasurement: {
              activePower: this.currentWatts === null
                ? null
                : this.currentWatts * 1000,
            },
            electricalEnergyMeasurement: {
              cumulativeEnergyImported: {
                energy: toMilliwattHours(this.state.totalWh),
              },
            },
          },
          handlers: {
            onOff: { on: keepOn, off: keepOn, toggle: keepOn },
          },
        },
      ],
    }
  }

  /**
   * Register with the bridge, retrying while its Matter server comes up, and
   * confirm the registration took by reading state back - an early
   * registration can resolve without having happened.
   */
  async register(): Promise<boolean> {
    for (let attempt = 1; attempt <= REGISTER_ATTEMPTS && !this.stopped; attempt += 1) {
      try {
        await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          this.build(),
        ])
      } catch (e: any) {
        // A retry after a registration that did land is refused as a duplicate -
        // the check below is what tells the two apart
        await this.platform.debugLog(`${this.displayName} Matter registration attempt ${attempt} failed: ${e?.message ?? e}`)
      }
      if (await this.isRegistered()) {
        this.registered = true
        await this.platform.infoLog(`${this.displayName} is published over Matter with estimated power and energy`)
        // A restored accessory keeps its cached state, so bring it up to date now
        await this.queuePush(true)
        return true
      }
      if (attempt < REGISTER_ATTEMPTS) {
        await sleep(REGISTER_RETRY_MS)
      }
    }
    if (!this.stopped) {
      await this.platform.warnLog(`${this.displayName} could not be published over Matter - the bridge's Matter server did not become ready`)
    }
    return false
  }

  private async isRegistered(): Promise<boolean> {
    for (let check = 0; check < VERIFY_ATTEMPTS && !this.stopped; check += 1) {
      try {
        if (await this.matter.getAccessoryState(this.uuid, 'onOff', ENERGY_PART_ID) !== undefined) {
          return true
        }
      } catch {
        // not there yet
      }
      await sleep(VERIFY_INTERVAL_MS)
    }
    return false
  }

  /**
   * Take a sample from a fresh dashboard: add the energy used since the last
   * one, save the total, and publish the new figures.
   * @param dashboard - the spa's live state
   * @param now - when it was fetched
   */
  update(dashboard: CmsDashboard, now: number = Date.now()): void {
    const online = dashboard.isOnline !== false
    const estimate = online
      ? estimatePower(dashboard.components, this.watts)
      : undefined

    if (estimate && !estimate.heaterReported && !this.heaterNoteLogged) {
      this.heaterNoteLogged = true
      void this.platform.infoLog(`${this.displayName}: this spa does not report its heater to ControlMySpa, so the energy estimate cannot include it`)
    }

    const result = accumulate(this.state, now, estimate?.watts, this.maxGapMs)
    if (result.skippedMs !== undefined) {
      void this.platform.debugLog(`${this.displayName}: ${Math.round(result.skippedMs / 60000)} minute(s) since the last reading is too long to estimate, so that time is not counted`)
    }
    this.state = result.state
    this.store.set(this.spaId, this.state)
    this.currentWatts = estimate?.watts ?? null
    this.reachable = online

    // Each new reading gets a line showing what it is made of; the same
    // reading again only goes to the debug log
    const reading = estimate
      ? describeEstimate(estimate)
      : 'unknown, the spa is offline'
    const total = `total ${(this.state.totalWh / 1000).toFixed(3)} kWh`
    if (reading !== this.lastLoggedReading) {
      this.lastLoggedReading = reading
      void this.platform.infoLog(`${this.displayName} ${reading} (${total})`)
    } else {
      void this.platform.debugLog(`${this.displayName} ${reading} (${total})`)
    }
    void this.queuePush(false)
  }

  /** Resolves once every queued Matter update has been sent */
  flush(): Promise<void> {
    return this.pushQueue
  }

  private queuePush(force: boolean): Promise<void> {
    this.pushQueue = this.pushQueue.then(() => this.push(force))
    return this.pushQueue
  }

  /**
   * Publish whatever has changed. Energy updates go to every controller
   * unthrottled, so each is only sent when the total has actually moved.
   * @param force - send everything, as after a (re)registration
   */
  private async push(force: boolean): Promise<void> {
    if (!this.registered || this.stopped) {
      return
    }
    const mw = this.currentWatts === null
      ? null
      : Math.round(this.currentWatts * 1000)
    const mwh = toMilliwattHours(this.state.totalWh)
    try {
      if (force || this.lastPushed.reachable !== this.reachable) {
        await this.matter.updateAccessoryState(this.uuid, 'bridgedDeviceBasicInformation', { reachable: this.reachable })
        this.lastPushed.reachable = this.reachable
      }
      if (force || this.lastPushed.mw !== mw) {
        await this.matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', { activePower: mw }, ENERGY_PART_ID)
        this.lastPushed.mw = mw
      }
      if (force || this.lastPushed.mwh !== mwh) {
        await this.matter.updateAccessoryState(this.uuid, 'electricalEnergyMeasurement', {
          cumulativeEnergyImported: { energy: mwh },
        }, ENERGY_PART_ID)
        this.lastPushed.mwh = mwh
      }
      if (force) {
        await this.matter.updateAccessoryState(this.uuid, 'onOff', { onOff: true }, ENERGY_PART_ID)
      }
    } catch (e: any) {
      await this.platform.debugLog(`${this.displayName} failed to update its Matter state: ${e?.message ?? e}`)
    }
  }

  /**
   * The tile switches nothing, so whatever a controller sends, it goes back
   * to on. Done after the handler returns, since Homebridge applies the
   * requested state once the handler completes.
   */
  private scheduleKeepOn(): void {
    if (this.keepOnTimer) {
      clearTimeout(this.keepOnTimer)
    }
    this.keepOnTimer = setTimeout(() => {
      this.keepOnTimer = undefined
      if (this.stopped) {
        return
      }
      this.matter.updateAccessoryState(this.uuid, 'onOff', { onOff: true }, ENERGY_PART_ID)
        .catch(e => void this.platform.debugLog(`${this.displayName} could not reset its switch: ${e?.message ?? e}`))
    }, KEEP_ON_DELAY_MS)
  }

  shutdown(): void {
    this.stopped = true
    if (this.keepOnTimer) {
      clearTimeout(this.keepOnTimer)
      this.keepOnTimer = undefined
    }
  }
}

function sleep(ms: number): Promise<void> {
  // unref'd so a registration still retrying cannot hold Homebridge open at shutdown
  return new Promise(resolve => setTimeout(resolve, ms).unref?.())
}
