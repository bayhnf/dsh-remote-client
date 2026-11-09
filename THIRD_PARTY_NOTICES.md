# Third-party notices

## DeepSeek Harness

`app/vendor/desktop-keyboard.js` is bundled, unmodified except for one sender-origin check, from
`apps/desktop/src/keyboard.ts` and the `@deepseek-ai/dsh-client-shortcuts`, `dsh-atomic-write`,
`dsh-util-values`, `dsh-util-crypto` and `dsh-brand` sources of
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
`vendor/build-desktop-keyboard.mjs` regenerates it and documents the change.

Several smaller pieces of `app/` port the behavior of the official desktop shell
(`preload-app.ts`, `preload-platform.ts`, `preload-theme.ts`, `account-backend.ts`,
`welcome-backend.ts`, `device-info.ts`); each file names its source.

`build-mac.sh` reuses the Electron runtime and icon of an installed official
`DeepSeek Harness.app`; this repository does not redistribute either.

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
