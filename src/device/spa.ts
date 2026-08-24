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

// How long to wait for the other half of a paired Active + RotationSpeed
// write before sending one command for both - see queueFanWrite
const FAN_WRITE_COALESCE_MS = 50

/**
 * Whether a component gets the two-speed fan treatment: it reports a LOW
 * state of its own (#7 - an owner's pumps report OFF/LOW/HIGH, and one was
 * sitting at LOW). A light never does, whatever it reports.
 * @param component - the dashboard component entry
 */
export function isTwoSpeedComponent(component: CmsComponent): boolean {
  return component.componentType !== 'LIGHT' && (component.availableValues ?? []).includes('LOW')
}

/**
 * The single state to send for a batch of fan writes. HomeKit sends "turn on
 * at half speed" as two writes, Active and RotationSpeed, and their handlers
 * run concurrently - sending a command for each would race, with the spa
 * keeping whichever landed last. One command carries the combined intent.
 *
 * An Active-on with no speed alongside it means the tile was toggled - full
 * speed, which is what the owner asked the toggle to mean (#7).
 * @param write - the parts that arrived within the window
 * @param write.active - the Active write, when one arrived
 * @param write.speed - the RotationSpeed write, when one arrived
 */
export function fanWriteTarget(write: { active?: boolean, speed?: number }): 'OFF' | 'LOW' | 'HIGH' {
  if (write.active === false) {
    return 'OFF'
  }
  if (write.speed !== undefined) {
    if (write.speed <= 0) {
      return 'OFF'
    }
    return write.speed <= 50 ? 'LOW' : 'HIGH'
  }
  return 'HIGH'
}

// The pause between consecutive commands to the same component. The owner's
// suggestion (#7): the pump is real machinery mid-spin, and rapid state
// flips short-cycle it - give each state a few seconds to take.
export const TRANSITION_STEP_DELAY_MS = 4000

// The spa's control cycle. Its button only advances: off -> low -> high -> off
const PUMP_CYCLE: Array<'OFF' | 'LOW' | 'HIGH'> = ['OFF', 'LOW', 'HIGH']

/**
 * The next single command to send to move a two-speed pump toward `target`,
 * or null when it is already there.
 *
 * Round three of #7 established that the cloud moves the pump AT MOST ONE
 * step around its cycle per command, whatever state the command names:
 * asking for HIGH from OFF landed on LOW, and asking for OFF from LOW landed
 * on HIGH. So every transition is walked one cycle-step at a time, each
 * command naming the very state that step reaches - which is also the only
 * thing the hardware can do, so nothing is asked of it that it cannot honour.
 * @param current - the state the pump is reported at now
 * @param target - the state the write is aiming for
 */
export function nextStepToward(current: string | null | undefined, target: 'OFF' | 'LOW' | 'HIGH'): 'OFF' | 'LOW' | 'HIGH' | null {
  if (current === target) {
    return null
  }
  const position = PUMP_CYCLE.indexOf(current as 'OFF' | 'LOW' | 'HIGH')
  if (position === -1) {
    // Where the pump is now is unknown - send the target and let the poll sort it out
    return target
  }
  return PUMP_CYCLE[(position + 1) % PUMP_CYCLE.length]
}

/**
 * What a reported component value means for the fan characteristics. The
 * speed is null for OFF so the slider keeps its last position, the way
 * HomeKit fans conventionally behave.
 * @param value - the component's reported value
 */
