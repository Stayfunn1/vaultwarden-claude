// Small DOM toolkit for the manager: element builder, icons, dialogs, menus, toasts and clipboard.

export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
            else if (k === "dataset") Object.assign(el.dataset, v);
            else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.substring(2).toLowerCase(), v);
            else if (k === "value") el.value = v;
            else if (k === "checked") el.checked = !!v;
            else if (k === "text") el.textContent = v;
            else if (v === true) el.setAttribute(k, "");
            else el.setAttribute(k, v);
        }
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        if (Array.isArray(c)) append(el, c);
        else if (c instanceof Node) el.appendChild(c);
        else el.appendChild(document.createTextNode(String(c)));
    }
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

// ----- Icons (16x16 SVG, stroke based) ---------------------------------------------------------

const ICONS = {
    folder: '<path d="M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z" fill="var(--icon-folder)" stroke="var(--icon-folder-stroke)"/>',
    folderOpen: '<path d="M1.5 3.5h5l1.5 1.5h6v2" fill="none" stroke="var(--icon-folder-stroke)"/><path d="M1.5 13.5l2-6.5h12l-2 6.5z" fill="var(--icon-folder)" stroke="var(--icon-folder-stroke)"/><path d="M1.5 3.5v10" stroke="var(--icon-folder-stroke)"/>',
    vault: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="var(--icon-vault)" stroke="var(--icon-vault-stroke)"/><circle cx="8" cy="8" r="2.6" fill="none" stroke="#fff"/><path d="M8 5.4v-1M8 11.6v-1M5.4 8h-1M11.6 8h-1" stroke="#fff"/>',
    login: '<circle cx="5" cy="8" r="3" fill="none" stroke="var(--icon-key)" stroke-width="1.6"/><path d="M8 8h6.5M12 8v2.5M14 8v2" stroke="var(--icon-key)" stroke-width="1.6"/>',
    note: '<path d="M3.5 1.5h6l3 3v10h-9z" fill="var(--icon-note)" stroke="var(--icon-stroke)"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" stroke="var(--icon-stroke)"/>',
    card: '<rect x="1.5" y="3.5" width="13" height="9" rx="1" fill="var(--icon-card)" stroke="var(--icon-stroke)"/><path d="M1.5 6.5h13" stroke="var(--icon-stroke)" stroke-width="1.5"/>',
    identity: '<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="var(--icon-note)" stroke="var(--icon-stroke)"/><circle cx="5.5" cy="7" r="1.8" fill="none" stroke="var(--icon-stroke)"/><path d="M3 11.5c.5-1.6 4.5-1.6 5 0M9.5 6h3.5M9.5 8.5h3.5" stroke="var(--icon-stroke)"/>',
    ssh: '<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="var(--icon-term)" stroke="var(--icon-stroke)"/><path d="M4 6l2 2-2 2M7.5 10.5h4" stroke="#fff" stroke-width="1.3" fill="none"/>',
    generic: '<rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="var(--icon-note)" stroke="var(--icon-stroke)"/>',
    star: '<path d="M8 1.8l1.9 3.9 4.2.6-3 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3-3 4.2-.6z" fill="var(--icon-star)" stroke="var(--icon-star-stroke)"/>',
    trash: '<path d="M3.5 4.5h9l-.8 9.5h-7.4z" fill="var(--icon-trash)" stroke="var(--icon-stroke)"/><path d="M2 4.5h12M6 4.5v-2h4v2M6.5 7v5M9.5 7v5" stroke="var(--icon-stroke)" fill="none"/>',
    org: '<path d="M2.5 14.5v-12h7v12M9.5 6.5h4v8" fill="var(--icon-org)" stroke="var(--icon-stroke)"/><path d="M4.5 5h1M7 5h1M4.5 8h1M7 8h1M4.5 11h1M7 11h1M11 9h1M11 11.5h1" stroke="var(--icon-stroke)"/>',
    collection: '<rect x="1.5" y="4.5" width="13" height="9" rx="1" fill="var(--icon-coll)" stroke="var(--icon-stroke)"/><path d="M3 4.5v-2h10v2" fill="none" stroke="var(--icon-stroke)"/>',
    archive: '<rect x="1.5" y="2.5" width="13" height="3" fill="var(--icon-note)" stroke="var(--icon-stroke)"/><path d="M2.5 5.5v8h11v-8M6 8h4" fill="var(--icon-note)" stroke="var(--icon-stroke)"/>',
    search: '<circle cx="6.5" cy="6.5" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9.5 9.5l5 5" stroke="currentColor" stroke-width="1.8"/>',
    add: '<path d="M8 2.5v11M2.5 8h11" stroke="var(--icon-add)" stroke-width="2.2"/>',
    edit: '<path d="M2.5 13.5l.8-3.3 7.5-7.5 2.5 2.5-7.5 7.5z" fill="var(--icon-note)" stroke="var(--icon-stroke)"/><path d="M9.5 4l2.5 2.5" stroke="var(--icon-stroke)"/>',
    del: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="var(--icon-del)" stroke-width="2.2"/>',
    copyUser: '<circle cx="8" cy="5.5" r="2.8" fill="var(--icon-user)" stroke="var(--icon-stroke)"/><path d="M2.5 14.5c.5-3.5 10.5-3.5 11 0z" fill="var(--icon-user)" stroke="var(--icon-stroke)"/>',
    copyPass: '<rect x="1.5" y="5.5" width="13" height="6" rx="1" fill="var(--icon-note)" stroke="var(--icon-stroke)"/><path d="M4 8.5h.01M6.5 8.5h.01M9 8.5h.01M11.5 8.5h.01" stroke="var(--icon-stroke)" stroke-width="2" stroke-linecap="round"/>',
    link: '<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5L8.5 4M9 7a2.5 2.5 0 0 0-3.5 0L3 9.5A2.5 2.5 0 0 0 6.5 13l1-1" fill="none" stroke="var(--icon-link)" stroke-width="1.5"/>',
    sync: '<path d="M13 6.5A5 5 0 0 0 3.5 5M3 9.5A5 5 0 0 0 12.5 11" fill="none" stroke="var(--icon-link)" stroke-width="1.5"/><path d="M13.5 2.5v4h-4M2.5 13.5v-4h4" fill="none" stroke="var(--icon-link)" stroke-width="1.5"/>',
    lock: '<rect x="3" y="7" width="10" height="7.5" rx="1" fill="var(--icon-lock)" stroke="var(--icon-stroke)"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="var(--icon-stroke)" stroke-width="1.4"/>',
    import: '<path d="M8 1.5v8M5 6.5l3 3 3-3" fill="none" stroke="var(--icon-add)" stroke-width="1.7"/><path d="M2.5 10.5v3h11v-3" fill="none" stroke="var(--icon-stroke)" stroke-width="1.4"/>',
    key: '<circle cx="5" cy="8" r="3" fill="none" stroke="var(--icon-key)" stroke-width="1.6"/><path d="M8 8h6.5M12 8v2.5M14 8v2" stroke="var(--icon-key)" stroke-width="1.6"/>',
    clock: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    eye: '<path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
    dice: '<rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/><circle cx="10.5" cy="10.5" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.5h-1v-9h8v1" fill="none" stroke="currentColor" stroke-width="1.3"/>',
    paperclip: '<path d="M10.5 4.5l-5 5a1.5 1.5 0 0 0 2 2l5.5-5.5a2.8 2.8 0 0 0-4-4L3.5 7.5a4 4 0 0 0 5.5 5.5l4-4" fill="none" stroke="currentColor" stroke-width="1.3"/>',
    up: '<path d="M8 3v10M4 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    down: '<path d="M8 3v10M4 9l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    caretRight: '<path d="M6 4l4 4-4 4z" fill="currentColor"/>',
    caretDown: '<path d="M4 6l4 4 4-4z" fill="currentColor"/>',
};

