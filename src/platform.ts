/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * platform.ts: @homebridge-plugins/homebridge-controlmyspa
 */

import type { API, DynamicPlatformPlugin, HAP, Logging, MatterAccessory, PlatformAccessory } from 'homebridge'

import type { CmsSpaSummary, ControlMySpaPlatformConfig, devicesConfig, options } from './settings.js'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { URL } from 'node:url'

import { ControlMySpaClient } from './controlmyspa.js'
import { SpaAccessory } from './device/spa.js'
import { SpaEnergyAccessory } from './device/spaEnergy.js'
import { EnergyStore, estimatePower, maxGapFor, resolveWatts } from './energy.js'
import { HistoryRecorder } from './history.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

// The first Homebridge with the composed-accessory Matter fixes energy
// reporting depends on (electrical clusters arrived in 2.2.0, but on 2.2.x
// Apple Home stops responding to bridged Matter accessories after pairing)
export const MINIMUM_MATTER_ENERGY_VERSION = '2.3.0'

/**
 * Whether a Homebridge version is at least `minimum`. Pre-release tags
 * (2.3.0-beta.1) count as that release.
 * @param version - the running Homebridge version
 * @param minimum - the version required
 */
export function versionAtLeast(version: string | undefined, minimum: string): boolean {
  const parse = (v: string) => v.split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0)
  if (!version) {
    return false
  }
  const have = parse(version)
  const need = parse(minimum)
  for (let i = 0; i < Math.max(have.length, need.length); i += 1) {
    const a = have[i] ?? 0
    const b = need[i] ?? 0
    if (a !== b) {
      return a > b
    }
  }
  return true
}

