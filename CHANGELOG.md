# Changelog

All notable changes are listed here. The version number lives in `package.json`; see "Releases" in the README.
Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow [Semantic Versioning](https://semver.org/) (0.x: the API may still change).

## [Unreleased]

## [0.11.0] - 2026-11-02
First tagged version.
### Added
- Print request page with automatic G-code checks (printer model, nozzle, material, time, weight, temperatures, forbidden commands), filament choice, staff approval and live queue.
- Staff area: review, approve/reject, priorities, printers (PrusaLink, HTTP Digest), loaded filament, "bed is clear", auto-start, rules, filament list, audit log, CSV export.
- Full binary G-code (`.bgcode`) support: Heatshrink, MeatPack, Deflate, CRC32; verified against Prusa's libbgcode encoder.
- Docker image (built by GitHub Actions to ghcr.io), docker-compose file, Unraid instructions.
- AGPL-3.0-or-later license.
- Version number shown in the page footer, the server log and `/api/config`.
### Known limitations
- Not yet tested on real printers or on a real PrusaSlicer export (see README).

[Unreleased]: https://github.com/kiischti/3DPMQ/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/kiischti/3DPMQ/releases/tag/v0.11.0