export function icon(name, cls = "") {
    const span = document.createElement("span");
    span.className = `icon ${cls}`;
    span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[name] || ICONS.generic}</svg>`;
    return span;
}

// ----- Formatting -------------------------------------------------------------------------------

export function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatBytes(n) {
    if (!n && n !== 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function firstLine(text, max = 120) {
    if (!text) return "";
    const line = String(text).split(/\r?\n/).find((l) => l.trim()) || "";
    return line.length > max ? line.substring(0, max) + "…" : line;
}

// ----- Settings (per browser) ---------------------------------------------------------------------

const SETTINGS_KEY = "vwm.settings";
const DEFAULT_SETTINGS = {
    columns: ["name", "username", "password", "uri", "notes", "modified"],
    widths: {},
    sort: { key: "name", dir: 1 },
    showSubfolderEntries: false,
    showDetails: true,
    clipboardSeconds: 20,
    lockMinutes: 15,
    theme: "auto",
    treeWidth: 260,
    detailsHeight: 190,
    rememberEmail: true,
    email: "",
};

export const settings = (() => {
    let data = { ...DEFAULT_SETTINGS };
    try {
        data = { ...data, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    } catch {
        /* defaults */
    }
    // Older versions stored the expanded folders (with their names) unencrypted
    delete data.expanded;
    return new Proxy(data, {
        set(target, key, value) {
            target[key] = value;
            try {
                localStorage.setItem(SETTINGS_KEY, JSON.stringify(target));
            } catch {
                /* storage unavailable */
            }
            return true;
        },
    });
})();

export function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings }));
    } catch {
        /* storage unavailable */
    }
}

// ----- Toasts & status ----------------------------------------------------------------------------

let toastHost;
export function toast(message, type = "info", ms = 3500) {
    if (!toastHost) {
        toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
        document.body.appendChild(toastHost);
    }
    const t = h("div", { class: `toast toast-${type}` }, message);
    toastHost.appendChild(t);
    setTimeout(() => t.classList.add("hide"), ms);
    setTimeout(() => t.remove(), ms + 400);
}

// ----- Clipboard ------------------------------------------------------------------------------------

let clipTimer = null;
let clipCountdown = null;
export const clipboardState = { onTick: null };

export async function copyText(text, label = "Value") {
    if (text === null || text === undefined || text === "") {
        toast(`${label} is empty`, "warn");
        return;
    }
    try {
        await navigator.clipboard.writeText(String(text));
    } catch {
        // Fallback for browsers which block the async clipboard API
        const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
        ta.value = String(text);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
    }
    const secs = Number(settings.clipboardSeconds) || 0;
    toast(secs ? `${label} copied, clipboard is cleared in ${secs}s` : `${label} copied`, "ok", 2000);
    clearTimeout(clipTimer);
    clearInterval(clipCountdown);
    if (secs > 0) {
        let left = secs;
        if (clipboardState.onTick) clipboardState.onTick(left);
        clipCountdown = setInterval(() => {
            left--;
            if (clipboardState.onTick) clipboardState.onTick(left > 0 ? left : null);
            if (left <= 0) clearInterval(clipCountdown);
        }, 1000);
        clipTimer = setTimeout(() => {
            navigator.clipboard.writeText("").catch(() => {});
        }, secs * 1000);
    }
}

// ----- Context menus --------------------------------------------------------------------------------

let openMenu = null;
export function closeMenus() {
    if (openMenu) {
        openMenu.remove();
        openMenu = null;
    }
}

// items: [{ label, icon, shortcut, action, disabled, submenu: [...] } | "-"]
export function showMenu(items, x, y) {
    closeMenus();
    const menu = buildMenu(items);
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height - 4))}px`;
    openMenu = menu;
    const first = menu.querySelector(".menu-item:not(.disabled)");
    if (first) first.focus();
    return menu;
}

