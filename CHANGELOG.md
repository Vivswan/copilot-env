# Changelog

## [3.3.7](https://github.com/Vivswan/copilot-env/compare/v3.3.6...v3.3.7) (2026-06-14)


### Bug Fixes

* migrate existing configs from localhost to 127.0.0.1 on update ([9617977](https://github.com/Vivswan/copilot-env/commit/9617977783d8a77d5717ae5b9d7d1959edec4db1))
* probe both loopback families concurrently in the liveness check ([54cfeda](https://github.com/Vivswan/copilot-env/commit/54cfeda5ff200011ce76d2ae59ca8060dfb73186))

## [3.3.6](https://github.com/Vivswan/copilot-env/compare/v3.3.5...v3.3.6) (2026-06-13)


### Bug Fixes

* backfill test coverage for the untested subsystems ([470b368](https://github.com/Vivswan/copilot-env/commit/470b3686c2f6b3d1a657824cdb76961f3f041210))
* drop the redundant `agent update --cooldown` flag ([4765471](https://github.com/Vivswan/copilot-env/commit/476547170fbb0fcc6411290f1cecd8e14893cb31))
* make the start --check probe activity-neutral for the idle watchdog ([0f621ac](https://github.com/Vivswan/copilot-env/commit/0f621ace21f692bd681c4f0777c237a172789a6d))
* print a human-readable status from start --check ([d8658e9](https://github.com/Vivswan/copilot-env/commit/d8658e946d86cc5ca383e8a0d3bdfd67005b3f37))
* reach the proxy at 127.0.0.1 and consolidate child-env PATH handling ([d450f91](https://github.com/Vivswan/copilot-env/commit/d450f9142a36128504a8071b62062123bc60b064))
* several Windows incompatibilities (Claude helper, health probe, paths) ([897fcbd](https://github.com/Vivswan/copilot-env/commit/897fcbd2c0a8d4a321227f5ed59f457876362e19))

## [3.3.5](https://github.com/Vivswan/copilot-env/compare/v3.3.4...v3.3.5) (2026-06-13)


### Bug Fixes

* add `agent config` and route the scattered knobs through it ([5520b4e](https://github.com/Vivswan/copilot-env/commit/5520b4edb385cc6cc92981033d6558e10ee3d5f6))
* add a gpt-latest alias for the newest non-mini GPT ([53982ea](https://github.com/Vivswan/copilot-env/commit/53982ea63a899b7cb3f6fbff3aec894d72ad83ae))
* auto-start the proxy on demand in agent proxy mode ([de6c654](https://github.com/Vivswan/copilot-env/commit/de6c6549878d5d462ece27bf98ce6fbb09343cf6))
* opt-in managed proxy lifecycle (auto-start + idle auto-stop) ([c9442c5](https://github.com/Vivswan/copilot-env/commit/c9442c541a56b89458f49123c4c7d4015c156aa1))

## [3.3.4](https://github.com/Vivswan/copilot-env/compare/v3.3.3...v3.3.4) (2026-06-12)


### Bug Fixes

* add --gh-token for headless Direct mode without the gh CLI ([c8beda5](https://github.com/Vivswan/copilot-env/commit/c8beda5b1b3f1aef949b953cdc2e054e9ee17d8e))
* consolidate the CLI surface and share the gh-token store ([1586274](https://github.com/Vivswan/copilot-env/commit/1586274cefc946de09f776a86941009a806d73cb))
* drive the proxy with a PAT via a fetch-preload shim, not opencode ([8b8980a](https://github.com/Vivswan/copilot-env/commit/8b8980a823f3b98b5d5d2b4a0fc1e456b2ab430d))
* prompt for gh-token when GH_TOKEN/GITHUB_TOKEN are unset ([916f62b](https://github.com/Vivswan/copilot-env/commit/916f62b916a5fcc67fe4a77792d03e75a6c7a1e5))
* provider-driven credential behind a Credential class, with semver + valibot ([ef49ec7](https://github.com/Vivswan/copilot-env/commit/ef49ec75cef1d4273dfab27e76fae24cb54b88ec))
* run the proxy in passthrough mode for PAT credentials ([8955d57](https://github.com/Vivswan/copilot-env/commit/8955d57219f2786e43af2348a37d52758b84cd0c))
* unify the Codex model provider under a single copilot-env id ([7bae708](https://github.com/Vivswan/copilot-env/commit/7bae70840c6d2eeaeb2a3ee0c7b2d487af6c1de2))
* write the proxy log tail raw and export the passthrough constant ([602e04d](https://github.com/Vivswan/copilot-env/commit/602e04d3380297b34ac2008c6790d70b346a718e))

## [3.3.3](https://github.com/Vivswan/copilot-env/compare/v3.3.2...v3.3.3) (2026-06-11)


### Bug Fixes

* load the Claude Direct-probe apiKeyHelper by pairing --bare with --settings ([09d952f](https://github.com/Vivswan/copilot-env/commit/09d952f6449db4ccede4f86da67f9b3f9308976b))

## [3.3.2](https://github.com/Vivswan/copilot-env/compare/v3.3.1...v3.3.2) (2026-06-11)


### Bug Fixes

* make codex Direct detection work outside a git repo and show the full live error ([f5cd2ea](https://github.com/Vivswan/copilot-env/commit/f5cd2ea8c3cbf8a6b6bda97ab0a292882f1784b6))

## [3.3.1](https://github.com/Vivswan/copilot-env/compare/v3.3.0...v3.3.1) (2026-06-11)


### Bug Fixes

* surface why agent init falls back to the proxy and sanitize the probe env ([ec5c7e4](https://github.com/Vivswan/copilot-env/commit/ec5c7e4ad388bad57259523e28cbfb892828e946))

## [3.3.0](https://github.com/Vivswan/copilot-env/compare/v3.2.0...v3.3.0) (2026-06-10)


### Features

* **codex:** add --mobile to pair the Codex app with phone remote-control ([6449597](https://github.com/Vivswan/copilot-env/commit/6449597b6e15cd10923902708577c6262355b54d))
* **codex:** disable image_generation in Direct mode, drop it for proxy ([dba197e](https://github.com/Vivswan/copilot-env/commit/dba197ecab388cc2274b3512b0a38dd6642f4fe8))
* **codex:** drive the Codex app on Windows for --mobile; gate Linux ([a5a61c1](https://github.com/Vivswan/copilot-env/commit/a5a61c1eb4ec981b67bc4e77a2e6d5655e5e8aa5))
* rename the local service from 'gateway' to 'proxy' and polish CLI output ([421fc07](https://github.com/Vivswan/copilot-env/commit/421fc07f1e7c7aa9de0f6c8f67bbe5e3737c3a2d))


### Bug Fixes

* add clx/cox/cxx permissive launcher variants ([d5117cd](https://github.com/Vivswan/copilot-env/commit/d5117cda9c46b8bed35043d840729ce30c91f29d))
* added on auto-detect to README; warn on Direct ([0520dd5](https://github.com/Vivswan/copilot-env/commit/0520dd50454ea501dc11edc4bfa7d01c97b32c3d))
* align agent cost bullet in init guidance box ([ec0565e](https://github.com/Vivswan/copilot-env/commit/ec0565e3ac0afc8e131e85fb6bbe6898096881f0))
* harden Direct auto-detect probe with retry + env sanitization ([8ca98b6](https://github.com/Vivswan/copilot-env/commit/8ca98b6fee39bff60c250634a33704014f4e6d62))

## [3.2.0](https://github.com/Vivswan/copilot-env/compare/v3.1.2...v3.2.0) (2026-06-10)


### Features

* add Claude Code provider wiring (GitHub Copilot Direct + gateway proxy) ([57c736a](https://github.com/Vivswan/copilot-env/commit/57c736a74f62d61abaa09522f4bccfb3e734c904))
* agent init + codex/claude provider commands with live auto-detect ([c4518bc](https://github.com/Vivswan/copilot-env/commit/c4518bcf7ad1ebee5cadb8a01c30dcfe532527d8))
* configure agents via their own config files; agent env exports CODEX_HOME only ([e7d250f](https://github.com/Vivswan/copilot-env/commit/e7d250f6b67321232a2b7c7f451b35a825a6dd5a))
* support direct Copilot provider mode ([76ad1c8](https://github.com/Vivswan/copilot-env/commit/76ad1c858e999473073c2953e46787cfc62b9144))
* support setup-codex-host on macOS and render CLI errors as friendly messages ([ae3d726](https://github.com/Vivswan/copilot-env/commit/ae3d726ff2d1fa8d93cfa0926f176ba10d4525b0))


### Bug Fixes

* launch agent CLI shims via cmd.exe on Windows for Direct auto-detect ([aa5ec55](https://github.com/Vivswan/copilot-env/commit/aa5ec551398534877471918c72fcf57de8780036))
* make error and warning messages clearer and more actionable ([a7d97d7](https://github.com/Vivswan/copilot-env/commit/a7d97d755537591ac2e9a9e078cccadb0a14252b))
* probe gh auth once per health run to avoid a double-spawn timeout ([77f48ac](https://github.com/Vivswan/copilot-env/commit/77f48ace2e59c7a03e438c70263a624834a2f0b8))
* probe gh auth without blocking health; widen health smoke-test budgets ([1c65fe2](https://github.com/Vivswan/copilot-env/commit/1c65fe2e16e9c04855d4243f7f18e0502083e4ec))

## [3.1.2](https://github.com/Vivswan/copilot-env/compare/v3.1.1...v3.1.2) (2026-06-09)


### Bug Fixes

* add opt-in autoupdate for the copilot-env checkout ([d327078](https://github.com/Vivswan/copilot-env/commit/d3270789a90205324bbd68041942cb45ed15045c))
* add per-category cost breakdown to agent cost ([ab70dcb](https://github.com/Vivswan/copilot-env/commit/ab70dcbce04f56346e6eaaa74c56b243e295fe04))
* mark CodeQL env export alerts as false positives ([9250090](https://github.com/Vivswan/copilot-env/commit/9250090f94d59157caba08a50e172a30be055479))
* raise the gateway version floor to 1.11.0 ([5afd663](https://github.com/Vivswan/copilot-env/commit/5afd6638e3410904655bac37c94fa57a2b715805))
* replace COPILOT_API_NO_FLOAT with COPILOT_API_MIN_RELEASE_AGE ([a0485bb](https://github.com/Vivswan/copilot-env/commit/a0485bbfac181f9a93b5ff1a2bb2303328045534))
* surface autoupdate and gateway float cooldown in agent health ([d37dee3](https://github.com/Vivswan/copilot-env/commit/d37dee35d2b5d5374516dd7909156d84afb9c7f6))

## [3.1.1](https://github.com/Vivswan/copilot-env/compare/v3.1.0...v3.1.1) (2026-06-09)


### Bug Fixes

* expand agent health into a scoped diagnostic command ([271b21b](https://github.com/Vivswan/copilot-env/commit/271b21b5413dff3629792d055e5fc0abc019ecf6))

## [3.1.0](https://github.com/Vivswan/copilot-env/compare/v3.0.0...v3.1.0) (2026-06-08)


### Features

* flatten CLI commands and add custom root help ([8ae6c53](https://github.com/Vivswan/copilot-env/commit/8ae6c53b0535a2f046aaa3ade02995ed7f85440f))


### Bug Fixes

* use GitHub asset digests for release installs ([bc32c84](https://github.com/Vivswan/copilot-env/commit/bc32c847c9c058e5b7ae26be128fc782c942ac64))
* use singular PowerShell helper noun ([4dd9797](https://github.com/Vivswan/copilot-env/commit/4dd9797ba525fc9c54a3a54ff55479cdb097a8db))

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
* download draft release assets through API ([6a00313](https://github.com/Vivswan/copilot-env/commit/6a00313725d7386ac0d42d02a5718c472aa5932c))
* harden installer CI against transient downloads ([#17](https://github.com/Vivswan/copilot-env/issues/17)) ([bb82ec0](https://github.com/Vivswan/copilot-env/commit/bb82ec0205186d6265fa6b61908a4deba352a215))
* install.sh installs deps even with --no-shell-integration ([55f3b3d](https://github.com/Vivswan/copilot-env/commit/55f3b3d1dc41c56e3b4adbf421b6a3731bd5caeb))
* make Codex .env writes non-destructive ([c49bc73](https://github.com/Vivswan/copilot-env/commit/c49bc7321618c8bd0911ebfc1a7a0e8c424cc87d))
* pin release installer assets ([0b1a0f7](https://github.com/Vivswan/copilot-env/commit/0b1a0f7f492dbaecdbe8c416b68dccf33f04c049))
* PR Title validation ([941fc14](https://github.com/Vivswan/copilot-env/commit/941fc14a86b702ac5dea1aff8019c28eb5eedbb3))
* resolve draft release archive assets ([c479b43](https://github.com/Vivswan/copilot-env/commit/c479b4386fb8eb0f4d0998a67415a2113849d122))
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
