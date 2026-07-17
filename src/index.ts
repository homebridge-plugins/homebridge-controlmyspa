/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * index.ts: @homebridge-plugins/homebridge-controlmyspa
 */

import type { API } from 'homebridge'

import { ControlMySpaPlatform } from './platform.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

// Register our platform with homebridge.
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ControlMySpaPlatform)
}
