<!--
Base branch: dev. Hotfixes and releases only: main.
目标分支选 dev。只有热修和发版才选 main。
-->

## Issue

Fixes #

## What changed / 改了什么



## Changelog

<!-- One sentence that users will notice, or "none". Do not edit CHANGELOG.md. / 一句用户能看到的变化，没有写「无」。不要改 CHANGELOG.md。 -->



## How I checked it / 怎么验证的

- [ ] `npm test` (in `ds-bot/`)
- [ ] `node scripts/build-office.mjs --check`
- [ ] `npm run lint`
- [ ] Screenshot attached, for interface changes / 界面改动已附截图

## Checklist / 检查

- [ ] One issue, one subject. / 只做一件事。
- [ ] `src/office/` changed → `npm run build` ran and `office.js` is committed. / 改了 `src/office/` 就已重新 build 并提交 `office.js`。
- [ ] No keys, tokens or personal data, also in screenshots. / 没有密钥、token 或个人信息，截图里也没有。
- [ ] No AI tool as author or `Co-authored-by`. / 没有把 AI 工具写成作者或 `Co-authored-by`。
