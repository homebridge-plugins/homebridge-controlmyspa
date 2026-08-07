/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * spa.ts: @homebridge-plugins/homebridge-controlmyspa
 */

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge'

import type { ControlMySpaPlatform } from '../platform.js'
import type { CmsComponent, CmsDashboard, CmsSpaSummary, devicesConfig } from '../settings.js'

import { celsiusToFahrenheit, fahrenheitToCelsius, SPA_MAX_TEMP_C, SPA_MIN_TEMP_C } from '../settings.js'

// How long after a control command before re-polling: the api acknowledges
// commands immediately and the spa applies them over the following seconds
const COMMAND_SETTLE_MS = 6000

// The component types we can control, each becoming its own service
const CONTROLLABLE_TYPES = ['PUMP', 'BLOWER', 'LIGHT']

/**
 * One HomeKit accessory per spa: a heat-only thermostat for the water, a
 * switch per jet pump and blower, a light bulb per spa light, and an
 * optional lock for the physical control panel.
 */
export class SpaAccessory {
  private readonly thermostatService: Service
  private panelLockService?: Service
  private readonly componentServices = new Map<string, Service>()

  public readonly spaId: string
  public readonly displayName: string
  private dashboard: CmsDashboard = {}
  private settleTimer?: ReturnType<typeof setTimeout>
  private lastFaultMessage?: string

  constructor(
    private readonly platform: ControlMySpaPlatform,
    private readonly accessory: PlatformAccessory,
    spa: CmsSpaSummary,
    private readonly deviceConfig: devicesConfig,
  ) {
    this.spaId = spa._id
    this.displayName = accessory.displayName
    const { Characteristic, Service } = this.platform.hap

    // Accessory information
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Balboa Water Group')
      .setCharacteristic(Characteristic.Model, 'ControlMySpa')
      .setCharacteristic(Characteristic.SerialNumber, spa.serialNumber ?? spa._id)
      .setCharacteristic(Characteristic.FirmwareRevision, deviceConfig.firmware ?? this.platform.version ?? '1.0.0')

    // Water temperature: a heat-only thermostat. The heater mode on the spa
    // is READY (maintains the set temp) or REST (economy, heats only during
    // filter cycles) — mapped to HomeKit's HEAT and OFF
    this.thermostatService = this.accessory.getService(Service.Thermostat)
      ?? this.accessory.addService(Service.Thermostat, 'Spa Water', 'SpaWater')
    this.thermostatService.setCharacteristic(Characteristic.Name, 'Spa Water')

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.currentTemperature())

