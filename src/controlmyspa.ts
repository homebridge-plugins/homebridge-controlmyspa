/* Copyright(C) 2026, bwp91 (https://github.com/bwp91). All rights reserved.
 *
 * controlmyspa.ts: @homebridge-plugins/homebridge-controlmyspa
 */

import type { RequestOptions } from 'node:https'

import type { CmsDashboard, CmsSpaSummary, CmsTokenData } from './settings.js'

import { Buffer } from 'node:buffer'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'

import { CMS_BASE_URL } from './settings.js'

const REQUEST_TIMEOUT_MS = 30000
const TOKEN_LIFETIME_FALLBACK_S = 3600

// The api expects the official app's user agent
const USER_AGENT = 'cms/34 CFNetwork/3826.500.111.2.2 Darwin/24.4.0'

export interface CmsLogger {
  debug: (message: string) => void
  warn: (message: string) => void
}

/**
 * A self-contained client for the current ControlMySpa cloud api, matching
 * what the official mobile app does: a json login for a bearer token, spa
 * discovery via /spas/owned, live state via /spas/{id}/dashboard, and
 * controls via /spa-commands endpoints. The api sends and receives
 * temperatures in fahrenheit regardless of the spa's display unit.
 */
export class ControlMySpaClient {
  private tokenData?: CmsTokenData
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
   * Log in with the user's email and password. Concurrent callers share a
   * single login request.
   */
  private async login(): Promise<void> {
    if (this.inflightLogin) {
      return this.inflightLogin
    }
    this.inflightLogin = (async () => {
      const payload = JSON.stringify({ email: this.email, password: this.password })
      const { body, statusCode } = await this.requestJson(`${CMS_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, payload)
      if (statusCode < 200 || statusCode >= 400) {
        throw new Error(`login failed with status ${statusCode}${[400, 401].includes(statusCode) ? ' — please check your email and password' : ''}`)
      }
      const accessToken = body?.data?.accessToken
      if (!accessToken) {
        throw new Error('login succeeded but the response contained no access token')
      }
      this.tokenData = {
        access_token: accessToken,
        expires_in: TOKEN_LIFETIME_FALLBACK_S,
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
   * An authorised request, retried once with a fresh login if the token is
   * rejected mid-lifetime
   */
  private async authedRequest(url: string, options: RequestOptions, requestBody?: string): Promise<{ body: any, statusCode: number }> {
    await this.ensureLoggedIn()
    const withAuth = (): RequestOptions => ({
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${this.tokenData!.access_token}` },
    })
    let response = await this.requestJson(url, withAuth(), requestBody)
    if (response.statusCode === 401) {
      this.log.debug('Token rejected, logging in again')
      this.tokenData = undefined
      await this.ensureLoggedIn()
      response = await this.requestJson(url, withAuth(), requestBody)
    }
    return response
  }

  /**
   * List all spas on the account
   */
  public async getSpas(): Promise<CmsSpaSummary[]> {
    const { body, statusCode } = await this.authedRequest(`${CMS_BASE_URL}/spas/owned`, { method: 'GET' })
    if (statusCode < 200 || statusCode >= 400) {
      throw new Error(`spa list request failed with status ${statusCode}`)
    }
    return body?.data?.spas ?? []
  }

  /**
   * Fetch a spa's live state
   */
  public async getDashboard(spaId: string): Promise<CmsDashboard> {
    const { body, statusCode } = await this.authedRequest(`${CMS_BASE_URL}/spas/${spaId}/dashboard`, { method: 'GET' })
    if (statusCode < 200 || statusCode >= 400) {
      throw new Error(`dashboard request failed with status ${statusCode}`)
    }
    if (!body?.data) {
      throw new Error('dashboard response contained no data')
    }
    return body.data
  }

  /**
   * Send a spa command. The api acknowledges the command immediately; the
   * spa applies it over the following seconds, so callers should re-poll
   * rather than expect the state to have changed already.
   */
  private async command(endpoint: string, spaId: string, data: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify({ spaId, via: 'MOBILE', ...data })
    const { statusCode, body } = await this.authedRequest(`${CMS_BASE_URL}/spa-commands/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, payload)
    if (statusCode < 200 || statusCode >= 400) {
      const message = typeof body?.message === 'string' ? `: ${body.message}` : ''
      throw new Error(`${endpoint} failed with status ${statusCode}${message}`)
    }
  }

  /**
   * Set the desired water temperature, in degrees fahrenheit
   */
  public async setDesiredTemp(spaId: string, tempFahrenheit: number): Promise<void> {
    await this.command('temperature/value', spaId, { value: tempFahrenheit })
  }

  /**
   * Set the heater mode directly (READY or REST)
   */
  public async setHeaterMode(spaId: string, mode: 'READY' | 'REST'): Promise<void> {
    await this.command('temperature/heater-mode', spaId, { mode })
  }

  /**
   * Set a jet pump, blower or light on a numbered port to OFF or HIGH.
   * The dashboard reports ports as strings but the command api validates
   * deviceNumber as a number, so it is converted here.
   */
  public async setComponentState(spaId: string, componentType: 'jet' | 'blower' | 'light', deviceNumber: string, on: boolean): Promise<void> {
    await this.command('component-state', spaId, {
      deviceNumber: Number.parseInt(deviceNumber, 10),
      componentType,
      state: on ? 'HIGH' : 'OFF',
    })
  }

  /**
   * Lock or unlock the spa's physical control panel
   */
  public async setPanelLock(spaId: string, locked: boolean): Promise<void> {
    await this.command('panel/state', spaId, { state: locked ? 'LOCK_PANEL' : 'UNLOCK_PANEL' })
  }

  private async requestJson(url: string, options: RequestOptions, requestBody?: string): Promise<{ body: any, statusCode: number }> {
    return await new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const req = httpsRequest(parsedUrl, {
        method: options.method,
        headers: {
          'Accept': '*/*',
          'Accept-Language': 'en-GB,en;q=0.9',
          'User-Agent': USER_AGENT,
          ...options.headers,
        },
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        const chunks: Buffer[] = []

        // The request's own 'error' handler below only covers failures before the
        // response arrives. Once the headers are in, node reports a dropped
        // connection by erroring the response stream instead - with no listener
        // here that is an uncaught exception, and the promise never settles, so
        // polling would stop for good even if the bridge survived.
        res.on('error', error => reject(error))
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
