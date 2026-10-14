// Secondary dialogs: password generator, KeePass import, sharing, settings, help.

import { h, icon, clear, dialog, copyText, settings, saveSettings, readFile, formatBytes, formatDate, progressDialog, alertDialog, OPTION_KEYS, DEFAULT_SETTINGS as DEFAULTS, ACCENTS } from "./ui.js";
import { generatePassword, passwordEntropy } from "./bwcrypto.js";
import { openKeePass, convertKeePass, DEFAULT_OPTIONS } from "./keepass.js";
import { importEntries } from "./importer.js";

// ----- Password generator ------------------------------------------------------------------------

const GEN_KEY = "vwm.generator";

// The password generator. Opened on its own (`standalone`) it is a window with a copy button,
// from the entry editor a dialog which returns the chosen password.
export function generatorDialog({ standalone = false } = {}) {
    let opts = { length: 20, upper: true, lower: true, digits: true, special: true, extended: false, avoidAmbiguous: true };
    try {
        opts = { ...opts, ...JSON.parse(localStorage.getItem(GEN_KEY) || "{}") };
    } catch {
        /* defaults */
    }
    return dialog({
        title: "Password Generator",
        window: standalone,
        key: standalone ? "generator" : null,
        kind: standalone ? "generator" : null,
        icon: icon("key"),
        build: (close) => {
            const out = h("input", { type: "text", class: "wide mono gen-output", readonly: true });
            const bits = h("span", { class: "muted" });
            const regenerate = () => {
                try {
                    out.value = generatePassword(opts);
                    bits.textContent = `~${passwordEntropy(out.value)} bits`;
                } catch (e) {
                    out.value = "";
                    bits.textContent = e.message;
                }
                try {
                    localStorage.setItem(GEN_KEY, JSON.stringify(opts));
                } catch {
                    /* ignore */
                }
            };
            const len = h("input", { type: "number", min: 4, max: 256, value: opts.length, class: "narrow" });
            const slider = h("input", { type: "range", min: 4, max: 128, value: Math.min(opts.length, 128) });
            const setLen = (v) => {
                opts.length = Math.max(4, Math.min(256, parseInt(v, 10) || 20));
                len.value = opts.length;
                slider.value = Math.min(opts.length, 128);
                regenerate();
            };
            len.addEventListener("input", () => setLen(len.value));
            slider.addEventListener("input", () => setLen(slider.value));
            const check = (key, label) => {
                const cb = h("input", { type: "checkbox", checked: opts[key] });
                cb.addEventListener("change", () => {
                    opts[key] = cb.checked;
                    regenerate();
                });
                return h("label", { class: "check" }, cb, label);
            };
            regenerate();
            return {
                body: h(
                    "div",
                    { class: "form" },
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Length:"), h("div", { class: "form-controls" }, slider, len)),
                    h(
                        "div",
                        { class: "gen-sets" },
                        check("upper", "Upper-case (A-Z)"),
                        check("lower", "Lower-case (a-z)"),
                        check("digits", "Digits (0-9)"),
                        check("special", "Special (!@#$%^&*)"),
                        check("extended", "Brackets & punctuation"),
                        check("avoidAmbiguous", "Avoid look-alike characters (l, 1, O, 0, I)"),
                    ),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Password:"), h("div", { class: "form-controls" }, out, h("button", { type: "button", class: "icon-btn", title: "Generate again", onclick: regenerate }, icon("dice")), h("button", { type: "button", class: "icon-btn", title: "Copy", onclick: () => copyText(out.value, "Password") }, icon("copy")))),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, ""), bits),
                ),
                buttons: [
                    standalone
                        ? h("button", { type: "button", class: "primary", onclick: () => copyText(out.value, "Password") }, "Copy")
                        : h("button", { type: "button", class: "primary", onclick: () => close(out.value) }, "Use password"),
                    h("button", { type: "button", onclick: () => close(undefined) }, "Close"),
                ],
                onEnter: () => close(out.value),
            };
        },
    });
}

