# Tilt Grand Prix — OpenControl racing

React racing game where phones are the controllers: tilt to steer, triggers
for gas/brake, A for nitro. Built on
[`@opencontrol/sdk`](https://github.com/Bosco98/Opn-gamedeck), vendored as a
tarball in `vendor/` — the repo is fully self-contained.

## Play

- **Standalone:** `npm install && npm run dev`, open the printed Network URL
  on a big screen, scan the QR with your phone. (Tilt needs HTTPS or
  localhost on iOS — the deployed GitHub Pages build has HTTPS for free.)
- **As an Opn-gamedeck cartridge:** the deck loads this page in an iframe with
  `?oc=console`; the SDK bridges to the console automatically and players are
  injected with no re-scan. This repo's GitHub Pages URL is what goes in the
  deck's `games.json` (profile: `tilt`).

## Deploy

Pushing to `main` builds and deploys to GitHub Pages via Actions.

## Updating the SDK

Drop a new `npm pack` tarball into `vendor/`, update the version in
`package.json`, and run `npm install`.