function buildMenu(items, sub = false) {
    const menu = h("div", { class: `menu${sub ? " submenu" : ""}`, role: "menu" });
    for (const item of items.filter(Boolean)) {
        if (item === "-") {
            menu.appendChild(h("div", { class: "menu-sep", role: "separator" }));
            continue;
        }
        const el = h(
            "div",
            {
                class: `menu-item${item.disabled ? " disabled" : ""}${item.submenu ? " has-sub" : ""}${item.checked ? " checked" : ""}`,
                role: "menuitem",
                tabindex: item.disabled ? "-1" : "0",
                "aria-disabled": item.disabled ? "true" : null,
            },
            h("span", { class: "menu-icon" }, item.icon ? icon(item.icon) : item.checked ? "✓" : ""),
            h("span", { class: "menu-label" }, item.label),
            h("span", { class: "menu-shortcut" }, item.shortcut || (item.submenu ? "▸" : "")),
        );
        if (item.submenu) {
            const subEl = buildMenu(item.submenu, true);
            el.appendChild(subEl);
            el.addEventListener("mouseenter", () => positionSubmenu(el, subEl));
            el.addEventListener("keydown", (e) => {
                if (e.key === "ArrowRight") {
                    positionSubmenu(el, subEl);
                    subEl.querySelector(".menu-item:not(.disabled)")?.focus();
                    e.stopPropagation();
                }
            });
        } else if (!item.disabled) {
            const run = (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeMenus();
                item.action?.();
            };
            el.addEventListener("click", run);
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") run(e);
            });
        }
        menu.appendChild(el);
    }
    menu.addEventListener("keydown", (e) => {
        const list = [...menu.querySelectorAll(":scope > .menu-item:not(.disabled)")];
        const i = list.indexOf(document.activeElement);
        if (e.key === "ArrowDown") {
            list[(i + 1) % list.length]?.focus();
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === "ArrowUp") {
            list[(i - 1 + list.length) % list.length]?.focus();
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === "ArrowLeft" && sub) {
            menu.parentElement?.focus();
            e.stopPropagation();
        } else if (e.key === "Escape") {
            closeMenus();
            e.stopPropagation();
        }
    });
    return menu;
}

