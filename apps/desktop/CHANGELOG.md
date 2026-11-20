# Changelog

## [0.2.0](https://github.com/wokshop/omni/compare/desktop-v0.1.4...desktop-v0.2.0) (2026-11-20)


### Features

* **crm:** a team-only Admin folder for contracts, and people involved in a contract ([#653](https://github.com/wokshop/omni/issues/653)) ([ec0d555](https://github.com/wokshop/omni/commit/ec0d555b070cb95c69dbf9e891aa61a24008052d))
* **desktop:** push Drive changes to Finder over the sync socket, and sync without per-tombstone lookups ([#602](https://github.com/wokshop/omni/issues/602)) ([24c1e56](https://github.com/wokshop/omni/commit/24c1e567f35ab4397e20d9f0ba62e4d0a0f1d906))
* **ios:** sentry crash and error reporting for ios and the mac file provider ([#586](https://github.com/wokshop/omni/issues/586)) ([d5c2c09](https://github.com/wokshop/omni/commit/d5c2c09a07acd74a9afccb035e242b168607d538))
* **web:** multi-select, server thumbnails and live folders in Drive ([#570](https://github.com/wokshop/omni/issues/570)) ([7a6d4ac](https://github.com/wokshop/omni/commit/7a6d4ac98bb25ac1979992b62d4937343e45a133))


### Fixes

* **desktop:** Mac sync saves edits in place, keeps both on conflict, stays signed in ([#563](https://github.com/wokshop/omni/issues/563)) ([b6dc388](https://github.com/wokshop/omni/commit/b6dc38843f05de268662e738c882345faf8806b4))
* **desktop:** turning on Drive sync signs in when the app's grant has no settings ([#573](https://github.com/wokshop/omni/issues/573)) ([882e1cf](https://github.com/wokshop/omni/commit/882e1cf5f5b8b4fc5423b832497d9c9f74c30560))


### Performance

* **desktop:** keep Mac sync memory flat and cut its round trips ([#584](https://github.com/wokshop/omni/issues/584)) ([50963c6](https://github.com/wokshop/omni/commit/50963c6e2c919056214aaccb8a9bca5812c08502))
