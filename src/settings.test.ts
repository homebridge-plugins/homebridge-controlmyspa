import { describe, expect, it } from 'vitest'

import { celsiusToFahrenheit, fahrenheitToCelsius, PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

describe('settings', () => {
  it('exposes the platform and plugin names', () => {
    expect(PLATFORM_NAME).toBe('ControlMySpa')
    expect(PLUGIN_NAME).toBe('@homebridge-plugins/homebridge-controlmyspa')
  })
})

describe('fahrenheitToCelsius', () => {
  it('converts api string temps to celsius', () => {
    expect(fahrenheitToCelsius('104.0')).toBe(40)
    expect(fahrenheitToCelsius('98.5')).toBe(36.9)
    expect(fahrenheitToCelsius('32')).toBe(0)
  })

  it('accepts numeric input', () => {
    expect(fahrenheitToCelsius(104)).toBe(40)
  })

  it('returns undefined for missing or invalid values', () => {
    expect(fahrenheitToCelsius(undefined)).toBeUndefined()
    expect(fahrenheitToCelsius('not-a-temp')).toBeUndefined()
  })
})

describe('celsiusToFahrenheit', () => {
  it('converts celsius targets to fahrenheit', () => {
    expect(celsiusToFahrenheit(40)).toBe(104)
    expect(celsiusToFahrenheit(0)).toBe(32)
  })

  it('rounds to the nearest half degree fahrenheit', () => {
    expect(celsiusToFahrenheit(37)).toBe(98.5)
    expect(celsiusToFahrenheit(36.9)).toBe(98.5)
  })

  it('round trips typical spa temperatures', () => {
    for (const f of [80, 90, 98.5, 100, 102, 104]) {
      expect(celsiusToFahrenheit(fahrenheitToCelsius(f)!)).toBeCloseTo(f, 0)
    }
  })
})
