# Linux desktop package: one AppImage for all, plus a deb fallback

- Date: 2026-10-21
- Related: #410

## Why

The desktop app had only two packages, Windows (NSIS) and macOS (zip). If Linux got a separate deb/rpm/pacman for each distribution, every new format would add one more line to maintain, and none of these formats supports in-app auto-update.

## Decided behavior

- Linux gets only two packages, both from the same `npm run dist`: **AppImage** (the main package, one file that runs on every glibc distribution) plus **deb** (the Debian/Ubuntu fallback). No rpm/pacman/Flatpak/Snap, and no per-distribution packages.
- AppImage is the only Linux format that electron-updater supports natively: it reads `latest-linux.yml`, downloads in the background and replaces itself on exit, sharing the `watchUpdates` path with Windows.
- deb cannot update itself: it shares the `watchReleases` release-page reminder path with macOS, and the asset it waits for is `linux-amd64.deb` (so `watchReleases` gained an `asset` parameter; the default is still the mac zip).
- File names follow Linux conventions instead of the `${arch}` literal: the AppImage is `linux-x86_64` and the deb is `linux-amd64` (electron-builder's architecture name mapping for Linux targets; consistent with precedents such as IPFS Desktop). That is why `main.mjs` and `check-update.mjs` map x64 to amd64.
- `main.mjs` uses the `APPIMAGE` environment variable to tell the update paths of the two Linux formats apart.
- Flatpak/Snap are not chosen: the app has to run pnpm on the host to install plugins, open real terminals with node-pty, and read `~/.dsh` to import the team, which conflicts directly with the sandbox (`flatpak-spawn --host` empties the sandbox; Snap's classic confinement needs special store approval, and non-Ubuntu distributions widely resist it). Precedent: IPFS Desktop dropped Snap over confinement problems and promotes AppImage.
- Known pitfalls go into the README: AppImage needs FUSE 2 (on Ubuntu 24.04+/Debian 13+ install `libfuse2t64`); Ubuntu 24.04+ AppArmor restricts unprivileged user namespaces, which blocks the Chromium sandbox inside the AppImage. The deb does not have this problem (post-install sets up `chrome-sandbox`, and electron-builder 26 and later generate an AppArmor profile automatically).
- x64 only; arm64 is later work, once a `linux/arm64` prebuilt chain (node-pty and others) is confirmed.
- The binary and the menu entry are named `dsbot` (`executableName`), and the deb installs into `/opt/DS Bot`.

## CI

- `test.yml` adds `app-package-linux`: build, `check-packed` under xvfb, deb install/check/update reminder/uninstall, and AppImage self-update end to end (after exit, the file's sha512 equals the new version). The runner sets `sysctl kernel.apparmor_restrict_unprivileged_userns=0` and installs `libfuse2t64` (a one-off throwaway environment, so the security cost is acceptable).
- `release.yml` adds an `app-linux` job: it attaches the AppImage (with its `.blockmap`), the deb and `latest-linux.yml` to the release.
- The `needs` of the `result` summary job also adds `app-package-linux`.

- 2026-11-01: the program and package name became dsbot; the deb declares that it replaces and conflicts with the old package, so installing the new package makes the package manager remove the old program, and user data is kept.
