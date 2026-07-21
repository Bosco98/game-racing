# Tilt Grand Prix — OpenControl racing

React racing game where phones are the controllers: tilt to steer, triggers
for gas/brake, A for nitro. Built on
[`@bosco98/opencontrol-sdk`](https://github.com/Bosco98/Opn-gamedeck),
installed from GitHub Packages.

## Play

- **Standalone:** `npm install && npm run dev`, open the printed Network URL
  on a big screen, scan the QR with your phone. (Tilt needs HTTPS or
  localhost on iOS — the deployed GitHub Pages build has HTTPS for free.)
- **As an Opn-gamedeck cartridge:** the deck loads this page in an iframe with
  `?oc=console`; the SDK bridges to the console automatically and players are
  injected with no re-scan. This repo's GitHub Pages URL is what goes in the
  deck's `games.json` (profile: `tilt`).

## Deploy

Pushing to `main` builds and deploys to GitHub Pages via Actions (CI
authenticates to GitHub Packages with the built-in `GITHUB_TOKEN`).

## The SDK dependency

`@bosco98/opencontrol-sdk` lives on GitHub Packages, which requires auth even
for public packages. For local installs either:

- add a token with `read:packages` to `~/.npmrc`:
  `//npm.pkg.github.com/:_authToken=YOUR_TOKEN`, or
- develop against a local SDK checkout:
  `cd ../sdk && npm link && cd - && npm link @bosco98/opencontrol-sdk`.