// ----- KeePass import ----------------------------------------------------------------------------

export async function importKeePassDialog(app) {
    const vault = app.vault;
    let converted = null;
    let db = null;

    const step1 = await dialog({
        title: "Import KeePass database",
        width: "560px",
        build: (close) => {
            const fileInput = h("input", { type: "file", accept: ".kdbx,.xml,application/xml,text/xml" });
            const pw = h("input", { type: "password", class: "wide", autocomplete: "off", placeholder: "Master password of the KeePass database" });
            const keyFile = h("input", { type: "file" });
            const err = h("div", { class: "form-error", role: "alert" });
            const openBtn = h("button", { type: "button", class: "primary" }, "Open");
            const open = async () => {
                err.textContent = "";
                const file = fileInput.files[0];
                if (!file) {
                    err.textContent = "Choose a .kdbx file or a KeePass XML export.";
                    return;
                }
                openBtn.disabled = true;
                openBtn.textContent = "Opening…";
                try {
                    const data = await readFile(file);
                    const key = keyFile.files[0] ? await readFile(keyFile.files[0]) : null;
                    db = await openKeePass(data, pw.value, key);
                    close({ fileName: file.name });
                } catch (e) {
                    console.error(e);
                    err.textContent = e.message || String(e);
                    openBtn.disabled = false;
                    openBtn.textContent = "Open";
                }
            };
            openBtn.addEventListener("click", open);
            return {
                body: h(
                    "div",
                    { class: "form" },
                    h("p", { class: "muted" }, "The database is opened and encrypted in this browser. Your KeePass password and the plain text data are never sent to the server."),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Database:"), h("div", { class: "form-controls" }, fileInput)),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Password:"), h("div", { class: "form-controls" }, pw)),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Key file:"), h("div", { class: "form-controls" }, keyFile, h("span", { class: "muted" }, "(optional)"))),
                    h("p", { class: "muted small" }, "Supports KDBX 3.1 and 4.x (AES / ChaCha20, AES-KDF / Argon2d / Argon2id). For other formats export 'KeePass XML (2.x)' from KeePass and import that file (no password needed)."),
                    err,
                ),
                buttons: [openBtn, h("button", { type: "button", onclick: () => close(undefined) }, "Cancel")],
                onEnter: open,
                initialFocus: fileInput,
            };
        },
    });
    if (!step1 || !db) return;

    const options = { ...DEFAULT_OPTIONS, targetFolder: "" };
    const result = await dialog({
        title: "Import KeePass database",
        width: "620px",
        build: (close) => {
            const summary = h("div", { class: "import-summary" });
            const warnings = h("div", { class: "import-warnings" });
            const refresh = () => {
                converted = convertKeePass(db, options);
                const s = converted.stats;
                const files = converted.entries.reduce((n, e) => n + e.attachments.length, 0);
                clear(summary).append(
                    h("div", null, h("b", null, String(s.entries)), " entries in ", h("b", null, String(converted.folderPaths.length)), " folders"),
                    h("div", null, h("b", null, String(files)), ` attachments (${formatBytes(s.attachmentBytes)})`, files > s.attachments ? ` incl. ${files - s.attachments} for long notes/fields` : ""),
                    h("div", null, h("b", null, String(s.fields)), " custom fields, ", h("b", null, String(s.totp)), " TOTP secrets", s.references ? `, ${s.references} ${s.references === 1 ? "entry uses" : "entries use"} field references` : ""),
                    s.icons ? h("div", null, h("b", null, String(s.icons)), " entries and groups with their own icon") : "",
                );
                clear(warnings);
                for (const w of converted.warnings.slice(0, 20)) warnings.appendChild(h("div", null, "⚠ " + w));
            };
            const opt = (key, label, title) => {
                const cb = h("input", { type: "checkbox", checked: options[key] });
                cb.addEventListener("change", () => {
                    options[key] = cb.checked;
                    refresh();
                });
                return h("label", { class: "check", title }, cb, label);
            };
            const target = h("select", { class: "wide" }, h("option", { value: "" }, "My vault (personal folders)"));
            for (const org of vault.organizations.values()) {
                if (vault.orgKeys.has(org.id)) target.appendChild(h("option", { value: org.id }, `Organization: ${org.name} (collections)`));
            }
            const folder = h("input", { type: "text", class: "wide", placeholder: "e.g. KeePass (empty = top level)" });
            folder.addEventListener("change", () => {
                options.targetFolder = folder.value;
                refresh();
            });
            const skip = h("input", { type: "checkbox", checked: true });
            refresh();
            return {
                body: h(
                    "div",
                    { class: "form" },
                    h("h4", null, `Database: ${converted.name || step1.fileName}`),
                    summary,
                    warnings,
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Import into:"), h("div", { class: "form-controls" }, target)),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Parent folder:"), h("div", { class: "form-controls" }, folder)),
                    h(
                        "div",
                        { class: "import-options" },
                        opt("createEmptyGroups", "Create folders for empty groups"),
                        opt("resolveReferences", "Resolve field references ({REF:...})", "Bitwarden has no field references, the referenced value is copied"),
                        opt("importHistory", "Import old passwords as password history"),
                        opt("tagsField", "Keep tags in a \"Tags\" field"),
                        opt("expiryField", "Keep expiry dates in an \"Expires\" field"),
                        opt("importIcons", "Import the icons of entries and groups"),
                        opt("includeRecycleBin", "Include the recycle bin"),
                        h("label", { class: "check" }, skip, "Skip entries that already exist (same folder, title and user name)"),
                    ),
                ),
                buttons: [
                    h("button", { type: "button", class: "primary", onclick: () => close({ organizationId: target.value || null, skipExisting: skip.checked }) }, "Import"),
                    h("button", { type: "button", onclick: () => close(undefined) }, "Cancel"),
                ],
            };
        },
    });
    if (!result) return;

    const signal = { cancelled: false };
    const progress = progressDialog("Importing…", { cancellable: true, onCancel: () => (signal.cancelled = true) });
    app.beginBusy();
    try {
        const res = await importEntries(vault, converted, { ...result, signal, icons: app.icons }, (p) => progress.update(p.phase, p.done, p.total));
        progress.close();
        const details = h(
            "div",
            null,
            h("p", null, `${res.created} entries imported, ${res.attachments} attachments uploaded${res.icons ? `, ${res.icons} icons` : ""}${res.skipped ? `, ${res.skipped} existing entries skipped` : ""}.`),
            res.failed.length ? h("div", null, h("p", null, `${res.failed.length} entries failed:`), h("ul", { class: "error-list" }, res.failed.slice(0, 50).map((f) => h("li", null, `${f.path ? f.path + " / " : ""}${f.name}: ${f.error}`)))) : "",
            res.warnings.length ? h("div", null, h("p", null, "Warnings:"), h("ul", { class: "error-list" }, res.warnings.slice(0, 50).map((w) => h("li", null, w)))) : "",
        );
        await alertDialog("Import finished", details);
    } catch (e) {
        progress.close();
        await alertDialog("Import failed", e.message || String(e));
        await vault.sync().catch(() => {});
    } finally {
        app.endBusy();
        app.refresh();
    }
}

