## Unreleased

## 3.2.14 (2025-02-17)

Fix a bug where `avo status` would fail if some files in the target directory can not be read or parsed

## 3.2.13 (2024-11-21)

Improve pull error mesages

## 3.2.11 (2024-03-06)

Replace outdated yuralist reporter with a custom one

## 3.2.10 (2024-02-16)

More info in the verbose logs

## 3.2.9 (2024-02-13)

Improve error messages

## 3.2.8 (2023-10-13)

Update dependencies
Wrap post-install script in try-catch to prevent unexpected errors during installation

## 3.2.7-beta.1 (2023-02-21)

Update dependencies
Better cross-platform support for post install step

## 3.2.7-beta.0 (2023-01-23)

Update dependencies
Better support for UNC paths on Windows

## 3.2.6 (2023-01-10)

Revert shebang removal

## 3.2.5 (2023-01-10)

Update dependencies
Remove unused shebang line

## 3.2.4 (2022-12-14)

Fix bug causing `avo pull "[source]"` to fail when it's the first source

## 3.2.3 (2022-11-22)

Fix bug in `avo pull` where when `--branch` wasn't supplied as a parameter

## 3.2.2 (2022-08-12)

More helpful message when receiving a 403 server error
Add instructions on how to get available features to force to `avo pull --help`

## 3.2.1 (2022-08-12)

Downgrade Inquirer to version 8, fixing an issue with `npm install`

## 3.2.0 (2022-08-01)

Allow to provide separate file paths for the interface files.

## 3.1.1 (2022-07-28)

Improved error messages.

## 3.1.0 (2022-07-28)

Added a 'forceFeatures' flag to the 'avo pull' command. You can provide a comma separated list of features you'd like to force enable.

## 3.0.0 (2022-07-06)

This is mainly a security update and it includes no new or modified functionality. The only breaking change is a requirement for Node >= 14.16. If you are unable to match that, the last version of avo will continue to work.

- CodeGen Avo Functions as TypeScript for stronger typing

This is mainly a security and hardening update and it includes no new or modified functionality. The only breaking change is a requirement for Node >= 14.16. If you are unable to match that, the last version of avo will continue to work.

- Breaking: Replace 'request' with 'got' for better security. Requires Node >= 14.16
- Bump dependencies to resolve security issues
- Add a hat to all dependencies for more dependency resolution flexibility

## 2.0.2 (2021-11-16)

- Fix a bug causing --version to return incorrect version number

## 2.0.0 (2021-11-16)

- Convert package to [pure ESM](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c)
- Update dependencies

### Breaking changes

- Minimum required Node version ^12.20.0 || ^14.13.1 || >=16.0.0

## 1.8.0 (2021-11-11)

- Update dependencies

## [1.5.1](https://github.com/avohq/avo/compare/1.5.0...1.5.1) (2021-03-16)

- Fix a bug preventing users from being not able to pick a location for their avo.json file

## [1.5.0](https://github.com/avohq/avo/compare/1.4.2...1.5.0) (2021-03-16)

- Rename the master branch to main
- Update dependencies
- Faster autocompletion in big projects

## [1.4.2](https://github.com/avohq/avo/compare/1.4.1...1.4.2) (2020-06-10)

## [1.4.1](https://github.com/avohq/avo/compare/1.4.1-beta.0...1.4.1) (2019-11-20)

## [1.4.1-beta.0](https://github.com/avohq/avo/compare/1.4.0...1.4.1-beta.0) (2019-11-20)

### Bug Fixes

