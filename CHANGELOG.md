# Change Log

All notable changes to `@homebridge-plugins/homebridge-controlmyspa` will be documented in this file.

## v1.2.1 (Pending Release)

### Changed

- fix: step a pump from low to off through high, the only route the spa's own control has

## v1.2.0 (2026-08-24)

### Changed

- fix(schema): require the plugin logging level to drop the duplicate none entry
- feat: log what the spa reports each pump, blower and light can do, so multi-speed support can be worked out
- feat: show a two-speed pump as a fan, so speed 1 and speed 2 are one slider instead of two presses
- chore(deps): dependency updates

## v1.1.2 (2026-08-13)

### Changed

- fix: keep debug warnings, errors and successes out of the log unless debug is on
- chore(deps): dependency updates

## v1.1.1 (2026-08-09)

### Changed

- chore: keep test files out of the published package
- chore(github): run the build and tests in ci, on node 22, 24 and 26
- chore: use the same lint setup across every plugin
- chore: add a changelog:sync script to populate the pending section from the commits
- chore: count a repeated commit subject once when syncing the changelog
- chore(github): check the changelog against the commits in ci
- chore(deps): dependency updates
- docs: add node 26 to the supported node versions
- chore: allow dependency install scripts by package name rather than pinned version, so a version bump cannot silently block a native build
- chore: exclude test files and the test config from the published package
- fix: say once when the controlmyspa cloud stops responding, and again when it is back, instead of a line for every failed check
- fix: restore debug logging when the plugin runs in a child bridge
- fix: keep the spa accessories when the account list comes back empty
- fix: keep the jets, blower and light tiles when a poll returns no components
- fix: recover from a connection dropped mid-response instead of stopping every poll
- fix: always send a heater mode change, rather than trusting the cached mode
- fix: cancel a pending settle poll when homebridge shuts down
- fix: reject a refresh rate so large it would make the plugin poll every millisecond

## v1.1.0 (2026-07-27)

### Changed

- chore(github): allow the codeql scan to be started manually
- chore(github): stop concurrent release runs racing for the same version
- chore(github): use the shared homebridge action to deprecate past pre-releases
- docs(github): name this plugin's devices in the issue forms instead of meater
- feat(ui): add a custom ui with settings, my devices and support tabs, including the device picker
- style(ui): standardise the custom ui layout and sync the support tab with the readme
- feat(ui): add a remove all devices action to the my devices tab
- chore: declare the supports-hap transport keyword for the homebridge ui
- chore(deps): dependency updates
- docs(changelog): list every unreleased commit in the pending section

## v1.0.4 (2026-07-20)

### Changed

- fix(schema): give the logging levels clear, distinct names
- chore(deps): dependency updates

## v1.0.3 (2026-07-18)

### Changed

- chore(deps): dependency updates

## v1.0.2 (2026-07-17)

### Changed

- chore: add the verified by homebridge badge to the readme
- chore: add the homebridge prefix to the plugin display name

## v1.0.1 (2026-07-17)

### Changed

- fix: use a valid json schema required declaration in the config schema

## v1.0.0 (2026-07-17)

### Changed

- feat: initial release with water temperature control, heater mode, jets, blower, lights and panel lock
