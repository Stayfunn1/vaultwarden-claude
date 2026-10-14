// Group tree (left pane), KeePass style.
// Bitwarden stores folders and collections flat, nesting is done by "/" in the name.
// The tree shows that nesting, including parents which only exist implicitly.

import { h, icon, clear } from "./ui.js";
import { FOLDER_DELIMITER, isSameOrDescendant } from "./vault.js";

export function folderKey(path) {
    return path ? `folder:${path}` : "vault";
}

export function collectionKey(orgId, path) {
    return path ? `col:${orgId}:${path}` : `org:${orgId}`;
}

function sortNodes(nodes) {
    nodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
    for (const n of nodes) sortNodes(n.children);
    return nodes;
}

function insertPath(root, path, makeNode) {
    const parts = path.split(FOLDER_DELIMITER);
    let parent = root;
    for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join(FOLDER_DELIMITER);
        let node = parent.children.find((c) => c.path === p);
        if (!node) {
            node = makeNode(p, parts[i - 1]);
            node.parent = parent;
            parent.children.push(node);
        }
        parent = node;
    }
    return parent;
}

// Builds the tree model from the vault
export function buildTree(vault) {
    const nodes = new Map();
    const vaultRoot = { key: "vault", kind: "vault", label: "My vault", path: "", children: [], folderIds: [], parent: null };
    nodes.set(vaultRoot.key, vaultRoot);
    for (const f of vault.folders.values()) {
        const node = insertPath(vaultRoot, f.path, (p, label) => {
            const n = { key: folderKey(p), kind: "folder", label, path: p, children: [], folderIds: [], virtual: true };
            nodes.set(n.key, n);
            return n;
        });
        node.folderIds.push(f.id);
        node.virtual = false;
    }

    const roots = [vaultRoot];
    const special = [
        { key: "fav", kind: "favorites", label: "Favorites", children: [] },
    ];
    const hasArchive = [...vault.ciphers.values()].some((c) => c.archivedDate && !c.deletedDate);
    if (hasArchive) special.push({ key: "archive", kind: "archive", label: "Archive", children: [] });

    const orgRoots = [];
    const orgs = [...vault.organizations.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const org of orgs) {
        const root = { key: collectionKey(org.id, ""), kind: "org", label: org.name, path: "", orgId: org.id, children: [], collectionIds: [], parent: null };
        nodes.set(root.key, root);
        for (const col of vault.collections.values()) {
            if (col.organizationId !== org.id) continue;
            const node = insertPath(root, col.path, (p, label) => {
                const n = { key: collectionKey(org.id, p), kind: "collection", label, path: p, orgId: org.id, children: [], collectionIds: [], virtual: true };
                nodes.set(n.key, n);
                return n;
            });
            node.collectionIds.push(col.id);
            node.virtual = false;
        }
        orgRoots.push(root);
    }

    const trash = { key: "trash", kind: "trash", label: "Trash", children: [] };
    for (const s of [...special, trash]) nodes.set(s.key, s);
    sortNodes(vaultRoot.children);
    for (const r of orgRoots) sortNodes(r.children);
    return { roots, special, orgRoots, trash, nodes };
}

// Returns the ciphers shown when a node is selected
export function ciphersForNode(vault, node, { includeSubfolders = false } = {}) {
    if (!node) return [];
    const all = [...vault.ciphers.values()];
    const active = (c) => !c.deletedDate && !c.archivedDate;
    switch (node.kind) {
        case "vault": {
            if (includeSubfolders) return all.filter(active);
            return all.filter((c) => active(c) && (!c.folderId || !vault.folders.has(c.folderId)));
        }
        case "folder": {
            const ids = new Set();
            for (const f of vault.folders.values()) {
                if (includeSubfolders ? isSameOrDescendant(f.path, node.path) : f.path === node.path) ids.add(f.id);
            }
            return all.filter((c) => active(c) && c.folderId && ids.has(c.folderId));
        }
        case "favorites":
            return all.filter((c) => c.favorite && !c.deletedDate);
        case "archive":
            return all.filter((c) => c.archivedDate && !c.deletedDate);
        case "trash":
            return all.filter((c) => c.deletedDate);
        case "org": {
            const inOrg = all.filter((c) => active(c) && c.organizationId === node.orgId);
            if (includeSubfolders) return inOrg;
            return inOrg.filter((c) => !c.collectionIds.some((id) => vault.collections.has(id)));
        }
        case "collection": {
            const ids = new Set();
            for (const col of vault.collections.values()) {
                if (col.organizationId !== node.orgId) continue;
                if (includeSubfolders ? isSameOrDescendant(col.path, node.path) : col.path === node.path) ids.add(col.id);
            }
            return all.filter((c) => active(c) && c.collectionIds.some((id) => ids.has(id)));
        }
        default:
            return [];
    }
}

