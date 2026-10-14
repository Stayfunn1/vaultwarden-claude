// Secondary dialogs: password generator, KeePass import, sharing, settings, help.

import { h, icon, clear, dialog, copyText, settings, saveSettings, readFile, formatBytes, progressDialog, alertDialog } from "./ui.js";
import { generatePassword, passwordEntropy } from "./bwcrypto.js";
import { openKeePass, convertKeePass, DEFAULT_OPTIONS } from "./keepass.js";
import { importEntries } from "./importer.js";

// ----- Password generator ------------------------------------------------------------------------

const GEN_KEY = "vwm.generator";

export function generatorDialog() {
    let opts = { length: 20, upper: true, lower: true, digits: true, special: true, extended: false, avoidAmbiguous: true };
    try {
        opts = { ...opts, ...JSON.parse(localStorage.getItem(GEN_KEY) || "{}") };
    } catch {
        /* defaults */
    }
    return dialog({
        title: "Password Generator",
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
                buttons: [h("button", { type: "button", class: "primary", onclick: () => close(out.value) }, "Use password"), h("button", { type: "button", onclick: () => close(undefined) }, "Close")],
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

export function settingsDialog() {
    return dialog({
        title: "Options",
        build: (close) => {
            const clip = h("input", { type: "number", min: 0, max: 600, value: settings.clipboardSeconds, class: "narrow" });
            const lock = h("input", { type: "number", min: 0, max: 1440, value: settings.lockMinutes, class: "narrow" });
            const theme = h("select", null, [["auto", "Follow system"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => h("option", { value: v, selected: settings.theme === v }, l)));
            const remember = h("input", { type: "checkbox", checked: settings.rememberEmail });
            return {
                body: h(
                    "div",
                    { class: "form" },
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Clear clipboard after:"), h("div", { class: "form-controls" }, clip, "seconds (0 = never)")),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Lock after inactivity:"), h("div", { class: "form-controls" }, lock, "minutes (0 = never)")),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Theme:"), h("div", { class: "form-controls" }, theme)),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, ""), h("label", { class: "check" }, remember, "Remember my e-mail address on this device")),
                ),
                buttons: [
                    h("button", { type: "button", class: "primary", onclick: () => {
                        settings.clipboardSeconds = Math.max(0, parseInt(clip.value, 10) || 0);
                        settings.lockMinutes = Math.max(0, parseInt(lock.value, 10) || 0);
                        settings.theme = theme.value;
                        settings.rememberEmail = remember.checked;
                        if (!remember.checked) settings.email = "";
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