- Fix postinstall crash on Windows ([8b13c83](https://github.com/avohq/avo/commit/8b13c83))

# [1.4.0](https://github.com/avohq/avo/compare/1.4.0-beta.3...1.4.0) (2019-10-29)

# [1.4.0-beta.3](https://github.com/avohq/avo/compare/1.4.0-beta.2...1.4.0-beta.3) (2019-10-21)

### Bug Fixes

- Updated analytics for merge conflict resolver ([07b0958](https://github.com/avohq/avo/commit/07b0958))

# [1.4.0-beta.2](https://github.com/avohq/avo/compare/1.4.0-beta.1...1.4.0-beta.2) (2019-10-21)

### Bug Fixes

- Fix authentication when resolving merge conflicts ([efda141](https://github.com/avohq/avo/commit/efda141))

# [1.4.0-beta.1](https://github.com/avohq/avo/compare/1.4.0-beta.0...1.4.0-beta.1) (2019-10-21)

# [1.4.0-beta.0](https://github.com/avohq/avo/compare/1.3.6...1.4.0-beta.0) (2019-10-21)

### Features

- Resolve simple merge conflicts in Avo files automatically ([886cc7f](https://github.com/avohq/avo/commit/886cc7f))

## [1.3.6](https://github.com/avohq/avo/compare/1.3.5...1.3.6) (2019-08-21)

### Bug Fixes

- Request and handle gzipped responses ([c108ccf](https://github.com/avohq/avo/commit/c108ccf))

## [1.3.5](https://github.com/avohq/avo/compare/1.3.4...1.3.5) (2019-07-01)

### Bug Fixes

- Suggest a command if provided command is unknown ([24f9345](https://github.com/avohq/avo/commit/24f9345))

## [1.3.4](https://github.com/avohq/avo/compare/1.3.3...1.3.4) (2019-07-01)

### Bug Fixes

- Fixes issue where switching branch doesn't carry which source is being generated ([f851f0e](https://github.com/avohq/avo/commit/f851f0e))

## [1.3.3](https://github.com/avohq/avo/compare/1.3.2...1.3.3) (2019-04-05)

### Bug Fixes

- Prevent crash if analytics endpoint fails ([a38e608](https://github.com/avohq/avo/commit/a38e608))

## [1.3.2](https://github.com/avohq/avo/compare/1.3.1...1.3.2) (2019-03-10)

### Bug Fixes

- Use object.assign instead of spread syntax ([1b50034](https://github.com/avohq/avo/commit/1b50034))

## [1.3.1](https://github.com/avohq/avo/compare/1.3.0...1.3.1) (2019-02-26)

### Bug Fixes

- Fix module map parsing for multi-line comments ([eb9796b](https://github.com/avohq/avo/commit/eb9796b))

# [1.3.0](https://github.com/avohq/avo/compare/1.2.4...1.3.0) (2019-02-25)

### Features

- Read analytics wrapper module name from source file ([3867652](https://github.com/avohq/avo/commit/3867652))

## [1.2.4](https://github.com/avohq/avo/compare/1.2.3...1.2.4) (2019-02-18)

## [1.2.3](https://github.com/avohq/avo/compare/1.2.2...1.2.3) (2019-02-18)

## [1.2.2](https://github.com/avohq/avo/compare/1.2.1...1.2.2) (2019-02-18)

## [1.2.1](https://github.com/avohq/avo/compare/1.2.0...1.2.1) (2019-02-17)

### Bug Fixes

- Non-destructive changes to sources json when pulling ([171851e](https://github.com/avohq/avo/commit/171851e))

# [1.2.0](https://github.com/avohq/avo/compare/1.1.2...1.2.0) (2019-02-17)

### Features

- avo status with simple linting ([#2](https://github.com/avohq/avo/issues/2)) ([51adb92](https://github.com/avohq/avo/commit/51adb92))

## [1.1.2](https://github.com/avohq/avo/compare/1.1.1...1.1.2) (2019-02-16)

### Bug Fixes

- avo pull source does not pull all sources if it is missing ([80c1048](https://github.com/avohq/avo/commit/80c1048))

## [1.1.1](https://github.com/avohq/avo/compare/1.1.0...1.1.1) (2019-02-12)

# [1.1.0](https://github.com/avohq/avo/compare/1.0.1...1.1.0) (2019-02-12)

### Features

- Add avo status command ([9d32c1f](https://github.com/avohq/avo/commit/9d32c1f))

## [1.0.1](https://github.com/avohq/avo/compare/1.0.0...1.0.1) (2019-01-18)

# 1.0.0 (2019-01-18)
