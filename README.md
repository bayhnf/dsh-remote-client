# DeepSeek Harness Remote

English | [中文](README.zh.md)

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on a server and use it from a Mac desktop app over SSH. It works the way Codex Desktop, Orca or VS Code Remote do: profiles, sessions, credentials, agents and files stay on the server, and the Mac only connects.

![Settings → Remote servers](docs/remote-servers.png)

- **Desktop app, not a browser tab.** It keeps the official window, inset traffic lights, sidebar vibrancy and native shortcuts. The Web UI renders its Desktop layout.
- **Many servers, one window.** Add servers in **Settings → Remote servers**, then switch with one click or Cmd+Alt+1…9.
- **One-click server setup.** **Set up server** installs only what is missing over SSH: `dsh`, the `dsh-tui` terminal UI, pnpm, a `server` profile and a systemd user service.
- **SSH only.** The service listens on `127.0.0.1`, and the app reaches it through `ssh -L`. Nothing is exposed to the network, and no relay is involved.
- **DeepSeek account sign-in works.** The page is served over loopback, which is the only callback origin the account plugin accepts.

This addresses the requests in [#12670](https://github.com/deepseek-ai/deepseek-harness/discussions/12670), [#9529](https://github.com/deepseek-ai/deepseek-harness/discussions/9529) and [#12110](https://github.com/deepseek-ai/deepseek-harness/discussions/12110). It is a community project, not affiliated with DeepSeek.

## How it works

```
Mac: DeepSeek Harness Remote.app ──ssh -L 127.0.0.1:43080──▶ server: dsh --profile server (127.0.0.1:3080)
                                 ──ssh -L 127.0.0.1:43081──▶ second server …
```

1. The app reads `remote.json`, picks the active server, and over SSH starts its `dsh-server.service` if needed. It then reads the newest `dsh web: http://…/?token=…` line from the server log.
2. It opens `ssh -N -L 127.0.0.1:<localPort>:<listener>`. Each server gets its own local port, so cookies and page storage never mix.
3. It loads `http://127.0.0.1:<localPort>/?token=…`. The server exchanges the token for a session cookie and serves its own Web UI.
4. If the tunnel drops, the app reconnects after 3 s. Cmd+Shift+R reconnects by hand.

The repository has two parts:

| Part | What it is |
|---|---|
| `app/` | The Electron client: tunnel, window, preload bridges, server switching. `build-mac.sh` turns it into `DeepSeek Harness Remote.app`. |
| `plugin/` | `dsh-remote-servers`, a DSH bundle that adds the **Remote servers** settings page. It installs on each server with `dsh plugin --profile server add`, and **Set up server** installs it for you. |

## Requirements

- **Mac:** macOS on Apple Silicon or Intel, Node.js (for `npx` during the build), and the official `DeepSeek Harness.app` installed once as the build source. You can uninstall it afterwards; see [Build](#build).
- **Server:** Linux with systemd, Node.js 22.19+, and key-based SSH from the Mac with no password prompt.

## Build

```sh
git clone https://github.com/<you>/dsh-remote-client && cd dsh-remote-client
(cd plugin && npm i --no-save esbuild && node build.mjs)   # builds the settings page bundle
./build-mac.sh                                               # -> ~/Applications/DeepSeek Harness Remote.app
```

`build-mac.sh` copies the official app and changes only the copy:

- It keeps DeepSeek's signed Electron runtime and icon, and removes the bundled local Host (`runtime/`, `app.asar.unpacked/`, auto-update).
- It packs `app/` as `app.asar` and uses its own bundle id (override it with `DSH_REMOTE_BUNDLE_ID`), so it runs beside the official app with separate storage.
- It signs the result ad hoc, so the build runs on the Mac that built it.

To uninstall the official app but keep building, save a copy first:

```sh
mkdir -p ~/dsh-remote-work
ditto -c -k --keepParent "/Applications/DeepSeek Harness.app" ~/dsh-remote-work/DeepSeek-Harness-<version>.app.zip
```

`build-mac.sh` uses the newest such zip when `/Applications/DeepSeek Harness.app` is absent. Rebuild after a new official release to pick up its Electron and Web UI.

## First run

1. Add your server to `~/.ssh/config`. The app starts with one placeholder entry named `dsh-server`:

   ```
   Host dsh-server
     HostName your.server.example
     User you
   ```

2. Open **DeepSeek Harness Remote**. If the server is not set up yet, open **Account menu → Settings → Remote servers** and click **Set up server**.
3. Add more servers on the same page. Use any `~/.ssh/config` alias (suggested as you type) or `user@host`.

| Action | Effect |
|---|---|
| Check | Reports Node, dsh, dsh-tui, the service state, and whether this page's bundle is installed |
| Set up server | Installs only what is missing; never upgrades an installed dsh or replaces an existing service |
| Switch | Closes the current tunnel and opens the chosen server in the same window |
| Remove | Removes the entry from this Mac only; nothing on the server is deleted |

Settings live in `~/Library/Application Support/DeepSeek Harness Remote/remote.json`. Every value is validated before it reaches the `ssh` command line or the remote shell, and the page can only refer to servers by id.

## Terminal and other clients

The server is a normal DSH install, so other clients use the same data. `dsh-tui` (installed by **Set up server**) works over SSH, and editors such as Orca detect it as **DeepSeek Harness**.

## Development

```sh
npm test                                                       # node --test: parsing, config validation, scripts
node vendor/build-desktop-keyboard.mjs <deepseek-harness checkout>   # refresh the bundled keyboard bridge
```

## Known limitations

- These bridges need the official app's local Host and are not provided: file save and drag-out to the Mac, the embedded usage/top-up page, update channels, and the native folder picker. The Web UI uses its own equivalents, including a directory browser for the server's folders.
- macOS only. The Electron client is cross-platform, but there is no Windows or Linux packaging script yet.
- The build is signed ad hoc. Distributing it to other Macs needs a Developer ID signature.

## License

MIT. Parts are ported from or bundle DeepSeek Harness (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