// ----- Organizations: share and collections ------------------------------------------------------

function collectionChecklist(vault, orgId, selected, { onlyWritable = true } = {}) {
    const box = h("div", { class: "collection-box tall" });
    const chosen = new Set(selected);
    const cols = [...vault.collections.values()].filter((c) => c.organizationId === orgId && (!onlyWritable || !c.readOnly)).sort((a, b) => a.path.localeCompare(b.path));
    if (!cols.length) box.appendChild(h("span", { class: "muted" }, "No collections available"));
    for (const c of cols) {
        const cb = h("input", { type: "checkbox", checked: chosen.has(c.id) });
        cb.addEventListener("change", () => (cb.checked ? chosen.add(c.id) : chosen.delete(c.id)));
        box.appendChild(h("label", { class: "check", style: { paddingLeft: `${(c.path.split("/").length - 1) * 14}px` } }, cb, c.path));
    }
    return { box, chosen };
}

export function shareDialog(vault, count, preselectOrg, preselectCollections = []) {
    return dialog({
        title: "Move to organization",
        width: "520px",
        build: (close) => {
            const orgSel = h("select", { class: "wide" });
            for (const org of vault.organizations.values()) {
                if (vault.orgKeys.has(org.id)) orgSel.appendChild(h("option", { value: org.id, selected: org.id === preselectOrg }, org.name));
            }
            const holder = h("div", { style: { flex: "1", display: "flex" } });
            let list;
            const render = () => {
                list = collectionChecklist(vault, orgSel.value, orgSel.value === preselectOrg ? preselectCollections : []);
                clear(holder).appendChild(list.box);
            };
            orgSel.addEventListener("change", render);
            render();
            const err = h("div", { class: "form-error" });
            return {
                body: h(
                    "div",
                    { class: "form" },
                    h("p", null, `Move ${count} item(s) from your personal vault into an organization. All members with access to the selected collections will get these items (they are re-encrypted with the organization key). This can not be undone from here.`),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Organization:"), h("div", { class: "form-controls" }, orgSel)),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Collections:"), h("div", { class: "form-controls" }, holder)),
                    err,
                ),
                buttons: [
                    h("button", { type: "button", class: "primary", onclick: () => {
                        if (!orgSel.value) return (err.textContent = "No organization available.");
                        if (!list.chosen.size) return (err.textContent = "Select at least one collection.");
                        close({ organizationId: orgSel.value, collectionIds: [...list.chosen] });
                    } }, "Move"),
                    h("button", { type: "button", onclick: () => close(undefined) }, "Cancel"),
                ],
            };
        },
    });
}

