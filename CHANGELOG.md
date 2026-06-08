# Changelog

## [3.0.0](https://github.com/Vivswan/copilot-env/compare/v2.0.0...v3.0.0) (2026-06-08)


### ⚠ BREAKING CHANGES

* v2.0.0 was skipped for installer assets; v3.0.0 is the supported installer release.
* bootstrap installers now only install bun, fetch the selected release, run the bundled installer, and leave optional CLIs and launchers to agent setup.

### Features

* harden release installer assets ([d7c37c7](https://github.com/Vivswan/copilot-env/commit/d7c37c74b111d63533428fee998d17388020cb82))
* make install + update fully git-free via release tarballs ([5945526](https://github.com/Vivswan/copilot-env/commit/594552655a57d1013c843998ffba610025de53ca))
* opt-in cl/co/cx launchers, shell/ folder, and update migrations ([acffd84](https://github.com/Vivswan/copilot-env/commit/acffd8480aea50e7d9455604e492c4a613a7868e))
* publish v3 installer release ([0ab58b8](https://github.com/Vivswan/copilot-env/commit/0ab58b8ed9045251c937b1d2ad48c488f4ed2a78))
* release-based install with agent update / shell-integration ([857ef36](https://github.com/Vivswan/copilot-env/commit/857ef3641d5755fe714a9dba8e027976756039e5))
* rename codex_config/host_codex to codex-config/host-codex ([c37a834](https://github.com/Vivswan/copilot-env/commit/c37a83410b4cdbf89404a5e9a74ee3497ec24eab))
* show the release version while installing ([e492f73](https://github.com/Vivswan/copilot-env/commit/e492f736e5185ef1adc17a10a0696067b7933c3d))
* simplify installer bootstrap and setup flow ([01c72b4](https://github.com/Vivswan/copilot-env/commit/01c72b4fc9746a72a20e4a35c166b8cb11c16684))


### Bug Fixes

* allow release smoke to resolve draft assets ([0e9d787](https://github.com/Vivswan/copilot-env/commit/0e9d787061bea5a926d65c82db32b173d986f484))
* correct gateway float and env loading ([2d4bae1](https://github.com/Vivswan/copilot-env/commit/2d4bae14cbb64901d49bd597c7e83e55aec2e45a))
* harden installer CI against transient downloads ([#17](https://github.com/Vivswan/copilot-env/issues/17)) ([bb82ec0](https://github.com/Vivswan/copilot-env/commit/bb82ec0205186d6265fa6b61908a4deba352a215))
* install.sh installs deps even with --no-shell-integration ([55f3b3d](https://github.com/Vivswan/copilot-env/commit/55f3b3d1dc41c56e3b4adbf421b6a3731bd5caeb))
* make Codex .env writes non-destructive ([c49bc73](https://github.com/Vivswan/copilot-env/commit/c49bc7321618c8bd0911ebfc1a7a0e8c424cc87d))
* pin release installer assets ([0b1a0f7](https://github.com/Vivswan/copilot-env/commit/0b1a0f7f492dbaecdbe8c416b68dccf33f04c049))
* PR Title validation ([941fc14](https://github.com/Vivswan/copilot-env/commit/941fc14a86b702ac5dea1aff8019c28eb5eedbb3))
* skip unavailable execution policy cmdlets ([b688ce5](https://github.com/Vivswan/copilot-env/commit/b688ce50d636653675526db54f23f1883e5a1985))
* unify the Codex gateway key as OPENAI_API_KEY and enforce managed provider fields ([b96ca71](https://github.com/Vivswan/copilot-env/commit/b96ca7155bf2fe2eecb4c3c460abd3b6a53c55da))

## [2.0.0](https://github.com/Vivswan/copilot-env/compare/v1.3.0...v2.0.0) (2026-06-08)


### ⚠ BREAKING CHANGES

* bootstrap installers now only install bun, fetch the selected release, run the bundled installer, and leave optional CLIs and launchers to agent setup.

### Features

* harden release installer assets ([d7c37c7](https://github.com/Vivswan/copilot-env/commit/d7c37c74b111d63533428fee998d17388020cb82))
* simplify installer bootstrap and setup flow ([01c72b4](https://github.com/Vivswan/copilot-env/commit/01c72b4fc9746a72a20e4a35c166b8cb11c16684))


### Bug Fixes

* correct gateway float and env loading ([2d4bae1](https://github.com/Vivswan/copilot-env/commit/2d4bae14cbb64901d49bd597c7e83e55aec2e45a))
* harden installer CI against transient downloads ([#17](https://github.com/Vivswan/copilot-env/issues/17)) ([bb82ec0](https://github.com/Vivswan/copilot-env/commit/bb82ec0205186d6265fa6b61908a4deba352a215))
* pin release installer assets ([0b1a0f7](https://github.com/Vivswan/copilot-env/commit/0b1a0f7f492dbaecdbe8c416b68dccf33f04c049))
* skip unavailable execution policy cmdlets ([b688ce5](https://github.com/Vivswan/copilot-env/commit/b688ce50d636653675526db54f23f1883e5a1985))

## [1.3.0](https://github.com/Vivswan/copilot-env/compare/v1.2.2...v1.3.0) (2026-06-07)


### Features

* opt-in cl/co/cx launchers, shell/ folder, and update migrations ([acffd84](https://github.com/Vivswan/copilot-env/commit/acffd8480aea50e7d9455604e492c4a613a7868e))

## [1.2.2](https://github.com/Vivswan/copilot-env/compare/v1.2.1...v1.2.2) (2026-06-07)


### Bug Fixes

* make Codex .env writes non-destructive ([c49bc73](https://github.com/Vivswan/copilot-env/commit/c49bc7321618c8bd0911ebfc1a7a0e8c424cc87d))
* PR Title validation ([941fc14](https://github.com/Vivswan/copilot-env/commit/941fc14a86b702ac5dea1aff8019c28eb5eedbb3))
* unify the Codex gateway key as OPENAI_API_KEY and enforce managed provider fields ([b96ca71](https://github.com/Vivswan/copilot-env/commit/b96ca7155bf2fe2eecb4c3c460abd3b6a53c55da))

## [1.2.1](https://github.com/Vivswan/copilot-env/compare/v1.2.0...v1.2.1) (2026-06-06)


### Bug Fixes

* install.sh installs deps even with --no-shell-integration ([55f3b3d](https://github.com/Vivswan/copilot-env/commit/55f3b3d1dc41c56e3b4adbf421b6a3731bd5caeb))

## [1.2.0](https://github.com/Vivswan/copilot-env/compare/v1.1.0...v1.2.0) (2026-06-06)


### Features

* rename codex_config/host_codex to codex-config/host-codex ([c37a834](https://github.com/Vivswan/copilot-env/commit/c37a83410b4cdbf89404a5e9a74ee3497ec24eab))
* show the release version while installing ([e492f73](https://github.com/Vivswan/copilot-env/commit/e492f736e5185ef1adc17a10a0696067b7933c3d))

## [1.1.0](https://github.com/Vivswan/copilot-env/compare/v1.0.0...v1.1.0) (2026-06-06)


### Features

* make install + update fully git-free via release tarballs ([5945526](https://github.com/Vivswan/copilot-env/commit/594552655a57d1013c843998ffba610025de53ca))

## [1.0.0](https://github.com/Vivswan/copilot-env/compare/v0.1.0...v1.0.0) (2026-06-06)


### Features

* release-based install with agent update / shell-integration ([857ef36](https://github.com/Vivswan/copilot-env/commit/857ef3641d5755fe714a9dba8e027976756039e5))
