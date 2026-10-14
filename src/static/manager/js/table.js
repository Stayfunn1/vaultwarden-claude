// Entry list (right pane): a compact, virtualized table in the style of KeePass 2.

import { h, icon, clear, settings, saveSettings, formatDate, firstLine } from "./ui.js";
import { CipherType, CipherTypeNames } from "./vault.js";

const ROW_HEIGHT = 21;

const TYPE_ICON = { 1: "login", 2: "note", 3: "card", 4: "identity", 5: "ssh" };

export function typeIcon(view) {
    return TYPE_ICON[view.type] || "generic";
}

export function subtitle(view) {
    if (view.login) return view.login.username || "";
    const d = view.typeData || {};
    if (view.type === CipherType.Card) return d.number ? `${d.brand || "Card"} *${String(d.number).slice(-4)}` : d.brand || "";
    if (view.type === CipherType.Identity) return [d.firstName, d.lastName].filter(Boolean).join(" ") || d.email || "";
    return "";
}

// Column definitions: key -> { title, width, value(view, ctx), sortValue? }
export const COLUMNS = {
    name: { title: "Title", width: 220, value: (v) => v.name || "" },
    username: { title: "User Name", width: 170, value: (v) => subtitle(v) },
    password: {
        title: "Password",
        width: 110,
        value: (v) => (v.login?.password ? (v.viewPassword ? "••••••••" : "(hidden)") : ""),
        sortValue: () => "",
    },
    uri: { title: "URL", width: 220, value: (v) => v.login?.uris?.[0]?.uri || "" },
    notes: { title: "Notes", width: 200, value: (v) => firstLine(v.notes) },
    folder: { title: "Group", width: 160, value: (v, ctx) => ctx.groupName(v) },
    modified: { title: "Modified", width: 125, value: (v) => formatDate(v.revisionDate), sortValue: (v) => v.revisionDate || "" },
    created: { title: "Created", width: 125, value: (v) => formatDate(v.creationDate), sortValue: (v) => v.creationDate || "" },
    attachments: { title: "Files", width: 50, value: (v) => (v.attachments.length ? String(v.attachments.length) : ""), sortValue: (v) => v.attachments.length },
    fields: { title: "Fields", width: 50, value: (v) => (v.fields.length ? String(v.fields.length) : ""), sortValue: (v) => v.fields.length },
    totp: { title: "TOTP", width: 50, value: (v) => (v.login?.totp ? "✓" : "") },
    type: { title: "Type", width: 90, value: (v) => CipherTypeNames[v.type] || "" },
    org: { title: "Owner", width: 120, value: (v, ctx) => ctx.ownerName(v) },
};

export class EntryTable {
    constructor(container, handlers) {
        this.el = container;
        this.h = handlers; // onSelect(ids), onOpen(view), onContext(x, y), onCellDblClick(view, colKey), ctx
        this.rows = [];
        this.selection = new Set();
        this.focusIndex = -1;
        this.anchor = -1;
        this.el.classList.add("entry-table");
        this.el.tabIndex = 0;
        this.el.setAttribute("role", "grid");
        this.header = h("div", { class: "et-header", role: "row" });
        this.viewport = h("div", { class: "et-viewport" });
        this.spacer = h("div", { class: "et-spacer" });
        this.body = h("div", { class: "et-body", role: "rowgroup" });
        this.empty = h("div", { class: "et-empty" }, "");
        this.viewport.append(this.spacer, this.body);
        this.el.append(this.header, this.viewport, this.empty);
        this.viewport.addEventListener("scroll", () => {
            this.header.scrollLeft = this.viewport.scrollLeft;
            this.renderRows();
        });
        new ResizeObserver(() => this.renderRows()).observe(this.viewport);
        this.el.addEventListener("keydown", (e) => this.onKey(e));
        this.body.addEventListener("dragstart", (e) => this.onDragStart(e));
        this.renderHeader();
    }

    get columns() {
        const cols = settings.columns.filter((c) => COLUMNS[c]);
        // Search results and flattened views show the group of each entry, like KeePass does
        if (this.showGroupColumn && !cols.includes("folder")) cols.splice(cols.indexOf("name") + 1, 0, "folder");
        return cols;
    }

    width(key) {
        return settings.widths[key] || COLUMNS[key].width;
    }

