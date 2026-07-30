# Change Log

All notable changes to `@homebridge-plugins/homebridge-controlmyspa` will be documented in this file.

## v1.1.1 (Pending Release)

### Changed

- chore: keep test files out of the published package
- chore(github): run the build and tests in ci, on node 22, 24 and 26
- chore: use the same lint setup across every plugin
- chore: add a changelog:sync script to populate the pending section from the commits
- chore: count a repeated commit subject once when syncing the changelog
- chore(github): check the changelog against the commits in ci
- chore(deps): dependency updates

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
