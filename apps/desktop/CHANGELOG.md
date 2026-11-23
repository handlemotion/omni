# Changelog

## [0.8.0](https://github.com/wokshop/omni/compare/desktop-v0.7.0...desktop-v0.8.0) (2026-11-23)


### Features

* **ios:** Drive cards with content previews, spaces menu, and a fading top bar ([#901](https://github.com/wokshop/omni/issues/901)) ([7c54e20](https://github.com/wokshop/omni/commit/7c54e20fede63731db349168617574438e99f85a))

## [0.7.0](https://github.com/wokshop/omni/compare/desktop-v0.6.0...desktop-v0.7.0) (2026-11-23)


### Features

* **ios:** bottom module dock, reveal drawer, calendar placeholder, and sign-in refresh ([#897](https://github.com/wokshop/omni/issues/897)) ([2cac6bf](https://github.com/wokshop/omni/commit/2cac6bf49677f99abca34191408a0c25c6ffffef))

## [0.6.0](https://github.com/wokshop/omni/compare/desktop-v0.5.0...desktop-v0.6.0) (2026-11-23)


### Features

* **desktop:** Windows drops the native title bar; the web app draws minimize, maximize and close ([#892](https://github.com/wokshop/omni/issues/892)) ([390dfca](https://github.com/wokshop/omni/commit/390dfca80c89c0377eb478e18cd9bbe7f2cfa7ba))


### Fixes

* **db:** a Personal space holding a domain survives the sign-up sweep, and one its owner left stays with its people ([#884](https://github.com/wokshop/omni/issues/884)) ([531db22](https://github.com/wokshop/omni/commit/531db2234a75cb3d8ae9944ba678490f0a98488a))
* **desktop:** installer downloads keep their release names ([#885](https://github.com/wokshop/omni/issues/885)) ([b2e446b](https://github.com/wokshop/omni/commit/b2e446beddcfe1a969e97a62d9c59eb0c8e8edc1))

## [0.5.0](https://github.com/wokshop/omni/compare/desktop-v0.4.0...desktop-v0.5.0) (2026-11-22)


### Features

* **desktop:** each space you're in syncs as its own folder in Finder ([#803](https://github.com/wokshop/omni/issues/803)) ([511464c](https://github.com/wokshop/omni/commit/511464ca5a4cb70e6df3ad59d84fcd4dacf163d7))
* **desktop:** the meeting recorder's capture and crash-safe spool ([#841](https://github.com/wokshop/omni/issues/841)) ([f10571d](https://github.com/wokshop/omni/commit/f10571df44580bf8992ebdba4e5b5e7afeea44ff))
* **desktop:** the recording pill, Record Now in the tray and the meeting-start notification ([#846](https://github.com/wokshop/omni/issues/846)) ([3a01673](https://github.com/wokshop/omni/commit/3a016734b9366f6dc826afd168bb9467e425ab3d))
* **drive:** fit seven cards beside the sidebar, draw folders as blue pockets ([#785](https://github.com/wokshop/omni/issues/785)) ([082a44d](https://github.com/wokshop/omni/commit/082a44df3a918f93a794cbf735ed855de9b1492a))


### Fixes

* **desktop:** satisfy clippy's chunks_exact_to_as_chunks in the recorder ([#853](https://github.com/wokshop/omni/issues/853)) ([cacabae](https://github.com/wokshop/omni/commit/cacabae2478f7f2f0e4ff5ee3252e040e49d6e0e))
* **desktop:** the recorder shell never cuts a spool it is writing, and retires a capture that ends by itself ([#856](https://github.com/wokshop/omni/issues/856)) ([0599b71](https://github.com/wokshop/omni/commit/0599b714e3c9f43572bd50a2bdc05a87dd70239c))
* **desktop:** the recorder survives newer Clippy, a slow macOS start, an expired upload and a repeated stop ([#854](https://github.com/wokshop/omni/issues/854)) ([36df5b1](https://github.com/wokshop/omni/commit/36df5b12335118aa533910306a98e42e2ea0f7fd))


### Performance

* **web:** Talk notes arrive and send without refetching the thread ([#787](https://github.com/wokshop/omni/issues/787)) ([61463e9](https://github.com/wokshop/omni/commit/61463e9e10d263f935487ffbf50db71d96030023))
* **worker:** calendar reads in fewer round trips; the web calendar loads its weeks ahead ([#788](https://github.com/wokshop/omni/issues/788)) ([c391c98](https://github.com/wokshop/omni/commit/c391c98451ef3bc56d1ec97d408d6a4c1be4aaf7))

## [0.4.0](https://github.com/wokshop/omni/compare/desktop-v0.3.0...desktop-v0.4.0) (2026-11-22)


### Features

* **desktop:** a module rail down the window's left edge replaces the sidebar's module switcher ([#691](https://github.com/wokshop/omni/issues/691)) ([d32996d](https://github.com/wokshop/omni/commit/d32996db4da66995cfd08632c6d75795aad29269))
* **desktop:** Windows 10 and 11 release, with its own update feed and taskbar badge ([#697](https://github.com/wokshop/omni/issues/697)) ([2cf8e63](https://github.com/wokshop/omni/commit/2cf8e63b5a9144bf250de7cfed5ced084ceed7ef))
* **drive:** teamspaces: members, open or private, through the member door and the API ([#736](https://github.com/wokshop/omni/issues/736)) ([88b3bc3](https://github.com/wokshop/omni/commit/88b3bc37d8c9ae98cdf08d9e413205922751293d))

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