    renderHeader() {
        clear(this.header);
        const sort = settings.sort || {};
        for (const key of this.columns) {
            const col = COLUMNS[key];
            const cell = h(
                "div",
                { class: "et-hcell", style: { width: `${this.width(key)}px` }, role: "columnheader", title: `Sort by ${col.title}` },
                h("span", { class: "et-htext" }, col.title),
                sort.key === key ? h("span", { class: "et-sort" }, sort.dir > 0 ? "▲" : "▼") : "",
            );
            cell.addEventListener("click", (e) => {
                if (e.target.classList.contains("et-resize")) return;
                const cur = settings.sort || {};
                settings.sort = cur.key === key ? { key, dir: -cur.dir } : { key, dir: 1 };
                this.sortRows();
                this.renderHeader();
                this.renderRows(true);
            });
            const handle = h("span", { class: "et-resize" });
            handle.addEventListener("mousedown", (e) => this.startResize(e, key, cell));
            cell.appendChild(handle);
            cell.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                this.h.onHeaderContext?.(e.clientX, e.clientY);
            });
            this.header.appendChild(cell);
        }
        this.header.appendChild(h("div", { class: "et-hcell et-filler" }));
        this.totalWidth = this.columns.reduce((n, k) => n + this.width(k), 0);
        this.spacer.style.width = `${this.totalWidth}px`;
    }

    startResize(e, key, cell) {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = this.width(key);
        const move = (ev) => {
            const w = Math.max(30, startW + ev.clientX - startX);
            settings.widths[key] = w;
            cell.style.width = `${w}px`;
            this.renderRows(true);
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            saveSettings();
            this.renderHeader();
            this.renderRows(true);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    }

    setRows(rows, { keepSelection = true, emptyText = "No entries" } = {}) {
        const prevFocusId = this.rows[this.focusIndex]?.id;
        this.rows = rows;
        this.sortRows();
        const ids = new Set(rows.map((r) => r.id));
        if (keepSelection) {
            for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
        } else {
            this.selection.clear();
        }
        this.focusIndex = prevFocusId ? this.rows.findIndex((r) => r.id === prevFocusId) : -1;
        if (this.focusIndex === -1 && this.selection.size) this.focusIndex = this.rows.findIndex((r) => this.selection.has(r.id));
        this.empty.textContent = emptyText;
        this.empty.style.display = rows.length ? "none" : "";
        this.renderHeader();
        this.renderRows(true);
        this.h.onSelect?.(this.selectedViews());
    }

    sortRows() {
        const sort = settings.sort;
        if (!sort || !COLUMNS[sort.key]) return;
        const col = COLUMNS[sort.key];
        const ctx = this.h.ctx;
        const val = col.sortValue || ((v) => col.value(v, ctx));
        const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        const keyed = this.rows.map((r) => [val(r, ctx), r]);
        keyed.sort((a, b) => {
            const x = a[0];
            const y = b[0];
            const c = typeof x === "number" && typeof y === "number" ? x - y : coll.compare(String(x ?? ""), String(y ?? ""));
            return c * sort.dir || coll.compare(a[1].name || "", b[1].name || "");
        });
        this.rows = keyed.map((k) => k[1]);
    }

    selectedViews() {
        return this.rows.filter((r) => this.selection.has(r.id));
    }

    renderRows(force = false) {
        const total = this.rows.length;
        this.spacer.style.height = `${total * ROW_HEIGHT}px`;
        const top = this.viewport.scrollTop;
        const height = this.viewport.clientHeight || 400;
        const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - 5);
        const end = Math.min(total, Math.ceil((top + height) / ROW_HEIGHT) + 5);
        if (!force && this._range && this._range[0] === start && this._range[1] === end) return;
        this._range = [start, end];
        clear(this.body);
        this.body.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
        this.body.style.width = `${this.totalWidth}px`;
        const cols = this.columns;
        const ctx = this.h.ctx;
        for (let i = start; i < end; i++) {
            const v = this.rows[i];
            const cls = ["et-row", i % 2 ? "odd" : "even"];
            if (this.selection.has(v.id)) cls.push("selected");
            if (i === this.focusIndex) cls.push("focused");
            if (v.deletedDate) cls.push("deleted");
            if (v.decryptError) cls.push("error");
            const row = h("div", { class: cls.join(" "), role: "row", draggable: "true", dataset: { index: String(i) } });
            for (const key of cols) {
                const col = COLUMNS[key];
                const text = col.value(v, ctx);
                const cell = h("div", { class: `et-cell et-${key}`, style: { width: `${this.width(key)}px` }, role: "gridcell", dataset: { col: key } });
                if (key === "name") {
                    cell.append(this.h.entryIcon?.(v) || icon(typeIcon(v)), h("span", { class: "et-text" }, text || "(no title)"));
                    if (v.favorite) cell.appendChild(icon("star", "et-fav"));
                    if (v.organizationId) cell.appendChild(icon("org", "et-shared"));
                } else {
                    cell.textContent = text;
                }
                if (key !== "password" && text) cell.title = text;
                row.appendChild(cell);
            }
            row.addEventListener("mousedown", (e) => this.onRowMouseDown(e, i));
            row.addEventListener("click", (e) => this.onRowClick(e, i));
            row.addEventListener("dblclick", (e) => {
                const colKey = e.target.closest(".et-cell")?.dataset.col;
                this.h.onCellDblClick?.(v, colKey);
            });
            row.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                if (!this.selection.has(v.id)) this.selectIndex(i, false, false);
                this.h.onContext?.(e.clientX, e.clientY);
            });
            this.body.appendChild(row);
        }
    }

    onRowMouseDown(e, i) {
        // Keep a multi selection when starting a drag on a selected row
        if (e.button !== 0) return;
        this.el.focus({ preventScroll: true });
        const v = this.rows[i];
        if (this.selection.has(v.id) && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            this._pendingSingle = i;
            return;
        }
        this._pendingSingle = null;
        this.selectIndex(i, e.ctrlKey || e.metaKey, e.shiftKey);
    }

    onRowClick(e, i) {
        if (this._pendingSingle === i) {
            this._pendingSingle = null;
            this.selectIndex(i, false, false);
        }
    }

    selectIndex(i, toggle, range) {
        if (i < 0 || i >= this.rows.length) return;
        const id = this.rows[i].id;
        if (range && this.anchor >= 0) {
            if (!toggle) this.selection.clear();
            const [a, b] = this.anchor < i ? [this.anchor, i] : [i, this.anchor];
            for (let k = a; k <= b; k++) this.selection.add(this.rows[k].id);
        } else if (toggle) {
            if (this.selection.has(id)) this.selection.delete(id);
            else this.selection.add(id);
            this.anchor = i;
        } else {
            this.selection.clear();
            this.selection.add(id);
            this.anchor = i;
        }
        this.focusIndex = i;
        this.ensureVisible(i);
        this.renderRows(true);
        this.h.onSelect?.(this.selectedViews());
    }

    selectIds(ids) {
        this.selection = new Set(ids);
        const first = this.rows.findIndex((r) => this.selection.has(r.id));
        if (first >= 0) {
            this.focusIndex = first;
            this.anchor = first;
            this.ensureVisible(first);
        }
        this.renderRows(true);
        this.h.onSelect?.(this.selectedViews());
    }

    selectAll() {
        this.selection = new Set(this.rows.map((r) => r.id));
        this.renderRows(true);
        this.h.onSelect?.(this.selectedViews());
    }

    ensureVisible(i) {
        const top = i * ROW_HEIGHT;
        const vp = this.viewport;
        if (top < vp.scrollTop) vp.scrollTop = top;
        else if (top + ROW_HEIGHT > vp.scrollTop + vp.clientHeight) vp.scrollTop = top + ROW_HEIGHT - vp.clientHeight;
    }

    onKey(e) {
        if (e.target !== this.el) return;
        const n = this.rows.length;
        if (!n) return;
        const page = Math.max(1, Math.floor(this.viewport.clientHeight / ROW_HEIGHT) - 1);
        let i = this.focusIndex;
        const move = (to) => {
            e.preventDefault();
            this.selectIndex(Math.max(0, Math.min(n - 1, to)), false, e.shiftKey);
        };
        switch (e.key) {
            case "ArrowDown":
                return move(i + 1);
            case "ArrowUp":
                return move(i < 0 ? 0 : i - 1);
            case "PageDown":
                return move(i + page);
            case "PageUp":
                return move(i - page);
            case "Home":
                return move(0);
            case "End":
                return move(n - 1);
            case "Enter":
                if (i >= 0) {
                    e.preventDefault();
                    this.h.onOpen?.(this.rows[i]);
                }
                return;
            case "ContextMenu": {
                e.preventDefault();
                const r = this.body.querySelector(".et-row.focused")?.getBoundingClientRect() || this.el.getBoundingClientRect();
                this.h.onContext?.(r.left + 40, r.bottom);
                return;
            }
            default:
                // Type to find: jump to the next title starting with the typed character
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    const ch = e.key.toLowerCase();
                    for (let k = 1; k <= n; k++) {
                        const idx = (Math.max(i, 0) + k) % n;
                        if ((this.rows[idx].name || "").toLowerCase().startsWith(ch)) {
                            e.preventDefault();
                            this.selectIndex(idx, false, false);
                            return;
                        }
                    }
                }
        }
    }

    onDragStart(e) {
        const rowEl = e.target.closest(".et-row");
        if (!rowEl) return;
        const v = this.rows[Number(rowEl.dataset.index)];
        if (!this.selection.has(v.id)) this.selectIndex(Number(rowEl.dataset.index), false, false);
        const ids = [...this.selection];
        e.dataTransfer.setData("application/x-vwm-entries", JSON.stringify(ids));
        e.dataTransfer.effectAllowed = "move";
        const ghost = h("div", { class: "drag-ghost" }, ids.length === 1 ? v.name || "(no title)" : `${ids.length} entries`);
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 10, 10);
        setTimeout(() => ghost.remove(), 0);
    }
}
