/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * settings.ts: @homebridge-plugins/homebridge-controlmyspa
 */

import type { PlatformConfig } from 'homebridge'

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'ControlMySpa'

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = '@homebridge-plugins/homebridge-controlmyspa'

/**
 * The ControlMySpa cloud base url
 */
export const CMS_BASE_URL = 'https://iot.controlmyspa.com'

/**
 * The api sends and receives temperatures in degrees fahrenheit — the
 * dashboard's isCelsius flag only describes the spa's own display unit.
 * HomeKit works in degrees celsius. Balboa spas top out at 104°F (40°C).
 */
export const SPA_MIN_TEMP_C = 10
export const SPA_MAX_TEMP_C = 40

// Config
export interface ControlMySpaPlatformConfig extends PlatformConfig {
  credentials?: credentials
  options?: options
}

export interface credentials {
  email?: string
  password?: string
}

export interface options {
  devices?: devicesConfig[]
  refreshRate?: number
  logging?: string
}

export interface devicesConfig {
  spaId?: string
  configDeviceName?: string
  hide_device?: boolean
  showPanelLock?: boolean
  firmware?: string
  refreshRate?: number
  logging?: string
}

// API types
export interface CmsTokenData {
  access_token: string
  expires_in: number
  timestamp: number
}

/**
 * An entry from GET /spas/owned
 */
export interface CmsSpaSummary {
  _id: string
  alias?: string
  serialNumber?: string
  isDefault?: boolean
}

export interface CmsComponent {
  componentType: string
  name?: string
  port?: string | null
  value?: string | null
  availableValues?: string[]
  materialType?: string | null
}

/**
 * The live state from GET /spas/{id}/dashboard (the `data` object)
 */
export interface CmsDashboard {
  currentTemp?: number | string | null
  desiredTemp?: number | string | null
  isCelsius?: boolean
  isPanelLocked?: boolean
  isOnline?: boolean
  heaterMode?: string
  tempRange?: string
  rangeLimits?: {
    highRangeLow?: number
    highRangeHigh?: number
    lowRangeLow?: number
    lowRangeHigh?: number
  }
  components?: CmsComponent[]
  serialNumber?: string
  systemInfo?: {
    controllerSoftwareVersion?: string
  }
  currentFaultMessage?: unknown
  totalAlerts?: number
}

/**
 * Convert an api fahrenheit reading to celsius, rounded to one decimal
 * place (HomeKit's display resolution). A zero reading means "no reading"
 * on this api and returns undefined.
 */
export function fahrenheitToCelsius(value: string | number | null | undefined): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value ?? undefined
  if (parsed === undefined || Number.isNaN(parsed) || parsed === 0) {
    return undefined
  }
  return Math.round(((parsed - 32) * 5 / 9) * 10) / 10
}

/**
 * Convert a celsius target from HomeKit back to the fahrenheit value the
 * api expects, rounded to the nearest half degree fahrenheit.
 */
export function celsiusToFahrenheit(value: number): number {
  return Math.round(((value * 9 / 5) + 32) * 2) / 2
}
