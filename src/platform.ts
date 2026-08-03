/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * platform.ts: @homebridge-plugins/homebridge-controlmyspa
 */

import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory } from 'homebridge'

import type { CmsSpaSummary, ControlMySpaPlatformConfig, devicesConfig, options } from './settings.js'

import { readFileSync } from 'node:fs'
import { argv } from 'node:process'
import { URL } from 'node:url'

import { ControlMySpaClient } from './controlmyspa.js'
import { SpaAccessory } from './device/spa.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

const DEFAULT_REFRESH_RATE = 60
const MINIMUM_REFRESH_RATE = 30

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
  debugMode!: boolean
  version: any

  private readonly spaHandlers = new Map<string, SpaAccessory>()
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
    })
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
      this.warnLog('No spas were found on this ControlMySpa account')
    }

    const configuredUUIDs: string[] = []
    for (const spa of spas) {
      this.infoLog(`Found spa: ${spa.alias ?? 'unnamed'}, SpaID: ${spa._id}`)
      const uuid = this.api.hap.uuid.generate(spa._id)
      configuredUUIDs.push(uuid)
      await this.createSpa(spa, uuid)
    }

    this.removeStaleAccessories(configuredUUIDs)

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
    this.debugMode = argv.includes('-D') ?? argv.includes('--debug')
    this.platformLogging = (this.config.options?.logging === 'debug' || this.config.options?.logging === 'standard'
      || this.config.options?.logging === 'none')
      ? this.config.options.logging
      : this.debugMode ? 'debugMode' : 'standard'
    const logging = this.config.options?.logging ? 'Platform Config' : this.debugMode ? 'debugMode' : 'Default'
    await this.debugLog(`Using ${logging} Logging: ${this.platformLogging}`)
  }

  async getPlatformRateSettings() {
    const configured = this.config.options?.refreshRate
    this.refreshRate = typeof configured === 'number' && configured >= MINIMUM_REFRESH_RATE
      ? configured
      : DEFAULT_REFRESH_RATE
    if (typeof configured === 'number' && configured < MINIMUM_REFRESH_RATE) {
      await this.warnLog(`Configured refreshRate of ${configured}s is below the minimum of ${MINIMUM_REFRESH_RATE}s, using ${DEFAULT_REFRESH_RATE}s`)
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
      if (await this.loggingIsDebug()) {
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

  async loggingIsDebug(): Promise<boolean> {
    return this.platformLogging === 'debugMode' || this.platformLogging === 'debug'
  }

  async enablingPlatformLogging(): Promise<boolean> {
    return this.platformLogging === 'debugMode' || this.platformLogging === 'debug' || this.platformLogging === 'standard'
  }
}
