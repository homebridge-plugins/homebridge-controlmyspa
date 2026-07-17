/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * controlmyspa.ts: @homebridge-plugins/homebridge-controlmyspa
 */

import type { RequestOptions } from 'node:https'

import type { CmsIdmResponse, CmsSpa, CmsTokenData } from './settings.js'

import { Buffer } from 'node:buffer'
import { request as httpsRequest } from 'node:https'
import { URL, URLSearchParams } from 'node:url'

import { CMS_CONTROL_URL, CMS_IDM_URL, CMS_SPAS_URL } from './settings.js'

const REQUEST_TIMEOUT_MS = 30000

// The api expects the official app's user agent on control calls
const USER_AGENT = 'ControlMySpa/3.0.2 (com.controlmyspa.qa; build:1; iOS 14.2.0) Alamofire/5.2.2'

export interface CmsLogger {
  debug: (message: string) => void
  warn: (message: string) => void
}

/**
 * A self-contained client for the ControlMySpa cloud api. The flow mirrors
 * the official mobile app: fetch the idm document for the oauth client
 * credentials and endpoint urls, log in with the user's email and password,
 * then read and control spas with the bearer token. Tokens are refreshed by
 * logging in again shortly before they expire.
 */
export class ControlMySpaClient {
  private tokenData?: CmsTokenData
  private tokenEndpoint?: string
  private whoamiEndpoint?: string
  private mobileClientId?: string
  private mobileClientSecret?: string
  private inflightLogin?: Promise<void>

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly log: CmsLogger,
  ) {}

  private isLoggedIn(): boolean {
    if (!this.tokenData) {
      return false
    }
    // Treat the token as expired a minute early so an in-flight request
    // never crosses the boundary with a stale token
    return this.tokenData.timestamp + ((this.tokenData.expires_in - 60) * 1000) > Date.now()
  }

  /**
   * Fetch the idm document: oauth client credentials + endpoint urls
   */
  private async fetchIdm(): Promise<void> {
    const { body, statusCode } = await this.requestJson(CMS_IDM_URL, { method: 'GET' })
    if (statusCode !== 200) {
      throw new Error(`idm endpoint returned status ${statusCode}`)
    }
    const idm = body as CmsIdmResponse
    this.mobileClientId = idm.mobileClientId
    this.mobileClientSecret = idm.mobileClientSecret
    this.tokenEndpoint = idm._links?.tokenEndpoint?.href
    this.whoamiEndpoint = idm._links?.whoami?.href
    if (!this.tokenEndpoint || !this.mobileClientId || !this.mobileClientSecret) {
      throw new Error('idm endpoint response was missing the token endpoint or client credentials')
    }
  }

  /**
   * Log in with the user's email and password. Concurrent callers share a
   * single login request.
   */
  private async login(): Promise<void> {
    if (this.inflightLogin) {
      return this.inflightLogin
    }
    this.inflightLogin = (async () => {
      if (!this.tokenEndpoint) {
        await this.fetchIdm()
      }
      const formData = new URLSearchParams({ username: this.email, password: this.password }).toString()
      const basicAuth = Buffer.from(`${this.mobileClientId}:${this.mobileClientSecret}`).toString('base64')
      const { body, statusCode } = await this.requestJson(this.tokenEndpoint!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(formData),
          'Authorization': `Basic ${basicAuth}`,
        },
      }, formData)
      if (statusCode < 200 || statusCode >= 400) {
        throw new Error(`login failed with status ${statusCode}${statusCode === 400 || statusCode === 401 ? ' — please check your email and password' : ''}`)
      }
      this.tokenData = {
        ...body,
        expires_in: typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 900,
        timestamp: Date.now(),
      }
      this.log.debug('Logged in to the ControlMySpa cloud')
    })()
    try {
      await this.inflightLogin
    } finally {
      this.inflightLogin = undefined
    }
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.isLoggedIn()) {
      await this.login()
    }
  }

  /**
   * List all spas on the account
   */
  public async getSpas(): Promise<CmsSpa[]> {
    await this.ensureLoggedIn()
    const { body, statusCode } = await this.requestJson(`${CMS_SPAS_URL}?page=0&pageSize=20`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.tokenData!.access_token}` },
    })
    if (statusCode < 200 || statusCode >= 400) {
      throw new Error(`spa list request failed with status ${statusCode}`)
    }
    return body?._embedded?.spas ?? []
  }

  /**
   * Send a control command to a spa. The api acknowledges the command
   * immediately; the spa applies it over the following seconds, so callers
   * should re-poll rather than expect the state to have changed already.
   */
  private async control(spaId: string, action: string, data: Record<string, unknown>): Promise<void> {
    await this.ensureLoggedIn()
    const payload = JSON.stringify(data)
    const { statusCode, body } = await this.requestJson(`${CMS_CONTROL_URL}/${spaId}/${action}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${this.tokenData!.access_token}`,
      },
    }, payload)
    if (statusCode < 200 || statusCode >= 400) {
      const message = typeof body?.message === 'string' ? `: ${body.message}` : ''
      throw new Error(`${action} failed with status ${statusCode}${message}`)
    }
  }

  /**
   * Set the desired water temperature, in degrees fahrenheit
   */
  public async setDesiredTemp(spaId: string, tempFahrenheit: number): Promise<void> {
    await this.control(spaId, 'setDesiredTemp', { desiredTemp: tempFahrenheit.toFixed(1) })
  }

  /**
   * Toggle the heater between READY and REST. The api only offers a toggle,
   * so callers must check the current mode first.
   */
  public async toggleHeaterMode(spaId: string): Promise<void> {
    await this.control(spaId, 'toggleHeaterMode', { originatorId: '' })
  }

  /**
   * Set a jet pump on a numbered port to OFF or HIGH
   */
  public async setJetState(spaId: string, port: string, on: boolean): Promise<void> {
    await this.control(spaId, 'setJetState', {
      deviceNumber: port,
      desiredState: on ? 'HIGH' : 'OFF',
      originatorId: 'optional-Jet',
    })
  }

  /**
   * Set a blower on a numbered port to OFF or HIGH
   */
  public async setBlowerState(spaId: string, port: string, on: boolean): Promise<void> {
    await this.control(spaId, 'setBlowerState', {
      deviceNumber: port,
      desiredState: on ? 'HIGH' : 'OFF',
      originatorId: 'optional-Blower',
    })
  }

  /**
   * Set a light on a numbered port to OFF or HIGH
   */
  public async setLightState(spaId: string, port: string, on: boolean): Promise<void> {
    await this.control(spaId, 'setLightState', {
      deviceNumber: port,
      desiredState: on ? 'HIGH' : 'OFF',
      originatorId: 'optional-Light',
    })
  }

  /**
   * Lock or unlock the spa's physical control panel
   */
  public async setPanelLock(spaId: string, locked: boolean): Promise<void> {
    await this.control(spaId, 'setPanel', {
      desiredState: locked ? 'LOCK_PANEL' : 'UNLOCK_PANEL',
      originatorId: '',
    })
  }

  private async requestJson(url: string, options: RequestOptions, requestBody?: string): Promise<{ body: any, statusCode: number }> {
    return await new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const req = httpsRequest(parsedUrl, {
        method: options.method,
        headers: options.headers,
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            const body = text ? JSON.parse(text) : {}
            resolve({ body, statusCode })
          } catch {
            // Some error responses are not json — surface the status instead
            resolve({ body: {}, statusCode })
          }
        })
      })

      req.on('timeout', () => {
        req.destroy(new Error(`request to ${parsedUrl.pathname} timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`))
      })
      req.on('error', error => reject(error))

      if (requestBody) {
        req.write(requestBody)
      }

      req.end()
    })
  }
}
