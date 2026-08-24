import { describe, expect, it } from 'vitest'

import { fanStateForValue, fanWriteTarget, isTwoSpeedComponent, stepsForTransition } from './spa.js'

/**
 * The decision logic behind the two-speed pump support (#7). The owner's spa
 * reports `accepts [OFF/LOW/HIGH]` for both pumps - one was sitting at LOW -
 * so LOW is a state the spa itself declares, not a guess.
 */
describe('which components get the two-speed treatment', () => {
  it('a pump that reports LOW does', () => {
    expect(isTwoSpeedComponent({ componentType: 'PUMP', availableValues: ['OFF', 'LOW', 'HIGH'] })).toBe(true)
  })

  it('a pump that only reports OFF and HIGH stays a switch', () => {
    expect(isTwoSpeedComponent({ componentType: 'PUMP', availableValues: ['OFF', 'HIGH'] })).toBe(false)
  })

  it('a pump that reports nothing stays a switch', () => {
    expect(isTwoSpeedComponent({ componentType: 'PUMP' })).toBe(false)
  })

  it('a light never does, whatever it reports', () => {
    // The owner's light reports OFF/HIGH, but guard the odd one out anyway
    expect(isTwoSpeedComponent({ componentType: 'LIGHT', availableValues: ['OFF', 'LOW', 'HIGH'] })).toBe(false)
  })

  it('a blower that reports LOW gets it too', () => {
    expect(isTwoSpeedComponent({ componentType: 'BLOWER', availableValues: ['OFF', 'LOW', 'HIGH'] })).toBe(true)
  })
})

/**
 * ⚠️ HomeKit sends "turn on at half speed" as TWO writes, Active and
 * RotationSpeed, with concurrent handlers. These pin the one command that a
 * batch collapses to - the same class of race that left Lutron dimmers at
 * full brightness (homebridge-lutron#270).
 */
describe('the single command a batch of fan writes becomes', () => {
  it('on at half speed goes to LOW, not full', () => {
    expect(fanWriteTarget({ active: true, speed: 50 })).toBe('LOW')
  })

  it('on at full speed goes to HIGH', () => {
    expect(fanWriteTarget({ active: true, speed: 100 })).toBe('HIGH')
  })

  it('a bare toggle-on means full speed', () => {
    // The whole point of #7: one press should reach full speed
    expect(fanWriteTarget({ active: true })).toBe('HIGH')
  })

  it('off wins over any speed sent alongside it', () => {
    expect(fanWriteTarget({ active: false, speed: 100 })).toBe('OFF')
  })

  it('a bare speed write needs no active half', () => {
    expect(fanWriteTarget({ speed: 50 })).toBe('LOW')
  })

  it('sliding to zero turns it off', () => {
    expect(fanWriteTarget({ speed: 0 })).toBe('OFF')
  })
})

/**
 * ⚠️ The bug this pins (#7, second round): asking for OFF while at LOW left
 * the pump at HIGH. The spa's control cycles OFF -> LOW -> HIGH and cannot
 * step backwards, so that one transition has to be sent as its two real
 * steps. Everything else behaved as a direct set in the owner's testing and
 * must stay a single command - stepping is seconds of delay, not free.
 */
describe('the steps a transition is sent as', () => {
  it('off-from-low goes through high, the only route the spa has', () => {
    expect(stepsForTransition('LOW', 'OFF')).toEqual(['HIGH', 'OFF'])
  })

  it('off-from-high is direct, as tested', () => {
    expect(stepsForTransition('HIGH', 'OFF')).toEqual(['OFF'])
  })

  it('full-from-off is direct, as tested', () => {
    expect(stepsForTransition('OFF', 'HIGH')).toEqual(['HIGH'])
  })

  it('half-from-full is direct, as tested', () => {
    expect(stepsForTransition('HIGH', 'LOW')).toEqual(['LOW'])
  })

  it('asking for the state it is already at sends nothing', () => {
    expect(stepsForTransition('LOW', 'LOW')).toEqual([])
  })

  it('an unknown current state sends the target directly rather than guessing a route', () => {
    expect(stepsForTransition(undefined, 'OFF')).toEqual(['OFF'])
  })
})

describe('what a reported value shows on the fan', () => {
  it('lOW is on at half speed', () => {
    expect(fanStateForValue('LOW')).toEqual({ active: true, speed: 50 })
  })

  it('hIGH is on at full speed', () => {
    expect(fanStateForValue('HIGH')).toEqual({ active: true, speed: 100 })
  })

  it('oFF leaves the slider where it was', () => {
    expect(fanStateForValue('OFF')).toEqual({ active: false, speed: null })
  })

  it('a missing value reads as off', () => {
    expect(fanStateForValue(undefined)).toEqual({ active: false, speed: null })
  })
})