    this.thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: SPA_MIN_TEMP_C, maxValue: SPA_MAX_TEMP_C, minStep: 0.5 })
      .onGet(() => this.targetTemperature())
      .onSet(value => this.setTargetTemperature(value))

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({ validValues: [Characteristic.CurrentHeatingCoolingState.OFF, Characteristic.CurrentHeatingCoolingState.HEAT] })
      .onGet(() => this.heaterModeIsReady()
        ? Characteristic.CurrentHeatingCoolingState.HEAT
        : Characteristic.CurrentHeatingCoolingState.OFF)

    this.thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT] })
      .onGet(() => this.heaterModeIsReady()
        ? Characteristic.TargetHeatingCoolingState.HEAT
        : Characteristic.TargetHeatingCoolingState.OFF)
      .onSet(value => this.setHeaterMode(value))

    this.thermostatService
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.dashboard.isCelsius
        ? Characteristic.TemperatureDisplayUnits.CELSIUS
        : Characteristic.TemperatureDisplayUnits.FAHRENHEIT)

    // Panel lock (opt-in): lets you stop little fingers changing settings
    // on the spa-side panel
    if (deviceConfig.showPanelLock) {
      this.panelLockService = this.accessory.getService('Panel Lock')
        ?? this.accessory.addService(Service.LockMechanism, 'Panel Lock', 'PanelLock')
      this.panelLockService.setCharacteristic(Characteristic.Name, 'Panel Lock')
      this.panelLockService
        .getCharacteristic(Characteristic.LockCurrentState)
        .onGet(() => this.dashboard.isPanelLocked
          ? Characteristic.LockCurrentState.SECURED
          : Characteristic.LockCurrentState.UNSECURED)
      this.panelLockService
        .getCharacteristic(Characteristic.LockTargetState)
        .onGet(() => this.dashboard.isPanelLocked
          ? Characteristic.LockTargetState.SECURED
          : Characteristic.LockTargetState.UNSECURED)
        .onSet(value => this.setPanelLock(value))
    } else {
      const stalePanelLock = this.accessory.getService('Panel Lock')
      if (stalePanelLock) {
        this.accessory.removeService(stalePanelLock)
      }
    }

    this.buildComponentServices()
  }

  /**
   * Create a service per controllable component reported by the spa, and
   * remove services for components that are no longer reported
   */
  private buildComponentServices() {
    const { Service } = this.platform.hap
    const seenSubtypes = new Set<string>()

    for (const component of this.controllableComponents()) {
      const subtype = this.componentSubtype(component)
      seenSubtypes.add(subtype)
      if (this.componentServices.has(subtype)) {
        continue
      }

      const name = this.componentDisplayName(component)
      const serviceType = component.componentType === 'LIGHT' ? Service.Lightbulb : Service.Switch
      const service = this.accessory.getServiceById(serviceType, subtype)
        ?? this.accessory.addService(serviceType, name, subtype)
      service.setCharacteristic(this.platform.hap.Characteristic.Name, name)
      service
        .getCharacteristic(this.platform.hap.Characteristic.On)
        .onGet(() => this.componentIsOn(component.componentType, component.port))
        .onSet(value => this.setComponentState(component.componentType, component.port, value === true))
      this.componentServices.set(subtype, service)
    }

    // A dashboard that lists no controllable components at all is a partial
    // response far more often than it is a spa that has lost its pumps, blower
    // and light. Removing the services on the strength of it drops any scene or
    // automation that used them, and HomeKit does not put those back when the
    // services reappear on the next poll - so leave them alone.
    if (seenSubtypes.size === 0) {
      return
    }

    // Remove services for components the spa no longer reports
    for (const [subtype, service] of this.componentServices) {
      if (!seenSubtypes.has(subtype)) {
        this.accessory.removeService(service)
        this.componentServices.delete(subtype)
      }
    }
  }

  private controllableComponents(): CmsComponent[] {
    return (this.dashboard.components ?? [])
      .filter(component => CONTROLLABLE_TYPES.includes(component.componentType) && component.port !== undefined && component.port !== null)
  }

  private componentSubtype(component: CmsComponent): string {
    return `${component.componentType.toLowerCase()}-${component.port}`
  }

  private componentDisplayName(component: CmsComponent): string {
    const ofType = this.controllableComponents().filter(c => c.componentType === component.componentType)
    const base = { PUMP: 'Jets', BLOWER: 'Blower', LIGHT: 'Spa Light' }[component.componentType] ?? component.componentType
    // Only number the service when the spa has more than one of that type
    return ofType.length > 1 ? `${base} ${Number.parseInt(component.port!) + 1}` : base
  }

  private findComponent(componentType: string, port?: string | null): CmsComponent | undefined {
    return (this.dashboard.components ?? [])
      .find(component => component.componentType === componentType && component.port === port)
  }

  private componentIsOn(componentType: string, port?: string | null): boolean {
    const value = this.findComponent(componentType, port)?.value
    return value !== undefined && value !== null && value !== 'OFF'
  }

  private heaterModeIsReady(): boolean {
    return this.dashboard.heaterMode === 'READY'
  }

  private currentTemperature(): number {
    return fahrenheitToCelsius(this.dashboard.currentTemp)
      ?? this.targetTemperature()
  }

  private targetTemperature(): number {
    const target = fahrenheitToCelsius(this.dashboard.desiredTemp)
    if (target === undefined) {
      return SPA_MIN_TEMP_C
    }
    return Math.min(Math.max(target, SPA_MIN_TEMP_C), SPA_MAX_TEMP_C)
  }

  private async setTargetTemperature(value: CharacteristicValue) {
    const celsius = value as number
    const fahrenheit = celsiusToFahrenheit(celsius)
    try {
      await this.platform.client!.setDesiredTemp(this.spaId, fahrenheit)
      await this.platform.infoLog(`${this.accessory.displayName} setting water temperature to ${celsius}°C (${fahrenheit}°F)`)
      this.dashboard.desiredTemp = fahrenheit
      this.schedulePostCommandRefresh()
    } catch (e: any) {
      await this.platform.reportCloudFailure(`${this.accessory.displayName} failed to set water temperature`, e)
      throw new this.platform.hap.HapStatusError(this.platform.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  private async setHeaterMode(value: CharacteristicValue) {
    const { Characteristic } = this.platform.hap
    const wantReady = value === Characteristic.TargetHeatingCoolingState.HEAT

    // No short-circuit on the cached mode here. The cache is written optimistically
    // as soon as the api acknowledges, and the spa can be put back to REST at its
    // own panel between polls - so "the cache already says READY" is not evidence
    // the spa is heating. Skipping the send made a scheduled automation quietly do
    // nothing, with no log line to show for it. None of the other setters do this.
    try {
      await this.platform.client!.setHeaterMode(this.spaId, wantReady ? 'READY' : 'REST')
      await this.platform.infoLog(`${this.accessory.displayName} setting heater mode to ${wantReady ? 'READY' : 'REST'}`)
      this.dashboard.heaterMode = wantReady ? 'READY' : 'REST'
      this.schedulePostCommandRefresh()
    } catch (e: any) {
      await this.platform.errorLog(`${this.accessory.displayName} failed to change heater mode: ${e.message}`)
      throw new this.platform.hap.HapStatusError(this.platform.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  private async setComponentState(componentType: string, port: string | null | undefined, on: boolean) {
    const devicePort = port ?? '0'
    const apiType = ({ PUMP: 'jet', BLOWER: 'blower', LIGHT: 'light' } as const)[componentType] ?? 'jet'
    try {
      await this.platform.client!.setComponentState(this.spaId, apiType, devicePort, on)
      await this.platform.infoLog(`${this.accessory.displayName} setting ${componentType.toLowerCase()} ${devicePort} to ${on ? 'on' : 'off'}`)
      const component = this.findComponent(componentType, port)
      if (component) {
        component.value = on ? 'HIGH' : 'OFF'
      }
      this.schedulePostCommandRefresh()
    } catch (e: any) {
      await this.platform.reportCloudFailure(`${this.accessory.displayName} failed to set ${componentType.toLowerCase()} state`, e)
      throw new this.platform.hap.HapStatusError(this.platform.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  private async setPanelLock(value: CharacteristicValue) {
    const { Characteristic } = this.platform.hap
    const locked = value === Characteristic.LockTargetState.SECURED
    try {
      await this.platform.client!.setPanelLock(this.spaId, locked)
      await this.platform.infoLog(`${this.accessory.displayName} ${locked ? 'locking' : 'unlocking'} the spa panel`)
      this.dashboard.isPanelLocked = locked
      this.panelLockService?.updateCharacteristic(
        Characteristic.LockCurrentState,
        locked ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED,
      )
      this.schedulePostCommandRefresh()
    } catch (e: any) {
      await this.platform.reportCloudFailure(`${this.accessory.displayName} failed to set the panel lock`, e)
      throw new this.platform.hap.HapStatusError(this.platform.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  /**
   * The spa applies commands over a few seconds — re-poll once shortly
   * after a command so HomeKit shows the confirmed state
   */
  private schedulePostCommandRefresh() {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
    }
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined
      void this.platform.pollNow()
    }, COMMAND_SETTLE_MS)
  }

  /**
   * Called by the platform with fresh state from each poll — push every
   * value to HomeKit so tiles update without being asked
   */
  public updateFromDashboard(dashboard: CmsDashboard) {
    this.dashboard = dashboard
    const { Characteristic } = this.platform.hap

    // Surface a spa fault the first time it appears
    const fault = typeof dashboard.currentFaultMessage === 'string' ? dashboard.currentFaultMessage : undefined
    if (fault && fault !== this.lastFaultMessage) {
      void this.platform.warnLog(`${this.accessory.displayName} is reporting a fault: ${fault}`)
    }
    this.lastFaultMessage = fault

    if (dashboard.systemInfo?.controllerSoftwareVersion && !this.deviceConfig.firmware) {
      this.accessory.getService(this.platform.hap.Service.AccessoryInformation)!
        .updateCharacteristic(Characteristic.FirmwareRevision, dashboard.systemInfo.controllerSoftwareVersion)
    }

    // New components can appear if the spa configuration changes
    this.buildComponentServices()

    this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTemperature())
    this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, this.targetTemperature())
    this.thermostatService.updateCharacteristic(
      Characteristic.CurrentHeatingCoolingState,
      this.heaterModeIsReady() ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF,
    )
    this.thermostatService.updateCharacteristic(
      Characteristic.TargetHeatingCoolingState,
      this.heaterModeIsReady() ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF,
    )

    for (const component of this.controllableComponents()) {
      const service = this.componentServices.get(this.componentSubtype(component))
      service?.updateCharacteristic(Characteristic.On, this.componentIsOn(component.componentType, component.port))
    }

    if (this.panelLockService) {
      const locked = this.dashboard.isPanelLocked === true
      this.panelLockService.updateCharacteristic(
        Characteristic.LockCurrentState,
        locked ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED,
      )
      this.panelLockService.updateCharacteristic(
        Characteristic.LockTargetState,
        locked ? Characteristic.LockTargetState.SECURED : Characteristic.LockTargetState.UNSECURED,
      )
    }
  }
}