function countDirect(vault, node) {
    return ciphersForNode(vault, node).length;
}

const KIND_ICON = { vault: "vault", folder: "folder", favorites: "star", archive: "archive", trash: "trash", org: "org", collection: "collection" };

// Tree view component
export class TreeView {
    constructor(container, handlers) {
        this.el = container;
        // { onSelect(node), onContext(node, x, y), onDrop(node, dataTransfer), onDragStartNode(node, e), onRename(node), ... }
        this.h = handlers;
        // Expanded nodes by key. The keys contain folder names, so the owner persists them encrypted (onExpandedChanged)
        this.expanded = {};
        this.model = null;
        this.selectedKey = "vault";
        this.rows = new Map();
        this.el.tabIndex = 0;
        this.el.setAttribute("role", "tree");
        this.el.addEventListener("keydown", (e) => this.onKey(e));
    }

    isExpanded(node) {
        const v = this.expanded[node.key];
        return v === undefined ? node.kind === "vault" || node.kind === "org" : v;
    }

    setExpanded(node, expanded) {
        this.expanded[node.key] = expanded;
        this.h.onExpandedChanged?.(this.expanded);
    }

    render(vault) {
        this.vault = vault;
        this.model = buildTree(vault);
        const scroll = this.el.scrollTop;
        clear(this.el);
        this.rows.clear();
        const counts = new Map();
        // Count direct items per node in one pass for large vaults
        const folderPathById = new Map([...vault.folders.values()].map((f) => [f.id, f.path]));
        for (const c of vault.ciphers.values()) {
            if (c.deletedDate) {
                counts.set("trash", (counts.get("trash") || 0) + 1);
                continue;
            }
            if (c.favorite) counts.set("fav", (counts.get("fav") || 0) + 1);
            if (c.archivedDate) {
                counts.set("archive", (counts.get("archive") || 0) + 1);
                continue;
            }
            const fp = c.folderId ? folderPathById.get(c.folderId) : undefined;
            const fk = fp !== undefined ? folderKey(fp) : "vault";
            counts.set(fk, (counts.get(fk) || 0) + 1);
            if (c.organizationId) {
                let assigned = false;
                for (const colId of c.collectionIds) {
                    const col = vault.collections.get(colId);
                    if (!col) continue;
                    assigned = true;
                    const ck = collectionKey(col.organizationId, col.path);
                    counts.set(ck, (counts.get(ck) || 0) + 1);
                }
                if (!assigned) counts.set(collectionKey(c.organizationId, ""), (counts.get(collectionKey(c.organizationId, "")) || 0) + 1);
            }
        }
        this.counts = counts;

        const list = h("ul", { class: "tree-root", role: "group" });
        for (const r of this.model.roots) list.appendChild(this.renderNode(r, 0));
        for (const s of this.model.special) list.appendChild(this.renderNode(s, 0));
        if (this.model.orgRoots.length) {
            list.appendChild(h("li", { class: "tree-heading" }, "Organizations"));
            for (const r of this.model.orgRoots) list.appendChild(this.renderNode(r, 0));
        }
        list.appendChild(h("li", { class: "tree-sep" }));
        list.appendChild(this.renderNode(this.model.trash, 0));
        this.el.appendChild(list);
        if (!this.model.nodes.has(this.selectedKey)) this.selectedKey = "vault";
        this.markSelected();
        this.el.scrollTop = scroll;
    }