export function fanStateForValue(value: string | null | undefined): { active: boolean, speed: number | null } {
  if (value === 'LOW') {
    return { active: true, speed: 50 }
  }
  if (value !== undefined && value !== null && value !== 'OFF') {
    return { active: true, speed: 100 }
  }
  return { active: false, speed: null }
}

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
  private componentCapabilitiesLogged = false
  private readonly pendingFanWrites = new Map<string, {
    write: { active?: boolean, speed?: number }
    promise: Promise<void>
    resolve: () => void
    reject: (reason: unknown) => void
  }>()

  /** One paced driver per two-speed component - see walkToState */
  private readonly pumpDrivers = new Map<string, {
    target: 'OFF' | 'LOW' | 'HIGH'
    lastSentAt: number
    timer: ReturnType<typeof setTimeout> | null
    waiters: Array<{ resolve: () => void, reject: (reason: unknown) => void }>
  }>()

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
      const twoSpeed = isTwoSpeedComponent(component)
      const serviceType = component.componentType === 'LIGHT'
        ? Service.Lightbulb
        : twoSpeed ? Service.Fanv2 : Service.Switch

      // A pump can change shape between restarts (the fan treatment arrived in
      // an update, or a config change at the spa) - drop the old service so
      // the accessory does not carry a dead tile alongside the live one
      const staleType = serviceType === Service.Fanv2 ? Service.Switch : Service.Fanv2
      const stale = this.accessory.getServiceById(staleType, subtype)
      if (stale && component.componentType !== 'LIGHT') {
        this.accessory.removeService(stale)
      }

      const service = this.accessory.getServiceById(serviceType, subtype)
        ?? this.accessory.addService(serviceType, name, subtype)
      service.setCharacteristic(this.platform.hap.Characteristic.Name, name)

      if (twoSpeed) {
        const { Characteristic } = this.platform.hap
        service
          .getCharacteristic(Characteristic.Active)
          .onGet(() => this.componentIsOn(component.componentType, component.port)
            ? Characteristic.Active.ACTIVE
            : Characteristic.Active.INACTIVE)
          .onSet(value => this.queueFanWrite(component, { active: value === Characteristic.Active.ACTIVE }))
        service
          .getCharacteristic(Characteristic.RotationSpeed)
          .setProps({ minValue: 0, maxValue: 100, minStep: 50 })
          .onGet(() => fanStateForValue(this.findComponent(component.componentType, component.port)?.value).speed ?? 0)
          .onSet(value => this.queueFanWrite(component, { speed: value as number }))
      } else {
        service
          .getCharacteristic(this.platform.hap.Characteristic.On)
          .onGet(() => this.componentIsOn(component.componentType, component.port))
          .onSet(value => this.setComponentState(component.componentType, component.port, value === true ? 'HIGH' : 'OFF'))
      }
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

  /**
   * Say once, in the debug log, what the spa reports for each controllable
   * component - name, current value, and every value it says it accepts.
   *
   * This exists for #7: an owner's two-speed pumps needed pressing twice to
   * reach full speed, which suggests the api knows more states than the
   * OFF/HIGH this plugin sends. Whether that is true is written in
   * `availableValues`, which nothing surfaced - so the question could not be
   * answered from any log an owner could produce.
   */
  private logComponentCapabilitiesOnce() {
    if (this.componentCapabilitiesLogged) {
      return
    }
    const components = this.controllableComponents()
    if (components.length === 0) {
      // A partial dashboard - keep waiting for one that lists them
      return
    }
    this.componentCapabilitiesLogged = true
    for (const component of components) {
      const available = component.availableValues?.length ? component.availableValues.join('/') : 'not reported'
      void this.platform.debugLog(
        `${this.accessory.displayName} component ${this.componentDisplayName(component)}`
        + ` (${component.componentType.toLowerCase()} port ${component.port})`
        + ` value [${component.value ?? 'none'}] accepts [${available}]`,
      )
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

  /**
   * Drive a two-speed component toward `target`, one cycle-step per command,
   * never faster than one command per few seconds - see nextStepToward for
   * the one-step rule and TRANSITION_STEP_DELAY_MS for the pacing.
   *
   * A newer write simply replaces the target: the driver keeps walking from
   * wherever the pump is, at the same pace. That pacing is also what fixed
   * the round-three mystery of one pump obeying and the other not - the Home
   * app can deliver Active and RotationSpeed as separate writes far enough
   * apart to miss the coalescing window, and the second one used to cancel
   * the first's follow-up step and fire immediately, machine-gunning the
   * pump with commands fractions of a second apart.
   *
   * The returned promise settles with the first command this intent causes,
   * so HomeKit gets a prompt answer; later steps run on behind.
   * @param component - the component being written
   * @param subtype - its service subtype, the driver key
   * @param target - the state the user asked for
   */
  private walkToState(component: CmsComponent, subtype: string, target: 'OFF' | 'LOW' | 'HIGH'): Promise<void> {
    let driver = this.pumpDrivers.get(subtype)
    if (!driver) {
      driver = { target, lastSentAt: 0, timer: null, waiters: [] }
      this.pumpDrivers.set(subtype, driver)
    }
    driver.target = target

    const promise = new Promise<void>((resolve, reject) => {
      driver!.waiters.push({ resolve, reject })
    })

    if (!driver.timer) {
      const wait = Math.max(0, driver.lastSentAt + TRANSITION_STEP_DELAY_MS - Date.now())
      this.scheduleDriverStep(component, subtype, wait)
    }
    return promise
  }

  private scheduleDriverStep(component: CmsComponent, subtype: string, wait: number): void {
    const driver = this.pumpDrivers.get(subtype)
    if (!driver) {
      return
    }
    driver.timer = setTimeout(() => {
      driver.timer = null
      void (async () => {
        const current = this.findComponent(component.componentType, component.port)?.value
        const step = nextStepToward(current, driver.target)
        const waiters = driver.waiters
        driver.waiters = []
        if (step === null) {
          waiters.forEach(waiter => waiter.resolve())
          return
        }
        if (step !== driver.target) {
          void this.platform.infoLog(
            `${this.accessory.displayName} stepping ${this.componentDisplayName(component)} to `
            + `${step.toLowerCase()} on the way to ${driver.target.toLowerCase()} - the spa moves one step at a time`,
          )
        }
        driver.lastSentAt = Date.now()
        try {
          await this.setComponentState(component.componentType, component.port, step)
          waiters.forEach(waiter => waiter.resolve())
        } catch (e) {
          waiters.forEach(waiter => waiter.reject(e))
          return
        }
        if (this.findComponent(component.componentType, component.port)?.value !== driver.target) {
          this.scheduleDriverStep(component, subtype, TRANSITION_STEP_DELAY_MS)
        }
      })()
    }, wait)
  }

  private async setComponentState(componentType: string, port: string | null | undefined, state: 'OFF' | 'LOW' | 'HIGH') {
    const devicePort = port ?? '0'
    const apiType = ({ PUMP: 'jet', BLOWER: 'blower', LIGHT: 'light' } as const)[componentType] ?? 'jet'
    try {
      await this.platform.client!.setComponentState(this.spaId, apiType, devicePort, state)
      await this.platform.infoLog(`${this.accessory.displayName} setting ${componentType.toLowerCase()} ${devicePort} to ${state.toLowerCase()}`)
      const component = this.findComponent(componentType, port)
      if (component) {
        component.value = state
      }
      this.schedulePostCommandRefresh()
    } catch (e: any) {
      await this.platform.reportCloudFailure(`${this.accessory.displayName} failed to set ${componentType.toLowerCase()} state`, e)
      throw new this.platform.hap.HapStatusError(this.platform.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  /**
   * Collect the Active and RotationSpeed halves of a fan write and send one
   * command for both - see fanWriteTarget for why they cannot be sent
   * separately. Each caller's promise settles when the single command does,
   * so HomeKit sees both writes succeed or fail together.
   * @param component - the two-speed component being written
   * @param patch - the half that just arrived
   * @param patch.active - the Active write, when this is one
   * @param patch.speed - the RotationSpeed write, when this is one
   */
  private queueFanWrite(component: CmsComponent, patch: { active?: boolean, speed?: number }): Promise<void> {
    const subtype = this.componentSubtype(component)
    let pending = this.pendingFanWrites.get(subtype)
    if (!pending) {
      let resolve!: () => void
      let reject!: (reason: unknown) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      pending = { write: {}, promise, resolve, reject }
      this.pendingFanWrites.set(subtype, pending)
      setTimeout(() => {
        this.pendingFanWrites.delete(subtype)
        this.walkToState(component, subtype, fanWriteTarget(pending!.write))
          .then(pending!.resolve, pending!.reject)
      }, FAN_WRITE_COALESCE_MS)
    }
    Object.assign(pending.write, patch)
    return pending.promise
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
  /**
   * Cancel anything this spa has pending, so a settle poll cannot start a fresh
   * request against the cloud while Homebridge is shutting down - and cannot
   * hold the process open long enough to be killed rather than exit cleanly
   */
  public shutdown() {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = undefined
    }
  }

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

    this.logComponentCapabilitiesOnce()

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
      if (!service) {
        continue
      }
      if (isTwoSpeedComponent(component)) {
        const { active, speed } = fanStateForValue(component.value)
        service.updateCharacteristic(Characteristic.Active, active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)
        if (speed !== null) {
          service.updateCharacteristic(Characteristic.RotationSpeed, speed)
        }
      } else {
        service.updateCharacteristic(Characteristic.On, this.componentIsOn(component.componentType, component.port))
      }
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
