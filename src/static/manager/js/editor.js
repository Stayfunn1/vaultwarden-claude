// Entry editor dialog, modelled after the "Edit Entry" window of KeePass 2.

import { h, icon, clear, dialog, copyText, formatDate, formatBytes, pickFiles, readFile, safeUrl, toast, confirmDialog } from "./ui.js";
import { CipherType, CipherTypeNames, FieldType, TypeFields, cloneView } from "./vault.js";
import { generatePassword, passwordEntropy, totpCode } from "./bwcrypto.js";
import { generatorDialog } from "./dialogs.js";
import { typeIcon } from "./table.js";
import { renderIcon } from "./kpicons.js";

const URI_MATCH = [
    [null, "Default"],
    [0, "Base domain"],
    [1, "Host"],
    [2, "Starts with"],
    [3, "Exact"],
    [4, "Regular expression"],
    [5, "Never"],
];

const LINKED_LOGIN = [
    [100, "User name"],
    [101, "Password"],
];

function secretInput(value, { readOnly = false, placeholder = "", onInput, multiline = false } = {}) {
    const input = multiline
        ? h("textarea", { class: "mono secret-area masked", rows: 4, readonly: readOnly, placeholder })
        : h("input", { type: "password", class: "mono", readonly: readOnly, placeholder, autocomplete: "new-password", spellcheck: "false" });
    input.value = value ?? "";
    if (onInput) input.addEventListener("input", () => onInput(input.value));
    const eye = h("button", { type: "button", class: "icon-btn", title: "Show / hide (Ctrl+H)", tabindex: "-1" }, icon("eye"));
    eye.addEventListener("click", () => {
        if (multiline) input.classList.toggle("masked");
        else input.type = input.type === "password" ? "text" : "password";
        eye.classList.toggle("active");
    });
    input.addEventListener("keydown", (e) => {
        if (e.ctrlKey && (e.key === "h" || e.key === "H")) {
            e.preventDefault();
            eye.click();
        }
    });
    return { input, eye };
}

function strengthBar(getValue) {
    const fill = h("div", { class: "strength-fill" });
    const label = h("span", { class: "strength-label" });
    const el = h("div", { class: "strength" }, h("div", { class: "strength-bar" }, fill), label);
    const update = () => {
        const bits = passwordEntropy(getValue() || "");
        fill.style.width = `${Math.min(100, (bits / 128) * 100)}%`;
        fill.className = `strength-fill ${bits < 40 ? "weak" : bits < 70 ? "fair" : bits < 100 ? "good" : "strong"}`;
        label.textContent = getValue() ? `${bits} bits` : "";
    };
    update();
    return { el, update };
}

function row(label, ...controls) {
    return h("div", { class: "form-row" }, h("label", { class: "form-label" }, label), h("div", { class: "form-controls" }, ...controls));
}