export function collectionsDialog(vault, orgId, selected, count = 1) {
    return dialog({
        title: "Collections",
        width: "480px",
        build: (close) => {
            const list = collectionChecklist(vault, orgId, selected, { onlyWritable: false });
            const err = h("div", { class: "form-error" });
            const text = count > 1 ? `Collections of the ${count} selected items (only the ones they all share are ticked; changes are applied to all of them):` : "Select the collections the item should be in:";
            return {
                body: h("div", { class: "form" }, h("p", null, text), list.box, err),
                buttons: [
                    h("button", { type: "button", class: "primary", onclick: () => {
                        if (!list.chosen.size) return (err.textContent = "Select at least one collection.");
                        close([...list.chosen]);
                    } }, "Save"),
                    h("button", { type: "button", onclick: () => close(undefined) }, "Cancel"),
                ],
            };
        },
    });
}

// ----- Settings & help -----------------------------------------------------------------------------

// Options, in the spirit of the KeePassXC settings. Changes are applied when the dialog is confirmed.
export function settingsDialog() {
    const draft = Object.fromEntries(OPTION_KEYS.map((k) => [k, settings[k]]));
    return dialog({
        title: "Options",
        className: "options-modal",
        width: "620px",
        build: (close) => {
            const controls = [];
            const check = (key, label, title) => {
                const cb = h("input", { type: "checkbox", checked: !!draft[key], "data-option": key });
                cb.addEventListener("change", () => (draft[key] = cb.checked));
                controls.push(() => (cb.checked = !!draft[key]));
                return h("div", { class: "form-row" }, h("label", { class: "check", title }, cb, label));
            };
            const select = (key, label, options, after = null) => {
                const sel = h("select", { "data-option": key }, options.map(([v, l]) => h("option", { value: v, selected: String(draft[key]) === String(v) }, l)));
                sel.addEventListener("change", () => {
                    draft[key] = typeof DEFAULTS[key] === "number" ? Number(sel.value) : sel.value;
                    after?.();
                });
                controls.push(() => (sel.value = String(draft[key])));
                return h("div", { class: "form-row" }, h("label", { class: "form-label" }, label), h("div", { class: "form-controls" }, sel, after ? after.el : ""));
            };
            const number = (key, label, min, max, unit) => {
                const input = h("input", { type: "number", min, max, value: draft[key], class: "narrow", "data-option": key });
                input.addEventListener("change", () => (draft[key] = Math.min(max, Math.max(min, parseInt(input.value, 10) || 0))));
                controls.push(() => (input.value = draft[key]));
                return h("div", { class: "form-row" }, h("label", { class: "form-label" }, label), h("div", { class: "form-controls" }, input, unit));
            };
            const swatch = h("span", { class: "accent-swatch" });
            const showSwatch = () => (swatch.style.background = (ACCENTS[draft.accent] || ACCENTS.blue)[0]);
            showSwatch.el = swatch;
            showSwatch();
            const dateExample = h("span", { class: "muted" });
            const showDateExample = () => {
                const saved = settings.dateFormat;
                settings.dateFormat = draft.dateFormat;
                dateExample.textContent = `e.g. ${formatDate(new Date(Date.now() - 3 * 3600_000).toISOString())}`;
                settings.dateFormat = saved;
            };
            showDateExample.el = dateExample;
            showDateExample();

            const pages = {
                general: [
                    h("h4", null, "Entries"),
                    check("entryWindows", "Open entries in windows (several at once, movable, can be minimized)"),
                    select("dblClickAction", "Double-click on an entry:", [
                        ["field", "Copy the user name or password, open the URL (KeePass)"],
                        ["edit", "Open the entry"],
                        ["url", "Open the URL"],
                    ]),
                    check("confirmDelete", "Ask before moving entries to the trash"),
                    check("showSubfolderEntries", "Show the entries of sub folders"),
                    h("h4", null, "Start and synchronization"),
                    select("startFolder", "After unlocking show:", [
                        ["last", "The folder used last"],
                        ["vault", "My vault"],
                        ["favorites", "Favorites"],
                    ]),
                    number("checkMinutes", "Look for changes every:", 0, 120, "minutes (0 = only when the page gets the focus)"),
                    check("rememberEmail", "Remember my e-mail address on this device"),
                ],
                interface: [
                    h("h4", null, "Appearance"),
                    select("theme", "Theme:", [
                        ["auto", "Follow system"],
                        ["light", "Light"],
                        ["dark", "Dark"],
                    ]),
                    select("accent", "Accent color:", Object.keys(ACCENTS).map((k) => [k, k[0].toUpperCase() + k.slice(1)]), showSwatch),
                    select("fontSize", "Font size:", [10, 11, 12, 13, 14, 15, 16].map((n) => [n, `${n} px${n === 12 ? " (default)" : ""}`])),
                    select("density", "Row spacing:", [
                        ["compact", "Compact"],
                        ["normal", "Normal"],
                        ["comfortable", "Comfortable"],
                    ]),
                    select("toolbar", "Toolbar:", [
                        ["icons", "Icons only"],
                        ["text", "Icons and text"],
                        ["hidden", "Hidden"],
                    ]),
                    check("showStatusBar", "Show the status bar"),
                    check("showDetails", "Show the entry details below the list"),
                    check("stripedRows", "Alternating row colors"),
                    check("gridLines", "Grid lines in the entry list"),
                    select("dateFormat", "Dates:", [
                        ["iso", "2026-10-14 16:29"],
                        ["locale", "Format of the browser"],
                        ["relative", "Relative (3 hours ago)"],
                    ], showDateExample),
                    check("websiteIcons", "Show website icons (loaded through the server)"),
                    h("h4", null, "Passwords and details"),
                    check("monoPasswords", "Monospace font for passwords"),
                    check("colorPasswords", "Color digits and special characters in passwords"),
                    check("hideUsernames", "Hide user names in the entry list"),
                    check("showPasswordsInList", "Show passwords in the entry list (not for entries with re-prompt)"),
                    check("hideNotes", "Hide notes in the details until clicked"),
                ],
                security: [
                    h("h4", null, "Clipboard"),
                    number("clipboardSeconds", "Clear the clipboard after:", 0, 600, "seconds (0 = never)"),
                    check("clearClipboardOnLock", "Clear the clipboard when the vault is locked"),
                    h("h4", null, "Locking"),
                    number("lockMinutes", "Lock after inactivity:", 0, 1440, "minutes (0 = never)"),
                    check("lockOnHide", "Lock when the browser tab is hidden or the window is minimized"),
                    number("lockOnHideSeconds", "… after:", 0, 3600, "seconds"),
                    h("h4", null, "Editing"),
                    check("editorShowPasswords", "Show passwords in the entry editor (do not hide them)"),
                ],
                search: [
                    h("h4", null, "Search"),
                    check("searchPasswords", "Also search passwords and protected fields"),
                    check("searchCase", "Case sensitive"),
                    check("searchInFolder", "Only search in the selected folder and its sub folders"),
                    check("clearSearchOnFolder", "Clear the search when another folder is selected"),
                ],
            };
            const names = { general: "General", interface: "Interface", security: "Security", search: "Search" };
            const tabBar = h("div", { class: "tabs", role: "tablist" });
            const tabBody = h("div", { class: "tab-body" });
            const show = (key) => {
                for (const b of tabBar.children) b.classList.toggle("active", b.dataset.tab === key);
                clear(tabBody).appendChild(h("div", { class: "form" }, pages[key]));
            };
            for (const key of Object.keys(pages)) tabBar.appendChild(h("button", { type: "button", class: "tab", role: "tab", "data-tab": key, onclick: () => show(key) }, names[key]));
            show("general");
            return {
                body: h("div", { class: "options-dialog" }, tabBar, tabBody),
                buttons: [
                    h("button", { type: "button", class: "options-reset", title: "Back to the default options (keeps columns and layout)", onclick: () => {
                        for (const k of OPTION_KEYS) draft[k] = DEFAULTS[k];
                        for (const update of controls) update();
                        showSwatch();
                        showDateExample();
                    } }, "Defaults"),
                    h("span", { class: "spacer" }),
                    h("button", { type: "button", class: "primary", onclick: () => {
                        for (const k of OPTION_KEYS) settings[k] = draft[k];
                        if (!settings.rememberEmail) settings.email = "";
                        saveSettings();
                        close(true);
                    } }, "OK"),
                    h("button", { type: "button", onclick: () => close(false) }, "Cancel"),
                ],
            };
        },
    });
}

