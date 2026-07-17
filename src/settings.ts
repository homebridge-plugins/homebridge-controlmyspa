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
 * The ControlMySpa cloud endpoints. The idm endpoint hands out the mobile
 * client credentials and the token/whoami urls, so only the base is fixed.
 */
export const CMS_BASE_URL = 'https://iot.controlmyspa.com'
export const CMS_IDM_URL = `${CMS_BASE_URL}/idm/tokenEndpoint`
export const CMS_SPAS_URL = `${CMS_BASE_URL}/spas`
export const CMS_CONTROL_URL = `${CMS_BASE_URL}/mobile/control`

/**
 * The api reports temperatures in degrees fahrenheit; HomeKit works in
 * degrees celsius. Balboa spas top out at 104°F (40°C).
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
export interface CmsIdmResponse {
  mobileClientId: string
  mobileClientSecret: string
  _links: {
    tokenEndpoint: { href: string }
    refreshEndpoint: { href: string }
    whoami: { href: string }
  }
}

export interface CmsTokenData {
  access_token: string
  token_type?: string
  refresh_token?: string
  expires_in: number
  timestamp: number
}

export interface CmsComponent {
  componentType: string
  port?: string
  value?: string
  availableValues?: string[]
  name?: string
  materialType?: string
}

export interface CmsSpaState {
  desiredTemp?: string
  targetDesiredTemp?: string
  currentTemp?: string
  heaterMode?: string
  panelLock?: boolean
  online?: boolean
  components?: CmsComponent[]
  controllerType?: string
  runMode?: string
  celsius?: boolean
}

export interface CmsSpa {
  _id: string
  serialNumber?: string
  productName?: string
  model?: string
  dealerId?: string
  online?: boolean
  currentState?: CmsSpaState
}

/**
 * Convert an api fahrenheit reading to celsius, rounded to one decimal
 * place (HomeKit's display resolution). The api sends temps as strings.
 */
export function fahrenheitToCelsius(value: string | number | undefined): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value
  if (parsed === undefined || Number.isNaN(parsed)) {
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