const DEFAULT_REFRESH_RATE = 60
const MINIMUM_REFRESH_RATE = 30
// A Node timer holds its delay in a signed 32-bit integer, so anything over
// 2147483647 ms is not an error - it quietly becomes 1 ms. Left unchecked, a
// refreshRate past this point would poll the ControlMySpa cloud a thousand
// times a second rather than once every few weeks.
const MAXIMUM_REFRESH_RATE = 2073600

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class ControlMySpaPlatform implements DynamicPlatformPlugin {
  public accessories: PlatformAccessory[]
  public readonly api: API
  public readonly log: Logging
  public readonly hap: HAP
  public config!: ControlMySpaPlatformConfig

  public client?: ControlMySpaClient
  platformLogging!: options['logging']
  refreshRate!: number
  version: any

  private readonly spaHandlers = new Map<string, SpaAccessory>()
  // Energy accessories (Matter), keyed by spa id
  private readonly energyHandlers = new Map<string, SpaEnergyAccessory>()
  private readonly matterAccessories: MatterAccessory[] = []
  // History for the settings page dashboard, keyed by spa id
  private readonly historyRecorders = new Map<string, HistoryRecorder>()
  private pollTimer?: ReturnType<typeof setInterval>
  private pollInFlight = false
  // Set while the cloud is failing to answer, so a run of identical failures is
  // announced once rather than on every poll and every button press
  private cloudOutage?: { since: number, suppressed: number }

  constructor(
    log: Logging,
    config: ControlMySpaPlatformConfig,
    api: API,
  ) {
    this.accessories = []
    this.api = api
    this.hap = this.api.hap
    this.log = log
    // only load if configured
    if (!config) {
      return
    }

    // Plugin options into our config variables.
    this.config = {
      platform: PLATFORM_NAME,
      name: config.name,
      credentials: config.credentials,
      options: config.options,
    }

    this.getPlatformLogSettings()
    this.getPlatformRateSettings()
    this.getVersion()

    this.debugLog(`Finished initializing platform: ${config.name}`)

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      this.debugLog('Executed didFinishLaunching callback')
      try {
        this.verifyConfig()
        this.debugLog('Config OK')
      } catch (e: any) {
        this.errorLog(`Verify Config, Error Message: ${e.message}`)
        return
      }
      try {
        await this.discoverDevices()
        this.startPolling()
      } catch (e: any) {
        await this.reportCloudFailure('Failed to Discover Spas', e)
        this.debugErrorLog(`Failed to Discover Spas, Error: ${e}`)
      }
    })

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer)
      }
      this.spaHandlers.forEach(handler => handler.shutdown())
      this.energyHandlers.forEach(handler => handler.shutdown())
    })
  }

  /**
   * This function is invoked when homebridge restores cached Matter accessories
   * (the energy outlets) from disk at startup.
   */
  configureMatterAccessory(accessory: MatterAccessory) {
    this.debugLog(`Loading Matter accessory from cache: ${accessory.displayName}`)
    this.matterAccessories.push(accessory)
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.debugLog(`Loading accessory from cache: ${accessory.displayName}`)
    this.accessories.push(accessory)
  }

  /**
   * Verify the config passed to the plugin is valid
   */
  verifyConfig() {
    if (!this.config.credentials?.email) {
      throw new Error('Email not provided in the plugin config')
    }
    if (!this.config.credentials?.password) {
      throw new Error('Password not provided in the plugin config')
    }
  }

  /**
   * Discover the account's spas and register them with Homebridge
   */
  async discoverDevices() {
    this.client = new ControlMySpaClient(
      this.config.credentials!.email!,
      this.config.credentials!.password!,
      {
        debug: message => void this.debugLog(message),
        warn: message => void this.warnLog(message),
      },
    )

    const spas = await this.client.getSpas()
    this.debugLog(`Found ${spas.length} spa(s) on the account`)

    if (!spas.length) {
      // An empty list is not proof that the account has no spas. The client
      // hands back an empty list for any 200 response whose body it could not
      // read - a maintenance page, or a change in the response shape. Sweeping
      // the cached accessories on the strength of that would take the owner's
      // room assignments, scenes and automations with it, and a later restart
      // would only bring the spa back as a brand new accessory.
      this.warnLog('No spas were found on this ControlMySpa account, so the existing accessories have been left alone')
      return
    }

    const configuredUUIDs: string[] = []
    for (const spa of spas) {
      this.infoLog(`Found spa: ${spa.alias ?? 'unnamed'}, SpaID: ${spa._id}`)
      const uuid = this.api.hap.uuid.generate(spa._id)
      configuredUUIDs.push(uuid)
      await this.createSpa(spa, uuid)
    }

    this.removeStaleAccessories(configuredUUIDs)

    await this.setupEnergy(spas)
    this.setupHistory(spas)

    // Fetch each spa's live state straight away rather than waiting for
    // the first poll interval
    await this.pollNow()
  }

  private deviceConfigFor(spa: CmsSpaSummary): devicesConfig {
    return this.config.options?.devices?.find(device => device.spaId === spa._id) ?? {}
  }

  private spaDisplayName(spa: CmsSpaSummary, deviceConfig: devicesConfig): string {
    return deviceConfig.configDeviceName
      ?? spa.alias
      ?? `Spa ${spa._id.slice(-4)}`
  }

  private async createSpa(spa: CmsSpaSummary, uuid: string) {
    const deviceConfig = this.deviceConfigFor(spa)
    const displayName = this.spaDisplayName(spa, deviceConfig)

    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid)

    if (deviceConfig.hide_device) {
      if (existingAccessory) {
        this.unregisterPlatformAccessories(existingAccessory)
      }
      this.infoLog(`Spa: ${displayName} will not display in HomeKit, hide_device: true`)
      return
    }

    if (existingAccessory) {
      existingAccessory.context.device = spa
      existingAccessory.displayName = displayName
      this.infoLog(`Restoring existing accessory from cache: ${displayName}, SpaID: ${spa._id}`)
      this.api.updatePlatformAccessories([existingAccessory])
      this.spaHandlers.set(uuid, new SpaAccessory(this, existingAccessory, spa, deviceConfig))
    } else {
      const accessory = new this.api.platformAccessory(displayName, uuid)
      accessory.context.device = spa
      this.infoLog(`Adding new accessory: ${displayName}, SpaID: ${spa._id}`)
      this.spaHandlers.set(uuid, new SpaAccessory(this, accessory, spa, deviceConfig))
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.accessories.push(accessory)
    }
  }

  /**
   * Start recording each spa's history for the dashboard on the settings page,
   * unless the owner has turned it off
   */
  private setupHistory(spas: CmsSpaSummary[]) {
    if (this.config.options?.recordHistory === false) {
      return
    }
    for (const spa of spas) {
      const deviceConfig = this.deviceConfigFor(spa)
      if (deviceConfig.hide_device) {
        continue
      }
      this.historyRecorders.set(spa._id, new HistoryRecorder(
        this.api.user.storagePath(),
        spa._id,
        this.spaDisplayName(spa, deviceConfig),
        message => void this.warnLog(message),
      ))
    }
  }

  /**
   * Publish an estimated-energy outlet over Matter for each spa, when it is
   * turned on and the bridge can carry it, and remove any cached energy
   * outlet that is no longer wanted.
   *
   * Registration runs in the background: it can take a while for the bridge's
   * Matter server to be ready, and the HomeKit accessories should not wait on
   * it. Samples taken meanwhile are counted all the same.
   */
  private async setupEnergy(spas: CmsSpaSummary[]) {
    const energy = this.config.options?.energy
    const matter = this.api.matter
    const wanted = new Set<string>()

    if (energy?.enabled) {
      if (!matter || !this.api.isMatterEnabled?.()) {
        await this.warnLog('Energy reporting is turned on, but Matter is not enabled on the bridge this plugin runs on. '
          + 'In the Homebridge UI, open this plugin\'s bridge settings, turn on "Enable Matter", then pair the bridge\'s Matter code with Apple Home.')
      } else if (!versionAtLeast(this.api.serverVersion, MINIMUM_MATTER_ENERGY_VERSION)) {
        await this.warnLog(`Energy reporting needs Homebridge ${MINIMUM_MATTER_ENERGY_VERSION} or later (this is ${this.api.serverVersion}), so it has been left off`)
      } else {
        const store = new EnergyStore(
          join(this.api.user.storagePath(), 'controlmyspa', 'energy.json'),
          message => void this.warnLog(message),
        )
        const watts = resolveWatts(energy)
        await this.debugLog(`Energy estimate wattages: ${JSON.stringify(watts)}`)
        for (const spa of spas) {
          const deviceConfig = this.deviceConfigFor(spa)
          if (deviceConfig.hide_device || deviceConfig.hideEnergy) {
            continue
          }
          const handler = new SpaEnergyAccessory(
            this,
            matter,
            spa,
            this.spaDisplayName(spa, deviceConfig),
            watts,
            store,
            maxGapFor(this.refreshRate),
          )
          wanted.add(handler.uuid)
          this.energyHandlers.set(spa._id, handler)
          void handler.register()
        }
      }
    }

    // A cached energy outlet that is no longer wanted - reporting turned off, or
    // its spa hidden or gone from the account
    if (matter) {
      for (const cached of [...this.matterAccessories]) {
        if (wanted.has(cached.UUID)) {
          continue
        }
        try {
          await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached])
          this.matterAccessories.splice(this.matterAccessories.indexOf(cached), 1)
          await this.warnLog(`Removing energy accessory from cache: ${cached.displayName}`)
        } catch (e: any) {
          await this.debugErrorLog(`Failed to remove energy accessory ${cached.displayName}: ${e?.message ?? e}`)
        }
      }
    }
  }

  /**
   * Unregister cached accessories for spas that no longer exist on the account
   */
  private removeStaleAccessories(configuredUUIDs: string[]) {
    for (const accessory of [...this.accessories]) {
      if (!configuredUUIDs.includes(accessory.UUID)) {
        this.unregisterPlatformAccessories(accessory)
      }
    }
  }

  public unregisterPlatformAccessories(existingAccessory: PlatformAccessory) {
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory])
    const index = this.accessories.indexOf(existingAccessory)
    if (index > -1) {
      this.accessories.splice(index, 1)
    }
    this.warnLog(`Removing existing accessory from cache: ${existingAccessory.displayName}`)
  }

  /**
   * Poll the cloud for spa state on the configured interval and push the
   * fresh state to each accessory
   */
  private startPolling() {
    this.pollTimer = setInterval(() => void this.pollNow(), this.refreshRate * 1000)
    this.debugLog(`Polling the ControlMySpa cloud every ${this.refreshRate} seconds`)
  }

  /**
   * Fetch the latest spa state and dispatch it. Also called shortly after a
   * control command is sent, since the spa applies commands asynchronously.
   */
  public async pollNow(): Promise<void> {
    if (this.pollInFlight || !this.client) {
      return
    }
    this.pollInFlight = true
    try {
      for (const handler of this.spaHandlers.values()) {
        try {
          const dashboard = await this.client.getDashboard(handler.spaId)
          handler.updateFromDashboard(dashboard)
          this.energyHandlers.get(handler.spaId)?.update(dashboard)
          // The same estimate as the energy outlet, whether or not that is turned on
          this.historyRecorders.get(handler.spaId)?.record(
            dashboard,
            dashboard.isOnline === false
              ? undefined
              : estimatePower(dashboard.components, resolveWatts(this.config.options?.energy)).watts,
          )
          await this.noteCloudReachable()
        } catch (e: any) {
          await this.reportCloudFailure(`Failed to refresh state for ${handler.displayName}`, e)
        }
      }
    } finally {
      this.pollInFlight = false
    }
  }

  /**
   * Whether an error means the ControlMySpa cloud is simply not answering,
   * rather than something specific being wrong with the request. A timeout and
   * a 5xx are both the server's problem and both clear up on their own; a 4xx
   * is about this request and is always worth reporting.
   */
  private static isCloudUnreachable(e: any): boolean {
    const message = String(e?.message ?? '')
    return /timed out after \d+ seconds/.test(message) || /failed with status 5\d\d/.test(message)
  }

  /**
   * Report a failed cloud call.
   *
   * An outage lasts hours and the plugin retries every refresh interval, so
   * reporting each failure fills the log with the same line - one report of a
   * real outage ran to 147 of them. The first is announced and the rest are
   * kept to the debug log until the cloud answers again.
   */
  public async reportCloudFailure(context: string, e: any): Promise<void> {
    const message = `${context}: ${e?.message ?? e}`
    if (!ControlMySpaPlatform.isCloudUnreachable(e)) {
      await this.errorLog(message)
      return
    }
    if (this.cloudOutage) {
      this.cloudOutage.suppressed += 1
      await this.debugLog(message)
      return
    }
    this.cloudOutage = { since: Date.now(), suppressed: 0 }
    await this.warnLog(`${message}. The ControlMySpa cloud is not responding, which is at their end rather than yours - this will not be repeated until it is back.`)
  }

  /**
   * Note that a cloud call succeeded, ending any outage that was in progress.
   */
  public async noteCloudReachable(): Promise<void> {
    if (!this.cloudOutage) {
      return
    }
    const { since, suppressed } = this.cloudOutage
    this.cloudOutage = undefined
    const minutes = Math.max(1, Math.round((Date.now() - since) / 60000))
    const alsoHidden = suppressed > 0 ? `, hiding ${suppressed} more of the same` : ''
    await this.successLog(`The ControlMySpa cloud is responding again after ${minutes} minute(s)${alsoHidden}`)
  }

  async getPlatformLogSettings() {
    // `debugMode` was worked out here by looking for `-D` in the plugin's own
    // process arguments. That is right in the main Homebridge process and wrong
    // in a child bridge, which only receives `-D` when that bridge has its own
    // debug setting turned on - so with debug enabled globally the plugin
    // decided debug was off and printed nothing.
    //
    // Nothing needs deciding: 'debugMode' routes debug lines to Homebridge's
    // own debug logger, which prints them only when debug is actually on, in
    // either kind of process. An explicit `logging` in the config still wins.
    this.platformLogging = (this.config.options?.logging === 'debug' || this.config.options?.logging === 'standard'
      || this.config.options?.logging === 'none')
      ? this.config.options.logging
      : 'debugMode'
    // 'default' (what the config UI saves) is not one of the three above, so it
    // lands on 'debugMode' exactly as an empty or missing value does.
    const logging = this.config.options?.logging && this.config.options.logging !== 'default' ? 'Platform Config' : 'Default'
    await this.debugLog(`Using ${logging} Logging: ${this.platformLogging}`)
  }

  async getPlatformRateSettings() {
    const configured = this.config.options?.refreshRate
    this.refreshRate = typeof configured === 'number' && configured >= MINIMUM_REFRESH_RATE && configured <= MAXIMUM_REFRESH_RATE
      ? configured
      : DEFAULT_REFRESH_RATE
    if (typeof configured === 'number' && configured < MINIMUM_REFRESH_RATE) {
      await this.warnLog(`Configured refreshRate of ${configured}s is below the minimum of ${MINIMUM_REFRESH_RATE}s, using ${DEFAULT_REFRESH_RATE}s`)
    }
    if (typeof configured === 'number' && configured > MAXIMUM_REFRESH_RATE) {
      await this.warnLog(`Configured refreshRate of ${configured}s is above the maximum of ${MAXIMUM_REFRESH_RATE}s, using ${DEFAULT_REFRESH_RATE}s`)
    }
  }

  /**
   * Asynchronously retrieves the version of the plugin from the package.json file.
   */
  async getVersion(): Promise<void> {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
    this.debugLog(`Plugin Version: ${version}`)
    this.version = version
  }

  /**
   * If device level logging is turned on, log to log.warn
   * Otherwise send debug logs to log.debug
   */
  async infoLog(...log: any[]): Promise<void> {
    if (await this.enablingPlatformLogging()) {
      this.log.info(String(...log))
    }
  }

  async successLog(...log: any[]): Promise<void> {
    if (await this.enablingPlatformLogging()) {
      this.log.success(String(...log))
    }
  }

  async warnLog(...log: any[]): Promise<void> {
    if (await this.enablingPlatformLogging()) {
      this.log.warn(String(...log))
    }
  }

  async errorLog(...log: any[]): Promise<void> {
    if (await this.enablingPlatformLogging()) {
      this.log.error(String(...log))
    }
  }

  async debugErrorLog(...log: any[]): Promise<void> {
    if (await this.enablingPlatformLogging()) {
      if (this.platformLogging === 'debugMode') {
        this.log.debug(String(...log))
      } else if (this.platformLogging === 'debug') {
        this.log.error('[DEBUG]', String(...log))
      }
    }
  }

  async debugLog(...log: any[]): Promise<void> {
    if (await this.enablingPlatformLogging()) {
      if (this.platformLogging === 'debugMode') {
        this.log.debug(String(...log))
      } else if (this.platformLogging === 'debug') {
        this.log.info('[DEBUG]', String(...log))
      }
    }
  }

  /**
   * ⚠️ True in a normal install, because 'debugMode' means "let Homebridge
   * decide" rather than "debug is on". Only ever gate 'log.debug' on this.
   *
   * Gating 'log.warn', 'log.error' or 'log.success' on it prints those lines to
   * everyone, since Homebridge shows those levels whatever its debug setting -
   * which is exactly what happened to three of the helpers above (#243).
   */
  async loggingIsDebug(): Promise<boolean> {
    return this.platformLogging === 'debugMode' || this.platformLogging === 'debug'
  }

  async enablingPlatformLogging(): Promise<boolean> {
    return this.platformLogging === 'debugMode' || this.platformLogging === 'debug' || this.platformLogging === 'standard'
  }
}
