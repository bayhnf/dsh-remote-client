# dsh-remote-servers

A DeepSeek Harness bundle that adds **Settings → Remote servers**: list, check, set up, switch between and remove the SSH hosts that run DeepSeek Harness. It is part of [DeepSeek Harness Remote](../README.md).

```sh
dsh plugin --profile server add ./plugin    # or the packed tarball; "Set up server" does this for you
```

The page needs the `window.dshRemote` bridge, which the **DeepSeek Harness Remote** desktop app provides. In a plain browser tab it shows a short notice instead, because servers are managed from the app.

- Host half: empty (`lib/index.js`); the page needs no Host service.
- Browser half: `lib/client.js`, a lazy factory for the client module system. It uses only the shared React, slots and primitives modules.
- Copy: English, Indonesian, Chinese.

Build with `node build.mjs`; esbuild must be resolvable.
