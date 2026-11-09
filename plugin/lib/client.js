window.__ModuleLoader__.load({
	id: "dsh-remote-servers",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name2 in all)
		    __defProp(target, name2, { get: all[name2], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
		
		// src/client/index.tsx
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject,
		  name: () => name
		});
		module.exports = __toCommonJS(index_exports);
		
		// src/client/RemoteServersSection.tsx
		var import_react = require("react");
		var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		
		// src/client/RemoteServersSection.module.css
		var css = "/* Layout follows the official settings rows: 14/20 titles, 12/18 secondary copy, l2 hairlines. */\n\n.rs_page_ac24f9 {\n  display: flex;\n  flex-direction: column;\n  width: 100%;\n}\n\n.rs_header_ac24f9 {\n  padding-bottom: 16px;\n  border-bottom: 0.5px solid var(--dsw-alias-border-l2);\n}\n\n.rs_title_ac24f9 {\n  margin: 0;\n  color: var(--dsw-alias-label-primary);\n  font-size: 16px;\n  font-weight: 600;\n  line-height: 24px;\n}\n\n.rs_description_ac24f9,\n.rs_notice_ac24f9 {\n  margin: 4px 0 0;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  line-height: 18px;\n}\n\n.rs_notice_ac24f9 {\n  padding: 16px 0;\n}\n\n.rs_list_ac24f9 {\n  margin: 0;\n  padding: 0;\n  list-style: none;\n}\n\n.rs_row_ac24f9 {\n  display: flex;\n  align-items: flex-start;\n  justify-content: space-between;\n  gap: 24px;\n  padding: 16px 0;\n  border-bottom: 0.5px solid var(--dsw-alias-border-l2);\n}\n\n.rs_row_ac24f9[data-active] .rs_name_ac24f9 {\n  font-weight: 600;\n}\n\n.rs_identity_ac24f9 {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  min-width: 0;\n}\n\n.rs_nameLine_ac24f9 {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.rs_name_ac24f9 {\n  color: var(--dsw-alias-label-primary);\n  font-size: 14px;\n  line-height: 20px;\n}\n\n.rs_meta_ac24f9 {\n  overflow: hidden;\n  color: var(--dsw-alias-label-tertiary);\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n  line-height: 18px;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.rs_progress_ac24f9 {\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  line-height: 18px;\n}\n\n.rs_success_ac24f9 {\n  color: var(--dsw-alias-state-success-primary);\n  font-size: 12px;\n  line-height: 18px;\n}\n\n.rs_error_ac24f9 {\n  color: var(--dsw-alias-state-error-primary, #e5484d);\n  font-size: 12px;\n  line-height: 18px;\n  white-space: pre-wrap;\n}\n\n.rs_actions_ac24f9 {\n  display: flex;\n  flex-shrink: 0;\n  align-items: center;\n  gap: 8px;\n}\n\n.rs_add_ac24f9 {\n  padding: 20px 0 8px;\n}\n\n.rs_addTitle_ac24f9 {\n  margin: 0;\n  color: var(--dsw-alias-label-primary);\n  font-size: 14px;\n  font-weight: 600;\n  line-height: 20px;\n}\n\n.rs_fields_ac24f9 {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;\n  align-items: end;\n  gap: 12px;\n  margin-top: 12px;\n}\n\n.rs_field_ac24f9 {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.rs_label_ac24f9 {\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  line-height: 18px;\n}\n";
		if (typeof document !== "undefined" && !document.querySelector('style[data-dsh-remote-servers="ac24f9"]')) {
		  const tag = document.createElement("style");
		  tag.dataset.dshRemoteServers = "ac24f9";
		  tag.textContent = css;
		  document.head.appendChild(tag);
		}
		var RemoteServersSection_default = { "page": "rs_page_ac24f9", "header": "rs_header_ac24f9", "title": "rs_title_ac24f9", "description": "rs_description_ac24f9", "notice": "rs_notice_ac24f9", "list": "rs_list_ac24f9", "row": "rs_row_ac24f9", "name": "rs_name_ac24f9", "identity": "rs_identity_ac24f9", "nameLine": "rs_nameLine_ac24f9", "meta": "rs_meta_ac24f9", "progress": "rs_progress_ac24f9", "success": "rs_success_ac24f9", "error": "rs_error_ac24f9", "actions": "rs_actions_ac24f9", "add": "rs_add_ac24f9", "addTitle": "rs_addTitle_ac24f9", "fields": "rs_fields_ac24f9", "field": "rs_field_ac24f9", "label": "rs_label_ac24f9" };
		
		// src/client/RemoteServersSection.tsx
		var import_jsx_runtime = require("react/jsx-runtime");
		var IDLE = { kind: "idle" };
		var message = (error) => error instanceof Error ? error.message : String(error);
		function RemoteServersSection({ bridge, t }) {
		  if (bridge === void 0) {
		    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: RemoteServersSection_default.page, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, { t }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: RemoteServersSection_default.notice, children: t("browserOnly") })
		    ] });
		  }
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ManagedServers, { bridge, t });
		}
		function Header({ t }) {
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: RemoteServersSection_default.header, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: RemoteServersSection_default.title, children: t("title") }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: RemoteServersSection_default.description, children: t("description") })
		  ] });
		}
		function ManagedServers({ bridge, t }) {
		  const [config, setConfig] = (0, import_react.useState)(void 0);
		  const [loadError, setLoadError] = (0, import_react.useState)(void 0);
		  const [status, setStatus] = (0, import_react.useState)({});
		  const setHostStatus = (id2, next) => {
		    setStatus((current) => ({ ...current, [id2]: next }));
		  };
		  const probe = (0, import_react.useCallback)(async (id2) => {
		    setStatus((current) => ({ ...current, [id2]: { kind: "busy", text: t("checking") } }));
		    try {
		      const report = await bridge.probe(id2);
		      setStatus((current) => ({ ...current, [id2]: { kind: "probe", probe: report } }));
		    } catch (error) {
		      setStatus((current) => ({ ...current, [id2]: { kind: "error", text: t("failed", { message: message(error) }) } }));
		    }
		  }, [bridge, t]);
		  (0, import_react.useEffect)(() => {
		    let live = true;
		    bridge.list().then((value) => {
		      if (!live) return;
		      setConfig(value);
		      for (const host of value.hosts) void probe(host.id);
		    }, (error) => {
		      if (live) setLoadError(message(error));
		    });
		    return () => {
		      live = false;
		    };
		  }, [bridge, probe]);
		  const run = async (id2, busyText, action, doneText) => {
		    setHostStatus(id2, { kind: "busy", text: busyText });
		    try {
		      const next = await action();
		      if (next !== void 0) setConfig(next);
		      if (doneText !== void 0) setHostStatus(id2, { kind: "done", text: doneText });
		      else setHostStatus(id2, IDLE);
		    } catch (error) {
		      setHostStatus(id2, { kind: "error", text: t("failed", { message: message(error) }) });
		    }
		  };
		  if (loadError !== void 0) return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: RemoteServersSection_default.page, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, { t }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", className: RemoteServersSection_default.error, children: t("failed", { message: loadError }) })
		  ] });
		  if (config === void 0) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", { className: RemoteServersSection_default.page, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, { t }) });
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: RemoteServersSection_default.page, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, { t }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: RemoteServersSection_default.list, children: config.hosts.map((host) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      HostRow,
		      {
		        host,
		        active: host.id === config.activeHostId,
		        status: status[host.id] ?? IDLE,
		        t,
		        onCheck: () => {
		          void probe(host.id);
		        },
		        onSetup: () => {
		          void run(host.id, t("settingUp"), async () => {
		            await bridge.setup(host.id);
		            await probe(host.id);
		          }, t("setupDone"));
		        },
		        onSwitch: () => {
		          void run(host.id, t("checking"), () => bridge.switchTo(host.id));
		        },
		        onRemove: () => {
		          if (!window.confirm(t("removeConfirm", { name: host.name }))) return;
		          void bridge.remove(host.id).then(setConfig, (error) => {
		            setHostStatus(host.id, { kind: "error", text: t("failed", { message: message(error) }) });
		          });
		        }
		      },
		      host.id
		    )) }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AddServer, { bridge, t, onAdded: (next) => {
		      setConfig(next);
		      const added = next.hosts.at(-1);
		      if (added !== void 0) void probe(added.id);
		    } })
		  ] });
		}
		function HostRow({ host, active, status, t, onCheck, onSetup, onSwitch, onRemove }) {
		  const busy = status.kind === "busy";
		  const probe = status.kind === "probe" ? status.probe : void 0;
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: RemoteServersSection_default.row, "data-active": active || void 0, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: RemoteServersSection_default.identity, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: RemoteServersSection_default.nameLine, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: RemoteServersSection_default.name, children: host.name }),
		        active && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "solid", children: t("current") }),
		        probe !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: probe.ready ? "success" : "neutral", children: probe.ready ? t("ready") : t("notReady") })
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: RemoteServersSection_default.meta, children: [
		        host.sshHost,
		        " \xB7 127.0.0.1:",
		        host.localPort
		      ] }),
		      probe !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: RemoteServersSection_default.meta, children: t("details", {
		        dsh: probe.dsh || "\u2014",
		        node: probe.node || "\u2014",
		        unit: probe.unit,
		        tui: probe.dshTui ? t("yes") : t("no"),
		        page: probe.plugin ? t("yes") : t("no")
		      }) }),
		      status.kind === "busy" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: RemoteServersSection_default.progress, "aria-live": "polite", children: status.text }),
		      status.kind === "done" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: RemoteServersSection_default.success, "aria-live": "polite", children: status.text }),
		      status.kind === "error" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "alert", className: RemoteServersSection_default.error, children: status.text })
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: RemoteServersSection_default.actions, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", disabled: busy, onClick: onCheck, children: t("check") }),
		      probe !== void 0 && !probe.ready && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", disabled: busy, onClick: onSetup, children: t("setup") }),
		      !active && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", disabled: busy, onClick: onSwitch, children: t("switch") }),
		      !active && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", disabled: busy, onClick: onRemove, children: t("remove") })
		    ] })
		  ] });
		}
		function AddServer({ bridge, t, onAdded }) {
		  const [name2, setName] = (0, import_react.useState)("");
		  const [sshHost, setSshHost] = (0, import_react.useState)("");
		  const [aliases, setAliases] = (0, import_react.useState)([]);
		  const [busy, setBusy] = (0, import_react.useState)(false);
		  const [error, setError] = (0, import_react.useState)(void 0);
		  (0, import_react.useEffect)(() => {
		    let live = true;
		    bridge.sshConfigHosts().then((value) => {
		      if (live) setAliases(value);
		    }, () => {
		    });
		    return () => {
		      live = false;
		    };
		  }, [bridge]);
		  const submit = (event) => {
		    event.preventDefault();
		    if (sshHost.trim() === "") return;
		    setBusy(true);
		    setError(void 0);
		    bridge.add({ name: name2.trim() || sshHost.trim(), sshHost: sshHost.trim() }).then((next) => {
		      setName("");
		      setSshHost("");
		      onAdded(next);
		    }, (failure) => {
		      setError(t("failed", { message: message(failure) }));
		    }).finally(() => {
		      setBusy(false);
		    });
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { className: RemoteServersSection_default.add, onSubmit: submit, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: RemoteServersSection_default.addTitle, children: t("addTitle") }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: RemoteServersSection_default.description, children: t("addHint") }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: RemoteServersSection_default.fields, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: RemoteServersSection_default.field, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: RemoteServersSection_default.label, children: t("sshHost") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          import_dsh_client_ui_primitives.Input,
		          {
		            value: sshHost,
		            list: "dsh-remote-ssh-aliases",
		            placeholder: "my-server, user@host",
		            autoComplete: "off",
		            spellCheck: false,
		            onChange: (event) => {
		              setSshHost(event.currentTarget.value);
		            }
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("datalist", { id: "dsh-remote-ssh-aliases", children: aliases.map((alias) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: alias }, alias)) })
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: RemoteServersSection_default.field, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: RemoteServersSection_default.label, children: t("name") }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: name2, placeholder: sshHost || "My server", autoComplete: "off", onChange: (event) => {
		          setName(event.currentTarget.value);
		        } })
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { type: "submit", variant: "primary", size: "sm", disabled: busy || sshHost.trim() === "", children: t("add") })
		    ] }),
		    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "alert", className: RemoteServersSection_default.error, children: error })
		  ] });
		}
		
		// src/client/locales.ts
		var en = {
		  nav: "Remote servers",
		  title: "Remote servers",
		  description: "Each server runs DeepSeek Harness itself: profiles, sessions, credentials and files stay there. This app connects over SSH.",
		  current: "Current",
		  switch: "Switch",
		  check: "Check",
		  setup: "Set up server",
		  remove: "Remove",
		  removeConfirm: "Remove {name} from this list? Nothing on the server is deleted.",
		  addTitle: "Add a server",
		  addHint: "Use an alias from ~/.ssh/config or user@host. The server needs key-based SSH and Node.js 22.19+.",
		  name: "Name",
		  sshHost: "SSH host",
		  add: "Add",
		  ready: "Ready",
		  notReady: "Not set up",
		  checking: "Checking\u2026",
		  settingUp: "Installing DeepSeek Harness on the server\u2026",
		  setupDone: "Server is ready.",
		  failed: "Failed: {message}",
		  browserOnly: "Remote servers are managed from the DeepSeek Harness Remote desktop app. This browser tab shows one server only.",
		  details: "dsh {dsh} \xB7 Node {node} \xB7 service {unit} \xB7 dsh-tui {tui} \xB7 page {page}",
		  yes: "yes",
		  no: "no",
		  sshAliases: "From ~/.ssh/config"
		};
		var id = {
		  nav: "Server remote",
		  title: "Server remote",
		  description: "Setiap server menjalankan DeepSeek Harness sendiri: profil, sesi, kredensial, dan file tetap di sana. Aplikasi ini terhubung lewat SSH.",
		  current: "Aktif",
		  switch: "Pindah",
		  check: "Cek",
		  setup: "Siapkan server",
		  remove: "Hapus",
		  removeConfirm: "Hapus {name} dari daftar? Tidak ada yang dihapus di server.",
		  addTitle: "Tambah server",
		  addHint: "Pakai alias dari ~/.ssh/config atau user@host. Server butuh SSH berbasis key dan Node.js 22.19+.",
		  name: "Nama",
		  sshHost: "Host SSH",
		  add: "Tambah",
		  ready: "Siap",
		  notReady: "Belum disiapkan",
		  checking: "Mengecek\u2026",
		  settingUp: "Memasang DeepSeek Harness di server\u2026",
		  setupDone: "Server siap.",
		  failed: "Gagal: {message}",
		  browserOnly: "Server remote dikelola dari aplikasi desktop DeepSeek Harness Remote. Tab browser ini hanya menampilkan satu server.",
		  details: "dsh {dsh} \xB7 Node {node} \xB7 service {unit} \xB7 dsh-tui {tui} \xB7 page {page}",
		  yes: "ya",
		  no: "tidak",
		  sshAliases: "Dari ~/.ssh/config"
		};
		var zh = {
		  nav: "\u8FDC\u7A0B\u670D\u52A1\u5668",
		  title: "\u8FDC\u7A0B\u670D\u52A1\u5668",
		  description: "\u6BCF\u53F0\u670D\u52A1\u5668\u5404\u81EA\u8FD0\u884C DeepSeek Harness\uFF1A\u914D\u7F6E\u3001\u4F1A\u8BDD\u3001\u51ED\u636E\u548C\u6587\u4EF6\u90FD\u4FDD\u7559\u5728\u670D\u52A1\u5668\u4E0A\u3002\u672C\u5E94\u7528\u901A\u8FC7 SSH \u8FDE\u63A5\u3002",
		  current: "\u5F53\u524D",
		  switch: "\u5207\u6362",
		  check: "\u68C0\u67E5",
		  setup: "\u914D\u7F6E\u670D\u52A1\u5668",
		  remove: "\u79FB\u9664",
		  removeConfirm: "\u4ECE\u5217\u8868\u4E2D\u79FB\u9664 {name}\uFF1F\u670D\u52A1\u5668\u4E0A\u7684\u5185\u5BB9\u4E0D\u4F1A\u88AB\u5220\u9664\u3002",
		  addTitle: "\u6DFB\u52A0\u670D\u52A1\u5668",
		  addHint: "\u4F7F\u7528 ~/.ssh/config \u4E2D\u7684\u522B\u540D\u6216 user@host\u3002\u670D\u52A1\u5668\u9700\u8981\u57FA\u4E8E\u5BC6\u94A5\u7684 SSH \u548C Node.js 22.19+\u3002",
		  name: "\u540D\u79F0",
		  sshHost: "SSH \u4E3B\u673A",
		  add: "\u6DFB\u52A0",
		  ready: "\u5C31\u7EEA",
		  notReady: "\u672A\u914D\u7F6E",
		  checking: "\u68C0\u67E5\u4E2D\u2026",
		  settingUp: "\u6B63\u5728\u670D\u52A1\u5668\u4E0A\u5B89\u88C5 DeepSeek Harness\u2026",
		  setupDone: "\u670D\u52A1\u5668\u5DF2\u5C31\u7EEA\u3002",
		  failed: "\u5931\u8D25\uFF1A{message}",
		  browserOnly: "\u8FDC\u7A0B\u670D\u52A1\u5668\u5728 DeepSeek Harness Remote \u684C\u9762\u5E94\u7528\u4E2D\u7BA1\u7406\u3002\u6B64\u6D4F\u89C8\u5668\u6807\u7B7E\u9875\u53EA\u663E\u793A\u4E00\u53F0\u670D\u52A1\u5668\u3002",
		  details: "dsh {dsh} \xB7 Node {node} \xB7 \u670D\u52A1 {unit} \xB7 dsh-tui {tui} \xB7 \u9875\u9762 {page}",
		  yes: "\u662F",
		  no: "\u5426",
		  sshAliases: "\u6765\u81EA ~/.ssh/config"
		};
		var dictionaries = { en, id, zh };
		
		// src/client/index.tsx
		var name = "dsh-remote-servers";
		var inject = ["slots", "locale"];
		function apply(ctx) {
		  ctx.effect(() => ctx.locale.register("settings.remoteServers", dictionaries), "remote servers: dictionaries");
		  const t = ctx.locale.bind("settings.remoteServers");
		  const bridge = globalThis.dshRemote;
		  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
		    name: "settings.section",
		    id: "remote-servers",
		    order: 15,
		    label: () => t("nav"),
		    locale: "settings.remoteServers",
		    inject: () => ({ bridge })
		  }, RemoteServersSection)), "remote servers: settings page");
		}
		
		return module.exports;
	}
});