    renderNode(node, depth) {
        const hasChildren = node.children.length > 0;
        const expanded = hasChildren && this.isExpanded(node);
        const count = this.counts.get(node.key) || 0;
        const caret = h(
            "span",
            { class: `tree-caret${hasChildren ? "" : " empty"}`, onclick: (e) => {
                e.stopPropagation();
                if (hasChildren) this.toggle(node);
            } },
            hasChildren ? icon(expanded ? "caretDown" : "caretRight") : "",
        );
        let iconName = KIND_ICON[node.kind] || "folder";
        if (node.kind === "folder" && expanded) iconName = "folderOpen";
        const row = h(
            "div",
            {
                class: `tree-row${node.virtual ? " virtual" : ""}`,
                dataset: { key: node.key },
                style: { paddingLeft: `${4 + depth * 16}px` },
                draggable: node.kind === "folder" || node.kind === "collection" ? "true" : null,
                title: node.virtual ? `${node.path} (implicit folder, created when needed)` : node.path || node.label,
            },
            caret,
            this.h.groupIcon?.(node) || icon(iconName),
            h("span", { class: "tree-label" }, node.label),
            count ? h("span", { class: "tree-count" }, String(count)) : "",
        );
        row.addEventListener("click", () => this.select(node.key, true));
        row.addEventListener("dblclick", () => hasChildren && this.toggle(node));
        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.select(node.key, true);
            this.h.onContext?.(node, e.clientX, e.clientY);
        });
        // Drag & drop
        row.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("application/x-vwm-node", node.key);
            e.dataTransfer.effectAllowed = "move";
            this.h.onDragStartNode?.(node, e);
        });
        row.addEventListener("dragover", (e) => {
            if (this.h.canDrop?.(node, e.dataTransfer)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                row.classList.add("drop-target");
                // Expand collapsed nodes when hovering during a drag
                if (hasChildren && !expanded && !row._expandTimer) {
                    row._expandTimer = setTimeout(() => this.toggle(node, true), 700);
                }
            }
        });
        row.addEventListener("dragleave", () => {
            row.classList.remove("drop-target");
            clearTimeout(row._expandTimer);
            row._expandTimer = null;
        });
        row.addEventListener("drop", (e) => {
            row.classList.remove("drop-target");
            clearTimeout(row._expandTimer);
            row._expandTimer = null;
            e.preventDefault();
            this.h.onDrop?.(node, e.dataTransfer);
        });
        this.rows.set(node.key, row);
        const li = h("li", { role: "treeitem", "aria-expanded": hasChildren ? String(expanded) : null }, row);
        if (expanded) {
            const ul = h("ul", { role: "group" });
            for (const c of node.children) ul.appendChild(this.renderNode(c, depth + 1));
            li.appendChild(ul);
        }
        return li;
    }

    toggle(node, force) {
        const expanded = force !== undefined ? force : !this.isExpanded(node);
        this.setExpanded(node, expanded);
        this.render(this.vault);
    }

    expandAll(expand) {
        for (const n of this.model.nodes.values()) {
            if (n.children && n.children.length) this.expanded[n.key] = expand;
        }
        this.h.onExpandedChanged?.(this.expanded);
        this.render(this.vault);
    }

    // Make sure the path to a node is expanded
    reveal(key) {
        const node = this.model?.nodes.get(key);
        if (!node) return;
        let changed = false;
        for (let p = node.parent; p; p = p.parent) {
            if (!this.isExpanded(p)) {
                this.expanded[p.key] = true;
                changed = true;
            }
        }
        if (changed) {
            this.h.onExpandedChanged?.(this.expanded);
            this.render(this.vault);
        }
    }

    get selected() {
        return this.model?.nodes.get(this.selectedKey) || null;
    }

    select(key, notify = false) {
        this.selectedKey = key;
        this.reveal(key);
        this.markSelected();
        if (notify) this.h.onSelect?.(this.selected);
    }

    markSelected() {
        for (const [key, row] of this.rows) {
            row.classList.toggle("selected", key === this.selectedKey);
            row.setAttribute("aria-selected", String(key === this.selectedKey));
        }
        this.rows.get(this.selectedKey)?.scrollIntoView({ block: "nearest" });
    }

    visibleKeys() {
        return [...this.el.querySelectorAll(".tree-row")].map((r) => r.dataset.key);
    }

    onKey(e) {
        if (e.target !== this.el) return;
        const node = this.selected;
        const keys = this.visibleKeys();
        const i = keys.indexOf(this.selectedKey);
        switch (e.key) {
            case "ArrowDown":
                if (i < keys.length - 1) this.select(keys[i + 1], true);
                break;
            case "ArrowUp":
                if (i > 0) this.select(keys[i - 1], true);
                break;
            case "ArrowRight":
                if (node?.children.length && !this.isExpanded(node)) this.toggle(node, true);
                else if (node?.children.length) this.select(node.children[0].key, true);
                break;
            case "ArrowLeft":
                if (node?.children.length && this.isExpanded(node)) this.toggle(node, false);
                else if (node?.parent) this.select(node.parent.key, true);
                break;
            case "Home":
                this.select(keys[0], true);
                break;
            case "End":
                this.select(keys[keys.length - 1], true);
                break;
            case "F2":
                this.h.onRename?.(node);
                break;
            case "Delete":
                this.h.onDelete?.(node);
                break;
            case "Insert":
                this.h.onAddChild?.(node);
                break;
            default:
                return;
        }
        e.preventDefault();
    }
}