export const SHORTCUTS = [
    ["Ctrl+B", "Copy user name"],
    ["Ctrl+C", "Copy password"],
    ["Ctrl+T", "Copy TOTP code"],
    ["Ctrl+U", "Open URL"],
    ["Ctrl+Shift+U", "Copy URL"],
    ["Enter / Ctrl+E", "Edit entry"],
    ["Ctrl+I / Insert", "Add entry"],
    ["Ctrl+K", "Duplicate entry"],
    ["Delete", "Move to trash (in Trash: delete permanently)"],
    ["Ctrl+A", "Select all entries"],
    ["Ctrl+F / F3", "Search"],
    ["Ctrl+G", "Password generator"],
    ["Ctrl+L", "Lock"],
    ["F5", "Synchronize"],
    ["F2 (folder tree)", "Rename folder"],
    ["Insert (folder tree)", "Add sub folder"],
    ["Double-click user name / password", "Copy it"],
    ["Double-click URL", "Open it"],
    ["Drag entries onto a folder", "Move them"],
    ["Drag a folder onto a folder", "Move the folder with all sub folders"],
];

export function shortcutsDialog() {
    return alertDialog(
        "Keyboard shortcuts",
        h("table", { class: "shortcut-table" }, SHORTCUTS.map(([k, d]) => h("tr", null, h("td", null, h("kbd", null, k)), h("td", null, d)))),
    );
}
