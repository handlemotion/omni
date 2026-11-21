# Changelog

## [0.3.0](https://github.com/wokshop/omni/compare/desktop-v0.2.1...desktop-v0.3.0) (2026-11-21)


### Features

* **desktop:** a blue Restart to update strip in the sidebar, and Check for Updates in the menus ([#689](https://github.com/wokshop/omni/issues/689)) ([723586d](https://github.com/wokshop/omni/commit/723586dd8b3bc9c53c863251664abf1ebaf10dea))
* **drive:** Omni docs, their own file type with a toolbar, doc bar and Export ([#686](https://github.com/wokshop/omni/issues/686)) ([f406837](https://github.com/wokshop/omni/commit/f4068376363ee22891a3cbb3c4bd693c8cf71f8c))

## [0.2.1](https://github.com/wokshop/omni/compare/desktop-v0.2.0...desktop-v0.2.1) (2026-11-21)


### Fixes

* **crm:** list leads and won deals on the Projects page, as the sidebar does ([#674](https://github.com/wokshop/omni/issues/674)) ([398ef01](https://github.com/wokshop/omni/commit/398ef01ce9e1dea6a3893e9a9db0dd43ad7bcdfc))
* **desktop:** Drive sync sign-in finishes instead of a 403 on the token request ([#683](https://github.com/wokshop/omni/issues/683)) ([965a94e](https://github.com/wokshop/omni/commit/965a94eed76f432e1290b319cad4a71d8f9e7bba))
* **web:** give company descriptions the room the name column took ([#675](https://github.com/wokshop/omni/issues/675)) ([7ad2b74](https://github.com/wokshop/omni/commit/7ad2b74836aa0f805a49ea9ac7b8850c6a1411b5))
* **web:** space out CRM timeline events ([#672](https://github.com/wokshop/omni/issues/672)) ([05adbe6](https://github.com/wokshop/omni/commit/05adbe6aa0154615f4178c59c6270829834a8452))

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
