import { beforeEach, describe, expect, it } from 'vitest'

import { ControlMySpaPlatform } from './platform.js'

/**
 * How a ControlMySpa outage reads in the log.
 *
 * The cloud goes down for hours at a time and the plugin retries on every
 * refresh, so reporting each failure buries everything else. One real report
 * (2026-08-03) ran to 147 error lines in under seven hours: 81 timeouts, 64
 * responses of 503 and 2 of 404, and no failed logins at all. The owner read
 * that as a login problem with the plugin, which it was not.
 */

// The exact messages the client produces, so a reworded error cannot pass here
// while going unrecognised in the field
const TIMEOUT = 'request to /spas/69ba02830545973b0405dfff/dashboard timed out after 30 seconds'
const UNAVAILABLE = 'dashboard request failed with status 503'
const LOGIN_TIMEOUT = 'request to /auth/login timed out after 30 seconds'
const NOT_FOUND = 'dashboard request failed with status 404'
const BAD_CREDENTIALS = 'login failed with status 401 — please check your email and password'

function makePlatform() {
  const logs = { warn: [] as string[], error: [] as string[], debug: [] as string[], success: [] as string[] }
  const platform = Object.create(ControlMySpaPlatform.prototype) as ControlMySpaPlatform
  Object.assign(platform, {
    warnLog: async (m: string) => void logs.warn.push(m),
    errorLog: async (m: string) => void logs.error.push(m),
    debugLog: async (m: string) => void logs.debug.push(m),
    successLog: async (m: string) => void logs.success.push(m),
  })
  return { platform, logs }
}

describe('reporting a cloud that is not answering', () => {
  let platform: ControlMySpaPlatform
  let logs: ReturnType<typeof makePlatform>['logs']

  beforeEach(() => {
    ({ platform, logs } = makePlatform())
  })

  it('announces the first failure, and says it will go quiet', async () => {
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(TIMEOUT))

    expect(logs.warn).toHaveLength(1)
    expect(logs.warn[0]).toContain('timed out after 30 seconds')
    expect(logs.warn[0]).toContain('not responding')
    expect(logs.error).toHaveLength(0)
  })

  it('says it once across a whole outage, however many calls fail', async () => {
    // 81 timeouts and 64 unavailables, interleaved as they were on the day
    for (let i = 0; i < 81; i += 1) {
      await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(TIMEOUT))
    }
    for (let i = 0; i < 64; i += 1) {
      await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(UNAVAILABLE))
    }

    expect(logs.warn).toHaveLength(1)
    expect(logs.error).toHaveLength(0)
    // still recorded for anyone who turns debug on
    expect(logs.debug).toHaveLength(144)
  })

  it('stays quiet about button presses during the same outage', async () => {
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(TIMEOUT))
    await platform.reportCloudFailure('Spa Pool failed to set pump state', new Error(UNAVAILABLE))
    await platform.reportCloudFailure('Spa Pool failed to set blower state', new Error(UNAVAILABLE))
    await platform.reportCloudFailure('Spa Pool failed to set light state', new Error(UNAVAILABLE))

    expect(logs.warn).toHaveLength(1)
    expect(logs.error).toHaveLength(0)
  })

  it('treats a login timeout as the cloud being down, not a login problem', async () => {
    // The five lines that made the owner think his credentials were wrong
    await platform.reportCloudFailure('Failed to Discover Spas', new Error(LOGIN_TIMEOUT))

    expect(logs.warn).toHaveLength(1)
    expect(logs.warn[0]).toContain('at their end rather than yours')
  })

  it('still reports a rejected login every time, since that needs acting on', async () => {
    await platform.reportCloudFailure('Failed to Discover Spas', new Error(BAD_CREDENTIALS))
    await platform.reportCloudFailure('Failed to Discover Spas', new Error(BAD_CREDENTIALS))

    expect(logs.error).toHaveLength(2)
    expect(logs.warn).toHaveLength(0)
  })

  it('still reports a 404 every time, since it is about this request', async () => {
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(NOT_FOUND))
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(NOT_FOUND))

    expect(logs.error).toHaveLength(2)
    expect(logs.warn).toHaveLength(0)
  })

  it('a 4xx during an outage does not end the quiet period', async () => {
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(TIMEOUT))
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(NOT_FOUND))
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(TIMEOUT))

    expect(logs.warn).toHaveLength(1)
    expect(logs.error).toHaveLength(1)
  })
})

describe('when the cloud comes back', () => {
  let platform: ControlMySpaPlatform
  let logs: ReturnType<typeof makePlatform>['logs']

  beforeEach(() => {
    ({ platform, logs } = makePlatform())
  })

  it('says so, and counts what it hid', async () => {
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(TIMEOUT))
    for (let i = 0; i < 9; i += 1) {
      await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(UNAVAILABLE))
    }

    await platform.noteCloudReachable()

    expect(logs.success).toHaveLength(1)
    expect(logs.success[0]).toContain('responding again')
    expect(logs.success[0]).toContain('hiding 9 more')
  })

  it('says nothing when it was never down', async () => {
    await platform.noteCloudReachable()

    expect(logs.success).toHaveLength(0)
  })

  it('announces the next outage again, rather than staying quiet forever', async () => {
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(TIMEOUT))
    await platform.noteCloudReachable()
    await platform.reportCloudFailure('Failed to refresh state for Spa Pool', new Error(TIMEOUT))

    expect(logs.warn).toHaveLength(2)
  })
})