// Opens the editor. Returns the saved view, or undefined when cancelled.
export function editEntryDialog(app, original, { isNew = false, readOnly = false } = {}) {
    const vault = app.vault;
    const view = cloneView(original);
    const canEdit = !readOnly && view.edit !== false && !view.decryptError && !view.deletedDate;
    const hidePasswords = view.viewPassword === false;
    const pendingFiles = [];
    const deletedAttachments = new Set();
    const originalAtStart = original;
    let uploadedFiles = 0;
    let pendingIcon; // the new icon chosen in the editor, undefined while unchanged
    let collectionIds = [...(view.collectionIds || [])];

    return dialog({
        title: `${isNew ? "Add" : canEdit ? "Edit" : "View"} ${CipherTypeNames[view.type] || "Entry"}`,
        className: "editor-modal",
        build: (close) => {
            const errorBox = h("div", { class: "form-error", role: "alert" });
            const tabs = {};
            const tabBar = h("div", { class: "tabs", role: "tablist" });
            const tabBody = h("div", { class: "tab-body" });
            const addTab = (key, label, content) => {
                const btn = h("button", { type: "button", class: "tab", role: "tab", onclick: () => showTab(key) }, label);
                tabs[key] = { btn, content };
                tabBar.appendChild(btn);
            };
            const showTab = (key) => {
                for (const [k, t] of Object.entries(tabs)) {
                    t.btn.classList.toggle("active", k === key);
                    t.btn.setAttribute("aria-selected", String(k === key));
                    t.content.style.display = k === key ? "" : "none";
                }
            };

            // ----- Entry tab -------------------------------------------------------------
            const entry = h("div", { class: "form" });
            const title = h("input", { type: "text", class: "wide", value: view.name || "", readonly: !canEdit });
            title.addEventListener("input", () => (view.name = title.value));
            const iconBtn = h("button", { type: "button", class: "icon-btn entry-icon-btn", title: "Change icon", disabled: !canEdit || !app.icons });
            const showIcon = () => {
                const current = pendingIcon === undefined ? app.entryIcon(view) : pendingIcon && renderIcon(pendingIcon, typeIcon(view));
                clear(iconBtn).appendChild(current || icon(typeIcon(view)));
            };
            iconBtn.addEventListener("click", async () => {
                const choice = await app.chooseIcon("Icon", view.organizationId || null, pendingIcon === undefined ? app.icons?.itemIcon(view) : pendingIcon);
                if (choice === undefined) return;
                pendingIcon = choice;
                showIcon();
            });
            showIcon();
            entry.appendChild(row("Title:", iconBtn, title));

            if (view.type === CipherType.Login) {
                const l = view.login;
                const user = h("input", { type: "text", class: "wide", value: l.username || "", readonly: !canEdit, autocomplete: "off", spellcheck: "false" });
                user.addEventListener("input", () => (l.username = user.value || null));
                entry.appendChild(row("User name:", user, h("button", { type: "button", class: "icon-btn", title: "Copy", tabindex: "-1", onclick: () => copyText(user.value, "User name") }, icon("copy"))));

                const strength = strengthBar(() => l.password);
                const pw = secretInput(hidePasswords ? "" : l.password, {
                    readOnly: !canEdit || hidePasswords,
                    placeholder: hidePasswords ? "(hidden by the organization)" : "",
                    onInput: (v) => {
                        l.password = v || null;
                        strength.update();
                    },
                });
                const gen = h("button", { type: "button", class: "icon-btn", title: "Generate password", disabled: !canEdit, tabindex: "-1" }, icon("dice"));
                gen.addEventListener("click", async () => {
                    const value = await generatorDialog();
                    if (value) {
                        pw.input.value = value;
                        l.password = value;
                        strength.update();
                    }
                });
                const quick = h("button", { type: "button", class: "icon-btn small-text", title: "Quick generate (20 characters)", disabled: !canEdit, tabindex: "-1" }, "⚡");
                quick.addEventListener("click", () => {
                    const value = generatePassword({});
                    pw.input.value = value;
                    l.password = value;
                    strength.update();
                });
                entry.appendChild(
                    row(
                        "Password:",
                        pw.input,
                        pw.eye,
                        gen,
                        quick,
                        h("button", { type: "button", class: "icon-btn", title: "Copy", tabindex: "-1", disabled: hidePasswords, onclick: () => copyText(l.password, "Password") }, icon("copy")),
                    ),
                );
                entry.appendChild(row("Quality:", strength.el));

                // URIs
                const uriList = h("div", { class: "uri-list" });
                const renderUris = () => {
                    clear(uriList);
                    if (!l.uris.length) l.uris.push({ uri: "", match: null });
                    l.uris.forEach((u, idx) => {
                        const input = h("input", { type: "text", class: "wide", value: u.uri || "", readonly: !canEdit, placeholder: "https://", spellcheck: "false" });
                        input.addEventListener("input", () => (u.uri = input.value));
                        const match = h(
                            "select",
                            { disabled: !canEdit, title: "URL match detection (used by the browser extension for auto-fill)" },
                            URI_MATCH.map(([v, label]) => h("option", { value: v === null ? "" : String(v), selected: (u.match ?? null) === v }, label)),
                        );
                        match.addEventListener("change", () => (u.match = match.value === "" ? null : parseInt(match.value, 10)));
                        const open = h("button", { type: "button", class: "icon-btn", title: "Open", tabindex: "-1" }, icon("link"));
                        open.addEventListener("click", () => {
                            const url = safeUrl(input.value);
                            if (url) window.open(url, "_blank", "noopener,noreferrer");
                        });
                        const remove = h("button", { type: "button", class: "icon-btn", title: "Remove URL", disabled: !canEdit, tabindex: "-1" }, icon("del"));
                        remove.addEventListener("click", () => {
                            l.uris.splice(idx, 1);
                            renderUris();
                        });
                        uriList.appendChild(h("div", { class: "uri-row" }, input, match, open, remove));
                    });
                    if (canEdit) {
                        uriList.appendChild(
                            h("button", { type: "button", class: "link-btn", onclick: () => {
                                l.uris.push({ uri: "", match: null });
                                renderUris();
                            } }, "+ Add URL"),
                        );
                    }
                };
                renderUris();
                entry.appendChild(row("URL:", uriList));

                const totpInput = h("input", {
                    type: "text",
                    class: "wide mono",
                    value: hidePasswords ? "" : l.totp || "",
                    readonly: !canEdit || hidePasswords,
                    placeholder: hidePasswords ? (l.totp ? "(hidden by the organization)" : "") : "Secret key or otpauth:// URI",
                    spellcheck: "false",
                });
                const totpPreview = h("span", { class: "totp-preview" });
                const refreshTotp = async () => {
                    try {
                        const r = l.totp && !hidePasswords ? await totpCode(l.totp) : null;
                        totpPreview.textContent = r ? `${r.code.replace(/^(\d{3})(\d+)$/, "$1 $2")}  (${r.remaining}s)` : "";
                    } catch {
                        totpPreview.textContent = l.totp ? "invalid key" : "";
                    }
                };
                totpInput.addEventListener("input", () => {
                    l.totp = totpInput.value.trim() || null;
                    refreshTotp();
                });
                refreshTotp();
                const timer = setInterval(() => {
                    if (!document.body.contains(totpPreview)) clearInterval(timer);
                    else refreshTotp();
                }, 1000);
                entry.appendChild(row("TOTP:", totpInput, totpPreview));
                if (l.fido2Credentials && l.fido2Credentials.length) {
                    entry.appendChild(row("Passkey:", h("span", { class: "muted" }, "This item has a passkey (kept unchanged)")));
                }
            } else if (TypeFields[view.type]) {
                view.typeData = view.typeData || {};
                for (const [key, label, sensitive, multiline] of TypeFields[view.type]) {
                    if (sensitive) {
                        const s = secretInput(hidePasswords ? "" : view.typeData[key], {
                            readOnly: !canEdit || hidePasswords,
                            multiline,
                            onInput: (v) => (view.typeData[key] = v || null),
                        });
                        entry.appendChild(row(`${label}:`, s.input, s.eye, h("button", { type: "button", class: "icon-btn", title: "Copy", tabindex: "-1", disabled: hidePasswords, onclick: () => copyText(view.typeData[key], label) }, icon("copy"))));
                    } else {
                        const input = multiline
                            ? h("textarea", { class: "wide mono", rows: 3, readonly: !canEdit })
                            : h("input", { type: "text", class: "wide", readonly: !canEdit });
                        input.value = view.typeData[key] ?? "";
                        input.addEventListener("input", () => (view.typeData[key] = input.value || null));
                        entry.appendChild(row(`${label}:`, input));
                    }
                }
            }

            const notes = h("textarea", { class: "wide notes", rows: 7, readonly: !canEdit });
            notes.value = view.notes || "";
            notes.addEventListener("input", () => (view.notes = notes.value || null));
            entry.appendChild(row("Notes:", notes));

            // Folder
            const folderSel = h("select", { class: "wide", disabled: view.deletedDate });
            folderSel.appendChild(h("option", { value: "" }, "(No folder)"));
            const folders = [...vault.folders.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
            const seen = new Set();
            for (const f of folders) {
                if (seen.has(f.path)) continue;
                seen.add(f.path);
                folderSel.appendChild(h("option", { value: f.id, selected: f.id === view.folderId }, f.path));
            }
            if (view.folderId && !vault.folders.has(view.folderId)) folderSel.value = "";
            folderSel.addEventListener("change", () => (view.folderId = folderSel.value || null));
            entry.appendChild(row("Folder:", folderSel));

            // Owner and collections (new items only, existing items are moved with "Move to organization")
            const colBox = h("div", { class: "collection-box" });
            const renderCollections = () => {
                clear(colBox);
                if (!view.organizationId) {
                    colBox.style.display = "none";
                    return;
                }
                colBox.style.display = "";
                const cols = [...vault.collections.values()].filter((c) => c.organizationId === view.organizationId).sort((a, b) => a.path.localeCompare(b.path));
                if (!cols.length) colBox.appendChild(h("span", { class: "muted" }, "This organization has no collections you can access"));
                for (const c of cols) {
                    const cb = h("input", { type: "checkbox", checked: collectionIds.includes(c.id), disabled: !isNew || c.readOnly });
                    cb.addEventListener("change", () => {
                        collectionIds = cb.checked ? [...collectionIds, c.id] : collectionIds.filter((id) => id !== c.id);
                    });
                    colBox.appendChild(h("label", { class: "check" }, cb, c.path));
                }
            };
            if (isNew && vault.organizations.size) {
                const ownerSel = h("select", { class: "wide" }, h("option", { value: "" }, "My vault"));
                for (const org of vault.organizations.values()) {
                    ownerSel.appendChild(h("option", { value: org.id, selected: org.id === view.organizationId }, org.name));
                }
                ownerSel.addEventListener("change", () => {
                    view.organizationId = ownerSel.value || null;
                    collectionIds = [];
                    renderCollections();
                });
                entry.appendChild(row("Owner:", ownerSel));
                entry.appendChild(row("Collections:", colBox));
            } else if (view.organizationId) {
                entry.appendChild(row("Owner:", h("span", null, vault.organizations.get(view.organizationId)?.name || "Organization")));
                entry.appendChild(row("Collections:", colBox));
            }
            renderCollections();

            const fav = h("input", { type: "checkbox", checked: view.favorite, disabled: view.deletedDate });
            fav.addEventListener("change", () => (view.favorite = fav.checked));
            const reprompt = h("input", { type: "checkbox", checked: view.reprompt === 1, disabled: !canEdit });
            reprompt.addEventListener("change", () => (view.reprompt = reprompt.checked ? 1 : 0));
            entry.appendChild(row("", h("label", { class: "check" }, fav, "Favorite"), h("label", { class: "check", title: "The Bitwarden apps ask for the master password before showing this item" }, reprompt, "Master password re-prompt")));
            addTab("entry", "Entry", entry);

            // ----- Advanced tab: custom fields and attachments ---------------------------
            const adv = h("div", { class: "form" });
            const fieldTable = h("div", { class: "field-table" });
            let renderFields = () => {
                clear(fieldTable);
                fieldTable.appendChild(h("div", { class: "field-head" }, h("span", null, "Name"), h("span", null, "Value"), h("span", null, "Type"), h("span")));
                view.fields.forEach((f, idx) => {
                    const name = h("input", { type: "text", value: f.name || "", readonly: !canEdit, placeholder: "Name", spellcheck: "false" });
                    name.addEventListener("input", () => (f.name = name.value));
                    let valueEl;
                    if (f.type === FieldType.Boolean) {
                        const cb = h("input", { type: "checkbox", checked: f.value === "true", disabled: !canEdit });
                        cb.addEventListener("change", () => (f.value = cb.checked ? "true" : "false"));
                        valueEl = h("div", { class: "field-value" }, cb);
                    } else if (f.type === FieldType.Linked) {
                        const sel = h("select", { disabled: !canEdit }, LINKED_LOGIN.map(([v, label]) => h("option", { value: String(v), selected: f.linkedId === v }, label)));
                        if (f.linkedId === null || f.linkedId === undefined) f.linkedId = 100;
                        sel.addEventListener("change", () => (f.linkedId = parseInt(sel.value, 10)));
                        valueEl = h("div", { class: "field-value" }, sel);
                    } else if (f.type === FieldType.Hidden) {
                        const s = secretInput(hidePasswords ? "" : f.value, { readOnly: !canEdit || hidePasswords, onInput: (v) => (f.value = v) });
                        valueEl = h("div", { class: "field-value" }, s.input, s.eye, h("button", { type: "button", class: "icon-btn", title: "Copy", tabindex: "-1", disabled: hidePasswords, onclick: () => copyText(f.value, f.name || "Field") }, icon("copy")));
                    } else {
                        const input = h("input", { type: "text", value: f.value || "", readonly: !canEdit, spellcheck: "false" });
                        input.addEventListener("input", () => (f.value = input.value));
                        valueEl = h("div", { class: "field-value" }, input, h("button", { type: "button", class: "icon-btn", title: "Copy", tabindex: "-1", onclick: () => copyText(f.value, f.name || "Field") }, icon("copy")));
                    }
                    const typeSel = h(
                        "select",
                        { disabled: !canEdit },
                        [
                            [FieldType.Text, "Text"],
                            [FieldType.Hidden, "Protected"],
                            [FieldType.Boolean, "Checkbox"],
                            ...(view.type === CipherType.Login ? [[FieldType.Linked, "Linked"]] : []),
                        ].map(([v, label]) => h("option", { value: String(v), selected: f.type === v }, label)),
                    );
                    typeSel.addEventListener("change", () => {
                        f.type = parseInt(typeSel.value, 10);
                        if (f.type === FieldType.Linked) {
                            f.value = null;
                            f.linkedId = 100;
                        } else f.linkedId = null;
                        if (f.type === FieldType.Boolean) f.value = f.value === "true" ? "true" : "false";
                        renderFields();
                    });
                    const actions = h(
                        "span",
                        { class: "field-actions" },
                        h("button", { type: "button", class: "icon-btn", title: "Move up", disabled: !canEdit || idx === 0, tabindex: "-1", onclick: () => {
                            [view.fields[idx - 1], view.fields[idx]] = [view.fields[idx], view.fields[idx - 1]];
                            renderFields();
                        } }, icon("up")),
                        h("button", { type: "button", class: "icon-btn", title: "Move down", disabled: !canEdit || idx === view.fields.length - 1, tabindex: "-1", onclick: () => {
                            [view.fields[idx + 1], view.fields[idx]] = [view.fields[idx], view.fields[idx + 1]];
                            renderFields();
                        } }, icon("down")),
                        h("button", { type: "button", class: "icon-btn", title: "Remove field", disabled: !canEdit, tabindex: "-1", onclick: () => {
                            view.fields.splice(idx, 1);
                            renderFields();
                        } }, icon("del")),
                    );
                    fieldTable.appendChild(h("div", { class: "field-row" }, name, valueEl, typeSel, actions));
                });
                if (!view.fields.length) fieldTable.appendChild(h("div", { class: "muted field-empty" }, "No custom fields. Use them for extra user names, e-mail addresses, PINs, security answers, ..."));
            };
            renderFields();
            const addField = (type) => {
                view.fields.push({ name: "", value: type === FieldType.Boolean ? "false" : "", type, linkedId: null });
                renderFields();
                const inputs = fieldTable.querySelectorAll(".field-row input[type=text]");
                inputs[inputs.length - (type === FieldType.Text ? 2 : 1)]?.focus();
            };
            adv.appendChild(h("h4", null, "String fields"));
            adv.appendChild(fieldTable);
            if (canEdit) {
                adv.appendChild(
                    h(
                        "div",
                        { class: "button-row" },
                        h("button", { type: "button", onclick: () => addField(FieldType.Text) }, "+ Text field"),
                        h("button", { type: "button", onclick: () => addField(FieldType.Hidden) }, "+ Protected field"),
                        h("button", { type: "button", onclick: () => addField(FieldType.Boolean) }, "+ Checkbox"),
                        view.type === CipherType.Login ? h("button", { type: "button", onclick: () => addField(FieldType.Linked) }, "+ Linked field") : "",
                    ),
                );
            }

            const attList = h("div", { class: "attachment-list" });
            let renderAttachments = () => {
                clear(attList);
                const items = [
                    ...view.attachments.map((a) => ({ a, existing: true })),
                    ...pendingFiles.map((f) => ({ a: { fileName: f.name, size: f.size }, file: f })),
                ];
                if (!items.length) attList.appendChild(h("div", { class: "muted" }, "No attachments"));
                for (const { a, existing, file } of items) {
                    const marked = existing && deletedAttachments.has(a.id);
                    const actions = [];
                    if (existing) {
                        actions.push(h("button", { type: "button", onclick: () => app.downloadAttachment(view.id, a.id) }, "Save…"));
                        if (canEdit) {
                            actions.push(h("button", { type: "button", onclick: () => {
                                if (marked) deletedAttachments.delete(a.id);
                                else deletedAttachments.add(a.id);
                                renderAttachments();
                            } }, marked ? "Undo" : "Delete"));
                        }
                    } else {
                        actions.push(h("button", { type: "button", onclick: () => {
                            pendingFiles.splice(pendingFiles.indexOf(file), 1);
                            renderAttachments();
                        } }, "Remove"));
                    }
                    attList.appendChild(
                        h(
                            "div",
                            { class: `attachment-row${marked ? " marked" : ""}` },
                            icon("paperclip"),
                            h("span", { class: "att-name" }, a.fileName || "(unknown)"),
                            h("span", { class: "muted" }, existing ? formatBytes(a.size) : `${formatBytes(a.size)} (new)`),
                            marked ? h("span", { class: "muted" }, "will be deleted") : "",
                            h("span", { class: "att-actions" }, actions),
                        ),
                    );
                }
            };
            renderAttachments();
            adv.appendChild(h("h4", null, "Attachments"));
            adv.appendChild(attList);
            if (canEdit) {
                const dropHint = h("div", { class: "drop-hint" }, "Drop files here or ");
                const addFiles = h("button", { type: "button" }, "Attach files…");
                addFiles.addEventListener("click", async () => {
                    pendingFiles.push(...(await pickFiles({ multiple: true })));
                    renderAttachments();
                });
                dropHint.appendChild(addFiles);
                adv.addEventListener("dragover", (e) => {
                    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
                });
                adv.addEventListener("drop", (e) => {
                    if (!e.dataTransfer.files.length) return;
                    e.preventDefault();
                    pendingFiles.push(...e.dataTransfer.files);
                    renderAttachments();
                });
                adv.appendChild(dropHint);
            }
            addTab("advanced", "", adv);
            const updateAdvancedLabel = () => {
                const n = view.fields.length + view.attachments.length - deletedAttachments.size + pendingFiles.length;
                tabs.advanced.btn.textContent = `Advanced (${n})`;
            };
            const origRenderFields = renderFields;
            const origRenderAttachments = renderAttachments;
            renderFields = () => {
                origRenderFields();
                updateAdvancedLabel();
            };
            renderAttachments = () => {
                origRenderAttachments();
                updateAdvancedLabel();
            };
            updateAdvancedLabel();

            // ----- History tab -------------------------------------------------------------
            const hist = h("div", { class: "form" });
            if (!view.passwordHistory.length) hist.appendChild(h("div", { class: "muted" }, "No password history."));
            if (hidePasswords && view.passwordHistory.length) hist.appendChild(h("div", { class: "muted" }, "The password history is hidden by your organization."));
            for (const ph of hidePasswords ? [] : view.passwordHistory) {
                const s = secretInput(ph.password, { readOnly: true });
                hist.appendChild(row(formatDate(ph.lastUsedDate), s.input, s.eye, h("button", { type: "button", class: "icon-btn", title: "Copy", onclick: () => copyText(ph.password, "Old password") }, icon("copy"))));
            }
            if (view.login?.passwordRevisionDate) hist.appendChild(row("Password changed:", h("span", null, formatDate(view.login.passwordRevisionDate))));
            addTab("history", `History (${view.passwordHistory.length})`, hist);

            // ----- Properties tab ---------------------------------------------------------
            const props = h("div", { class: "form" });
            const prop = (label, value) => props.appendChild(row(label, h("span", { class: "selectable" }, value || "—")));
            prop("Type:", CipherTypeNames[view.type]);
            prop("ID:", view.id || "(new)");
            prop("Created:", formatDate(view.creationDate));
            prop("Modified:", formatDate(view.revisionDate));
            prop("Owner:", view.organizationId ? vault.organizations.get(view.organizationId)?.name : "My vault");
            prop("Item key:", view.id ? (view.hasCipherKey ? "Individual item key" : "Account key (upgraded on save)") : "Individual item key");
            if (view.deletedDate) prop("Deleted:", formatDate(view.deletedDate));
            if (!canEdit && !view.deletedDate) props.appendChild(h("div", { class: "muted" }, view.decryptError ? "Parts of this item can not be decrypted, so it can not be edited here." : "You only have read access to this item."));
            addTab("props", "Properties", props);

            for (const t of Object.values(tabs)) tabBody.appendChild(t.content);
            showTab("entry");

            // ----- Saving ------------------------------------------------------------------
            const saveBtn = h("button", { type: "button", class: "primary" }, "OK");
            // Copies the stored state into the editor after the entry was saved, so pressing OK again
            // (after a failed attachment upload) updates the entry instead of creating a second one
            const syncFromVault = () => {
                const stored = vault.ciphers.get(view.id);
                if (!stored) return;
                Object.assign(view, {
                    raw: stored.raw,
                    key: stored.key,
                    hasCipherKey: stored.hasCipherKey,
                    revisionDate: stored.revisionDate,
                    creationDate: stored.creationDate,
                    attachments: stored.attachments,
                    passwordHistory: stored.passwordHistory,
                });
                if (view.login && stored.login) view.login.passwordRevisionDate = stored.login.passwordRevisionDate;
                original = stored;
            };
            const save = async () => {
                errorBox.textContent = "";
                if (!canEdit) {
                    // Folder and favorite can still be changed on read only items
                    if (!view.deletedDate && view.id && (view.folderId !== original.folderId || view.favorite !== original.favorite)) {
                        try {
                            await app.vault.api.put(`/api/ciphers/${view.id}/partial`, { folderId: view.folderId, favorite: view.favorite });
                            original.folderId = view.folderId;
                            original.favorite = view.favorite;
                            app.refresh();
                        } catch (e) {
                            errorBox.textContent = e.message;
                            return;
                        }
                    }
                    close(original);
                    return;
                }
                if (!(view.name || "").trim()) {
                    showTab("entry");
                    errorBox.textContent = "The title can not be empty.";
                    title.focus();
                    return;
                }
                if (view.organizationId && !view.id && !collectionIds.length) {
                    showTab("entry");
                    errorBox.textContent = "Select at least one collection for an organization item.";
                    return;
                }
                if (view.fields.some((f) => !(f.name || "").trim())) {
                    showTab("advanced");
                    errorBox.textContent = "Every custom field needs a name.";
                    return;
                }
                if (view.type === CipherType.SshKey && !(view.typeData?.privateKey && view.typeData?.publicKey && view.typeData?.keyFingerprint)) {
                    // The server (and the Bitwarden apps) can not handle incomplete SSH keys
                    showTab("entry");
                    errorBox.textContent = "An SSH key needs the private key, the public key and the fingerprint.";
                    return;
                }
                if (view.login) view.login.uris = view.login.uris.filter((u) => (u.uri || "").trim()).map((u) => ({ ...u, uri: u.uri.trim() }));
                saveBtn.disabled = true;
                saveBtn.textContent = "Saving…";
                let stage = "entry";
                try {
                    const saved = await vault.saveCipher(view, { collectionIds });
                    view.id = saved.id;
                    syncFromVault();
                    stage = "attachments";
                    for (const id of [...deletedAttachments]) {
                        await vault.deleteAttachment(view.id, id);
                        deletedAttachments.delete(id);
                        syncFromVault();
                    }
                    for (const file of [...pendingFiles]) {
                        await vault.addAttachment(view.id, file.name, await readFile(file));
                        pendingFiles.splice(pendingFiles.indexOf(file), 1);
                        uploadedFiles++;
                        syncFromVault();
                    }
                    if (pendingIcon !== undefined && app.icons) {
                        stage = "icon";
                        await app.icons.apply([{ organizationId: view.organizationId || null, kind: "item", id: view.id, icon: pendingIcon }]);
                        pendingIcon = undefined;
                    }
                    close(vault.ciphers.get(view.id) || saved);
                } catch (e) {
                    console.error(e);
                    const msg = e.message || String(e);
                    errorBox.textContent =
                        stage === "entry"
                            ? msg
                            : stage === "icon"
                              ? `The entry was saved, but the icon could not be changed: ${msg}. Press OK to try again.`
                              : `The entry was saved, but an attachment could not be changed: ${msg}. Press OK to try again.`;
                    renderAttachments();
                    saveBtn.disabled = false;
                    saveBtn.textContent = "OK";
                }
            };
            saveBtn.addEventListener("click", save);
            const cancel = async () => {
                const changed = canEdit && JSON.stringify(stripForCompare(view)) !== JSON.stringify(stripForCompare(original));
                if (changed || pendingFiles.length || deletedAttachments.size) {
                    if (!(await confirmDialog("Discard changes", "Discard the changes to this entry?", { ok: "Discard", danger: true }))) return;
                }
                // An entry saved before a failed attachment upload is still reported as saved
                close(view.id && original !== originalAtStart ? vault.ciphers.get(view.id) : undefined);
            };
            return {
                body: h("div", null, tabBar, tabBody, errorBox),
                buttons: [saveBtn, h("button", { type: "button", onclick: cancel }, canEdit ? "Cancel" : "Close")],
                onCancel: cancel,
                onEnter: () => {
                    if (document.activeElement?.tagName !== "TEXTAREA") save();
                },
                initialFocus: title,
            };
        },
    }).then((result) => {
        if (result && uploadedFiles) toast(`${uploadedFiles} attachment(s) uploaded`, "ok");
        return result;
    });
}

function stripForCompare(v) {
    return { name: v.name || "", notes: v.notes || null, login: v.login ? { ...v.login, uris: (v.login.uris || []).filter((u) => u.uri) } : null, typeData: v.typeData, fields: v.fields, favorite: v.favorite, folderId: v.folderId, reprompt: v.reprompt };
}
