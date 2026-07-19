<p align="center">
   <a href="https://github.com/homebridge-plugins/homebridge-controlmyspa"><img alt="homebridge-controlmyspa" src="https://raw.githubusercontent.com/homebridge-plugins/homebridge-controlmyspa/latest/branding/Homebridge_x_ControlMySpa.png" width="600px"></a>
</p>
<span align="center">

## homebridge-controlmyspa

Homebridge plugin to integrate Balboa ControlMySpa hot tubs into HomeKit

[![npm](https://img.shields.io/npm/v/@homebridge-plugins/homebridge-controlmyspa/latest?label=latest)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-controlmyspa)
[![npm](https://img.shields.io/npm/v/@homebridge-plugins/homebridge-controlmyspa/beta?label=beta)](https://github.com/homebridge/homebridge/wiki/How-to-Install-Alternate-Plugin-Versions)<br>
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)<br>
[![npm](https://img.shields.io/npm/dt/@homebridge-plugins/homebridge-controlmyspa)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-controlmyspa)
[![Discord](https://img.shields.io/discord/432663330281226270?color=728ED5&logo=discord&label=hb-discord)](https://discord.gg/bHjKNkN)

</span>

### Plugin Information

- This plugin allows you to control your [ControlMySpa](https://controlmyspa.com) hot tub within HomeKit. The plugin:
  - requires your ControlMySpa account credentials to work
  - connects to the ControlMySpa cloud, the same way the official mobile app does
  - exposes for each spa:
    - a thermostat for the water temperature and heater mode (READY/REST)
    - a switch for each jet pump and blower
    - a light for each spa light
    - an optional lock for the spa's physical control panel
- This plugin is for spas connected to the **ControlMySpa cloud**. If your Balboa spa uses a local WiFi module instead, [homebridge-balboa-spa](https://github.com/plasticrake/homebridge-balboa-spa) may suit better.

### Prerequisites

- To use this plugin, you will need to already have:
  - [Node](https://nodejs.org): latest version of `v22` or `v24` - any other major version is not supported.
  - [Homebridge](https://homebridge.io): `v2` - refer to link for more information and installation instructions.

### Setup

- [Installation](https://github.com/homebridge-plugins/homebridge-controlmyspa/wiki/Installation)
- [Configuration](https://github.com/homebridge-plugins/homebridge-controlmyspa/wiki/Configuration)
- [Beta Version](https://github.com/homebridge-plugins/homebridge-controlmyspa/wiki/Beta-Version)
- [Node Version](https://github.com/homebridge-plugins/homebridge-controlmyspa/wiki/Node-Version)

### Help/About

- [Common Errors](https://github.com/homebridge-plugins/homebridge-controlmyspa/wiki/Common-Errors)
- [Support Request](https://github.com/homebridge-plugins/homebridge-controlmyspa/issues/new/choose)
- [Changelog](https://github.com/homebridge-plugins/homebridge-controlmyspa/blob/latest/CHANGELOG.md)
- [About Me](https://github.com/sponsors/bwp91)

### Credits

- The current ControlMySpa cloud protocol is documented by [@haresik's Home Assistant integration](https://github.com/haresik/Hares-ControlMySpa), which this plugin's api client is based on.
- The original ControlMySpa cloud protocol was first documented by [@VVlasy's controlmyspajs](https://github.com/VVlasy/controlmyspajs).

### Disclaimer

- I am in no way affiliated with Balboa Water Group and this plugin is a personal project that I maintain in my free time.
- Use this plugin entirely at your own risk - please check your spa manually before use if temperature matters to you.