function positionSubmenu(parent, subEl) {
    subEl.style.display = "block";
    const pr = parent.getBoundingClientRect();
    const sr = subEl.getBoundingClientRect();
    const left = pr.right + sr.width > window.innerWidth ? -sr.width : pr.width;
    subEl.style.left = `${left}px`;
    const top = pr.top + sr.height > window.innerHeight ? window.innerHeight - sr.height - pr.top - 4 : 0;
    subEl.style.top = `${top}px`;
}

document.addEventListener("mousedown", (e) => {
    if (openMenu && !openMenu.contains(e.target) && !e.target.closest?.(".menubar-item")) closeMenus();
});
window.addEventListener("blur", closeMenus);
window.addEventListener("resize", closeMenus);

// ----- Modal dialogs --------------------------------------------------------------------------------

const dialogStack = [];

export function isDialogOpen() {
    return dialogStack.length > 0;
}

export function closeAllDialogs() {
    for (const close of [...dialogStack].reverse()) close(undefined);
}

// Opens a modal. `build(close)` returns { body, buttons, onOpen, onEnter, onCancel, initialFocus }.
// `onCancel` replaces the default of Esc and the close button (closing without a value).
// Returns a promise resolving with the value passed to close().
export function dialog({ title, className = "", build, width }) {
    return new Promise((resolve) => {
        const backdrop = h("div", { class: "modal-backdrop" });
        const box = h("div", { class: `modal ${className}`, role: "dialog", "aria-modal": "true", "aria-label": title });
        if (width) box.style.width = width;
        let closed = false;
        const close = (value) => {
            if (closed) return;
            closed = true;
            backdrop.remove();
            dialogStack.splice(dialogStack.indexOf(close), 1);
            if (previousFocus && previousFocus.focus) previousFocus.focus();
            resolve(value);
        };
        const previousFocus = document.activeElement;
        const parts = build(close);
        const cancel = () => (parts.onCancel ? parts.onCancel() : close(undefined));
        const titleBar = h("div", { class: "modal-title" }, h("span", null, title), h("button", { class: "modal-x", type: "button", title: "Close", "aria-label": "Close", onclick: cancel }, "×"));
        const footer = parts.buttons ? h("div", { class: "modal-buttons" }, parts.buttons) : null;
        box.append(titleBar, h("div", { class: "modal-body" }, parts.body), footer || "");
        backdrop.appendChild(box);
        document.body.appendChild(backdrop);
        dialogStack.push(close);
        box.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                cancel();
            } else if (e.key === "Enter" && parts.onEnter && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
                e.preventDefault();
                e.stopPropagation();
                parts.onEnter();
            } else if (e.key === "Tab") {
                trapFocus(box, e);
            }
        });
        const focusEl = parts.initialFocus || box.querySelector("input:not([type=hidden]), select, textarea, button.primary, button");
        setTimeout(() => focusEl?.focus(), 0);
        if (parts.onOpen) parts.onOpen();
    });
}

