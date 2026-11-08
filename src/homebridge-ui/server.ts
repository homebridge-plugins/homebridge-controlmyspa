/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * server.ts: @homebridge-plugins/homebridge-controlmyspa
 */
import fs from 'node:fs'

import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils'

import { maxGapFor } from '../energy.js'
import { buildReport, historyFile, historyIndexFile, readHistory } from '../history.js'

// The windows the dashboard offers, in hours - anything else is refused
const ALLOWED_HOURS = [24, 24 * 7, 24 * 30]

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super()
    /*
      A native method getCachedAccessories() was introduced in config-ui-x v4.37.0
      The following is for users who have a lower version of config-ui-x
    */
    this.onRequest('getCachedAccessories', () => {
      try {
        const plugin = '@homebridge-plugins/homebridge-controlmyspa'
        const devicesToReturn = []

        // The path and file of the cached accessories
        const accFile = `${this.homebridgeStoragePath}/accessories/cachedAccessories`

        // Check the file exists
        if (fs.existsSync(accFile)) {
          // read the cached accessories file
          const cachedAccessories: any[] = JSON.parse(fs.readFileSync(accFile, 'utf8'))

          cachedAccessories.forEach((accessory: any) => {
            // Check the accessory is from this plugin
            if (accessory.plugin === plugin) {
              // Add the cached accessory to the array
              devicesToReturn.push(accessory.accessory as never)
            }
          })
        }
        // Return the array
        return devicesToReturn
      } catch {
        // Just return an empty accessory list in case of any errors
        return []
      }
    })

    /*
      The spas the plugin has recorded history for, for the dashboard's picker
    */
    this.onRequest('getHistorySpas', () => {
      try {
        const path = historyIndexFile(this.homebridgeStoragePath!)
        if (!fs.existsSync(path)) {
          return []
        }
        const index = JSON.parse(fs.readFileSync(path, 'utf8'))
        return Object.entries(index?.spas ?? {}).map(([id, value]: [string, any]) => ({
          id,
          name: String(value?.name ?? id),
        }))
      } catch {
        return []
      }
    })

    /*
      One spa's history over a window, already reduced to what the dashboard draws
    */
    this.onRequest('getHistory', (payload: any) => {
      const spaId = String(payload?.spaId ?? '')
      const hours = ALLOWED_HOURS.includes(Number(payload?.hours))
        ? Number(payload.hours)
        : 24
      const refreshRate = Number(payload?.refreshRate) > 0
        ? Number(payload.refreshRate)
        : 60
      const tzOffsetMinutes = Number.isFinite(Number(payload?.tzOffsetMinutes))
        ? Number(payload.tzOffsetMinutes)
        : 0
      const entries = spaId
        ? readHistory(historyFile(this.homebridgeStoragePath!, spaId))
        : []
      return buildReport(entries, {
        hours,
        tzOffsetMinutes,
        maxGapMs: maxGapFor(refreshRate),
        points: 300,
      })
    })

    this.ready()
  }
}

function startPluginUiServer(): PluginUiServer {
  return new PluginUiServer()
}

startPluginUiServer()
