# Changelog

All notable changes are listed here. The version number lives in `package.json`; see "Releases" in the README.
Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow [Semantic Versioning](https://semver.org/) (0.x: the API may still change).

## [Unreleased]

## [0.12.0] - 2026-11-03
### Added
- People: every request is linked to a person (e-mail, class, role, notes). New *People* tab to list, search, filter, add, correct and remove students and staff, with CSV export.
- Statistics per person, per material and per month (completed prints, plastic weight, print time; stopped prints count by progress), plus overall and per-class totals.
- Class field on the request form; rule "new students must enter their class".
- Refused and cancelled requests can be removed one by one or all at once (*Clear all*) on the Review tab.
- Removing a person erases their personal data (optionally with all requests) and keeps anonymous statistics.
### Fixed
- Pause, resume, stop and cancel now ask the printer for the job that is running right now. Before, right after a print started the server could still hold the previous job's status: the progress could briefly show 100 %, and "stop" could be sent for the old job and fail with a generic error.
- If the printer refuses to stop a print, cancelling the request now reports that clearly instead of marking the request cancelled while the printer keeps printing.
- Forms on the staff pages (printer, rules, person, filament) and the login form are no longer wiped by a live update while you are typing.
### Changed
- The e-mail address is now required on the request form (it identifies the person); the old "require e-mail" rule is gone.
- Open-request limit and monthly gram quota are counted per person (by e-mail) instead of by typed name.
- The database is migrated automatically; existing requests are grouped into people.

## [0.11.1] - 2026-11-02
### Added
- Logo and icons: header logo, favicon (SVG + ICO), Apple touch icon, web app manifest, 512 px icon for Unraid / README, image labels in the Dockerfile.

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

[Unreleased]: https://github.com/kiischti/3DPMQ/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/kiischti/3DPMQ/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/kiischti/3DPMQ/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/kiischti/3DPMQ/releases/tag/v0.11.0