function trapFocus(box, e) {
    const focusables = [...box.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
        (el) => !el.disabled && el.offsetParent !== null,
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
    }
}

export function confirmDialog(title, message, { ok = "OK", danger = false } = {}) {
    return dialog({
        title,
        build: (close) => {
            const okBtn = h("button", { class: danger ? "danger primary" : "primary", type: "button", onclick: () => close(true) }, ok);
            return {
                body: h("div", { class: "confirm-text" }, message),
                buttons: [okBtn, h("button", { type: "button", onclick: () => close(false) }, "Cancel")],
                initialFocus: okBtn,
            };
        },
    }).then((v) => v === true);
}

export function promptDialog(title, label, value = "", { ok = "OK", placeholder = "" } = {}) {
    return dialog({
        title,
        build: (close) => {
            const input = h("input", { type: "text", value, placeholder, class: "wide" });
            const submit = () => close(input.value);
            setTimeout(() => input.select(), 0);
            return {
                body: h("label", { class: "field" }, h("span", null, label), input),
                buttons: [h("button", { class: "primary", type: "button", onclick: submit }, ok), h("button", { type: "button", onclick: () => close(undefined) }, "Cancel")],
                onEnter: submit,
                initialFocus: input,
            };
        },
    });
}

export function alertDialog(title, message) {
    return dialog({
        title,
        build: (close) => ({
            body: h("div", { class: "confirm-text" }, message),
            buttons: [h("button", { class: "primary", type: "button", onclick: () => close(true) }, "OK")],
        }),
    });
}

// A non-closable progress dialog. Returns { update(text, done, total), close() }
export function progressDialog(title, { cancellable = false, onCancel } = {}) {
    let closeFn;
    const label = h("div", { class: "progress-label" }, "Starting…");
    const bar = h("div", { class: "progress-bar" }, h("div", { class: "progress-fill" }));
    dialog({
        title,
        className: "progress-modal",
        build: (close) => {
            closeFn = close;
            return {
                body: h("div", null, label, bar),
                buttons: cancellable ? [h("button", { type: "button", onclick: () => onCancel?.() }, "Cancel")] : null,
            };
        },
    });
    return {
        update(text, done, total) {
            label.textContent = total ? `${text} (${done} / ${total})` : text;
            bar.firstChild.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
        },
        close() {
            closeFn?.();
        },
    };
}

export function downloadBlob(data, fileName, type = "application/octet-stream") {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = h("a", { href: url, download: fileName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function readFile(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(new Uint8Array(r.result));
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(file);
    });
}

export function pickFiles({ multiple = false, accept } = {}) {
    return new Promise((resolve) => {
        const input = h("input", { type: "file", multiple, accept, style: { display: "none" } });
        input.addEventListener("change", () => {
            resolve([...input.files]);
            input.remove();
        });
        document.body.appendChild(input);
        input.click();
    });
}

export function safeUrl(uri) {
    if (!uri) return null;
    let u = uri.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
    try {
        const parsed = new URL(u);
        return ["http:", "https:", "ftp:", "ssh:"].includes(parsed.protocol) ? parsed.href : null;
    } catch {
        return null;
    }
}
