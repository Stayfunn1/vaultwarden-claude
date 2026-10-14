// Organizations: creating them, members (invite, confirm, role, revoke, remove), groups and collection access.
// Everything goes through the same API as the Bitwarden web vault, so both can be used side by side.

import { h, icon, clear, dialog, confirmDialog, promptDialog, alertDialog, toast } from "./ui.js";

export const MemberStatus = Object.freeze({ Revoked: -1, Invited: 0, Accepted: 1, Confirmed: 2 });
const STATUS_NAMES = { [-1]: "Revoked", 0: "Invited", 1: "Needs confirmation", 2: "Confirmed" };
// The server shows managers as custom role (4)
const ROLES = [
    { type: 2, name: "User" },
    { type: 4, name: "Manager" },
    { type: 1, name: "Admin" },
    { type: 0, name: "Owner" },
];
const roleName = (type) => (type === 3 ? "Manager" : ROLES.find((r) => r.type === type)?.name || `Type ${type}`);
// Memberships and groups managed by the identity provider group sync (see SSO_ORG_SYNC)
const SYNC_MARKER = "vaultwarden-sso-sync";

// Bitwarden's permission levels of a collection
const ACCESS_LEVELS = [
    { key: "view", label: "Can view", readOnly: true, hidePasswords: false, manage: false },
    { key: "viewNoPw", label: "Can view, except passwords", readOnly: true, hidePasswords: true, manage: false },
    { key: "edit", label: "Can edit", readOnly: false, hidePasswords: false, manage: false },
    { key: "editNoPw", label: "Can edit, except passwords", readOnly: false, hidePasswords: true, manage: false },
    { key: "manage", label: "Can manage", readOnly: false, hidePasswords: false, manage: true },
];
const levelOf = (a) => (a.manage ? "manage" : `${a.readOnly ? "view" : "edit"}${a.hidePasswords ? "NoPw" : ""}`);
const accessOf = (key) => {
    const l = ACCESS_LEVELS.find((x) => x.key === key) || ACCESS_LEVELS[2];
    return { readOnly: l.readOnly, hidePasswords: l.hidePasswords, manage: l.manage };
};

const orgApi = (api, orgId) => ({
    members: () => api.get(`/api/organizations/${orgId}/users?includeGroups=true`).then((r) => r.data || []),
    member: (id) => api.get(`/api/organizations/${orgId}/users/${id}?includeGroups=true`),
    editMember: (id, body) => api.put(`/api/organizations/${orgId}/users/${id}`, body),
    invite: (body) => api.post(`/api/organizations/${orgId}/users/invite`, body),
    revoke: (id) => api.put(`/api/organizations/${orgId}/users/${id}/revoke`),
    restore: (id) => api.put(`/api/organizations/${orgId}/users/${id}/restore`),
    remove: (id) => api.del(`/api/organizations/${orgId}/users/${id}`),
    groups: () => api.get(`/api/organizations/${orgId}/groups`).then((r) => r.data || []),
    groupDetails: (id) => api.get(`/api/organizations/${orgId}/groups/${id}/details`),
    groupUsers: (id) => api.get(`/api/organizations/${orgId}/groups/${id}/users`),
    createGroup: (body) => api.post(`/api/organizations/${orgId}/groups`, body),
    updateGroup: (id, body) => api.put(`/api/organizations/${orgId}/groups/${id}`, body),
    deleteGroup: (id) => api.del(`/api/organizations/${orgId}/groups/${id}`),
});

const collectionAccessList = (list) =>
    (list || []).map((c) => ({ id: c.id, readOnly: !!c.readOnly, hidePasswords: !!c.hidePasswords, manage: !!c.manage }));

// ----- New organization ------------------------------------------------------------------------------

export function newOrganizationDialog(app) {
    return dialog({
        title: "New organization",
        width: "440px",
        build: (close) => {
            const name = h("input", { type: "text", class: "wide", placeholder: "e.g. Family" });
            const collection = h("input", { type: "text", class: "wide", value: "Shared" });
            const err = h("div", { class: "form-error", role: "alert" });
            const create = async () => {
                err.textContent = "";
                if (!name.value.trim()) return (err.textContent = "Enter a name.");
                if (!collection.value.trim()) return (err.textContent = "Enter a name for the first collection.");
                try {
                    const id = await app.vault.createOrganization(name.value.trim(), collection.value.trim());
                    close(id);
                } catch (e) {
                    err.textContent = e.message || String(e);
                }
            };
            return {
                body: h(
                    "div",
                    { class: "form" },
                    h("p", null, "Organizations share entries with other people. You become its owner and can invite members, put them in groups and decide which collections they see."),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "Name:"), h("div", { class: "form-controls" }, name)),
                    h("div", { class: "form-row" }, h("label", { class: "form-label" }, "First collection:"), h("div", { class: "form-controls" }, collection)),
                    err,
                ),
                buttons: [h("button", { type: "button", class: "primary", onclick: create }, "Create"), h("button", { type: "button", onclick: () => close(undefined) }, "Cancel")],
                onEnter: create,
                initialFocus: name,
            };
        },
    });
}

// ----- Organization dialog -----------------------------------------------------------------------------

export function organizationDialog(app, orgId, initialTab = "members") {
    const vault = app.vault;
    const org = vault.organizations.get(orgId);
    const api = orgApi(vault.api, orgId);
    const isOwner = org.type === 0;
    return dialog({
        title: `Organization ${org.name}`,
        className: "org-modal",
        width: "860px",
        window: true,
        key: `org:${orgId}`,
        kind: "org",
        icon: icon("org"),
        build: (close) => {
            const state = { members: [], groups: [], changed: false };
            const tabBar = h("div", { class: "tabs", role: "tablist" });
            const tabBody = h("div", { class: "tab-body org-tab-body" });
            const status = h("div", { class: "org-status muted" });
            const tabs = { members: "Members", groups: "Groups", collections: "Collections" };
            if (!org.useGroups) delete tabs.groups;
            let current = initialTab in tabs ? initialTab : "members";

            const busy = async (text, fn) => {
                status.textContent = text;
                try {
                    const r = await fn();
                    state.changed = true;
                    return r;
                } catch (e) {
                    await alertDialog(org.name, e.message || String(e));
                    return undefined;
                } finally {
                    status.textContent = "";
                    await load();
                }
            };

            const load = async () => {
                try {
                    [state.members, state.groups] = await Promise.all([api.members(), org.useGroups ? api.groups().catch(() => []) : []]);
                } catch (e) {
                    clear(tabBody).appendChild(h("div", { class: "form-error" }, e.message || String(e)));
                    return;
                }
                render();
            };

            const render = () => {
                for (const btn of tabBar.children) btn.classList.toggle("active", btn.dataset.tab === current);
                clear(tabBody);
                if (current === "members") tabBody.appendChild(membersTab());
                else if (current === "groups") tabBody.appendChild(groupsTab());
                else tabBody.appendChild(collectionsTab());
            };

            for (const [key, label] of Object.entries(tabs)) {
                tabBar.appendChild(h("button", { type: "button", class: "tab", role: "tab", "data-tab": key, onclick: () => ((current = key), render()) }, label));
            }

            // ----- Members
            const membersTab = () => {
                const emails = h("input", { type: "text", class: "wide", placeholder: "E-mail addresses, separated by commas" });
                const role = h("select", null, ROLES.filter((r) => isOwner || r.type === 2 || r.type === 4).map((r) => h("option", { value: r.type }, r.name)));
                const invite = () =>
                    busy("Inviting…", async () => {
                        const list = emails.value.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
                        if (!list.length) throw new Error("Enter at least one e-mail address.");
                        await api.invite({ emails: list, type: Number(role.value), collections: [], groups: [], permissions: {} });
                        toast(`${list.length} member(s) invited`, "ok");
                    });
                const pending = state.members.filter((m) => m.status === MemberStatus.Accepted);
                const confirmAll = pending.length
                    ? h("button", { type: "button", class: "primary", onclick: () => confirmMembers(pending) }, `Confirm ${pending.length} member(s)`)
                    : null;
                const rows = state.members
                    .slice()
                    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
                    .map((m) => memberRow(m));
                return h(
                    "div",
                    { class: "form" },
                    h("div", { class: "org-invite" }, emails, role, h("button", { type: "button", onclick: invite }, "Invite"), confirmAll || ""),
                    pending.length
                        ? h("p", { class: "org-notice" }, "Members who accepted their invitation get access to the organization's entries once you confirm them. Confirming gives them the organization key, encrypted with their own key.")
                        : "",
                    h(
                        "table",
                        { class: "org-table" },
                        h("thead", null, h("tr", null, h("th", null, "Member"), h("th", null, "Role"), h("th", null, "Status"), org.useGroups ? h("th", null, "Groups") : "", h("th", null, ""))),
                        h("tbody", null, rows),
                    ),
                );
            };

            const groupName = (id) => state.groups.find((g) => g.id === id)?.name || "?";

            const memberRow = (m) => {
                const synced = m.externalId === SYNC_MARKER;
                const self = m.userId === vault.userId;
                const canEditRole = !self && (isOwner || (m.type !== 0 && m.type !== 1));
                const roleSel = h(
                    "select",
                    { disabled: !canEditRole || synced, title: synced ? "Managed by the groups of the identity provider" : "" },
                    ROLES.filter((r) => isOwner || r.type === 2 || r.type === 4 || r.type === m.type).map((r) => h("option", { value: r.type, selected: r.type === (m.type === 3 ? 4 : m.type) }, r.name)),
                );
                roleSel.addEventListener("change", () =>
                    busy("Saving…", async () => {
                        // The update replaces the collections and groups of the member, so send the current ones back
                        const details = await api.member(m.id);
                        await api.editMember(m.id, {
                            type: Number(roleSel.value),
                            collections: collectionAccessList(details.collections),
                            groups: details.groups || [],
                            permissions: {},
                        });
                    }),
                );
                const actions = [];
                if (m.status === MemberStatus.Accepted) actions.push(h("button", { type: "button", class: "primary", onclick: () => confirmMembers([m]) }, "Confirm"));
                if (!self && canEditRole) {
                    if (m.status === MemberStatus.Revoked) {
                        actions.push(h("button", { type: "button", onclick: () => busy("Restoring…", () => api.restore(m.id)) }, "Restore"));
                    } else {
                        actions.push(
                            h("button", { type: "button", onclick: async () => {
                                if (await confirmDialog("Revoke access", `Revoke the access of ${m.email} to ${org.name}? The membership stays and can be restored.`, { ok: "Revoke", danger: true })) {
                                    await busy("Revoking…", () => api.revoke(m.id));
                                }
                            } }, "Revoke"),
                        );
                    }
                    actions.push(
                        h("button", { type: "button", onclick: async () => {
                            if (await confirmDialog("Remove member", `Remove ${m.email} from ${org.name}?${synced ? "\n\nThis membership is managed by the identity provider groups and comes back at the next sync, unless the user is removed from the group there." : ""}`, { ok: "Remove", danger: true })) {
                                await busy("Removing…", () => api.remove(m.id));
                            }
                        } }, "Remove"),
                    );
                }
                return h(
                    "tr",
                    { class: m.status === MemberStatus.Revoked ? "revoked" : "", "data-member": m.email },
                    h("td", null, h("div", null, m.name || m.email), m.name ? h("div", { class: "muted" }, m.email) : "", synced ? h("span", { class: "tag", title: "Managed by the groups of the identity provider" }, "synced") : ""),
                    h("td", null, roleSel),
                    h("td", null, h("span", { class: `member-status status-${m.status}` }, STATUS_NAMES[m.status] ?? m.status)),
                    org.useGroups ? h("td", null, (m.groups || []).map(groupName).join(", ")) : "",
                    h("td", { class: "org-actions" }, actions),
                );
            };

            const confirmMembers = (list) =>
                busy("Confirming…", async () => {
                    const failed = await vault.confirmMembers(orgId, list);
                    if (failed.length) throw new Error(`Not confirmed: ${failed.map((f) => f.error).join(", ")}`);
                    toast(`${list.length} member(s) confirmed`, "ok");
                });

            // ----- Groups
            const groupsTab = () => {
                const add = () =>
                    promptDialog("New group", "Name:").then((name) => {
                        if (!name?.trim()) return;
                        return busy("Creating…", () => api.createGroup({ name: name.trim(), accessAll: false, externalId: null, collections: [], users: [] }));
                    });
                const rows = state.groups
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((g) => {
                        const synced = g.externalId === SYNC_MARKER;
                        const members = state.members.filter((m) => (m.groups || []).includes(g.id));
                        return h(
                            "tr",
                            { "data-group": g.name },
                            h("td", null, g.name, synced ? h("span", { class: "tag", title: "Managed by the groups of the identity provider" }, "synced") : ""),
                            h("td", null, members.map((m) => m.name || m.email).join(", ") || h("span", { class: "muted" }, "no members")),
                            h(
                                "td",
                                { class: "org-actions" },
                                h("button", { type: "button", onclick: () => groupMembersDialog(g) }, "Members…"),
                                h("button", { type: "button", onclick: () => renameGroup(g) }, "Rename…"),
                                h("button", { type: "button", onclick: async () => {
                                    if (await confirmDialog("Delete group", `Delete the group "${g.name}"? Its members lose the access they got through it.`, { ok: "Delete", danger: true })) {
                                        await busy("Deleting…", () => api.deleteGroup(g.id));
                                    }
                                } }, "Delete"),
                            ),
                        );
                    });
                return h(
                    "div",
                    { class: "form" },
                    h("div", { class: "org-invite" }, h("button", { type: "button", onclick: add }, "New group…")),
                    h("p", { class: "muted" }, "Give groups access to collections in the Collections tab. Groups marked as synced follow the groups of the identity provider."),
                    h("table", { class: "org-table" }, h("thead", null, h("tr", null, h("th", null, "Group"), h("th", null, "Members"), h("th", null, ""))), h("tbody", null, rows)),
                );
            };

            // The group update replaces the collections and members, so the current ones are sent back
            const saveGroup = async (g, changes) => {
                const [details, users] = await Promise.all([api.groupDetails(g.id), api.groupUsers(g.id)]);
                await api.updateGroup(g.id, {
                    name: details.name,
                    accessAll: !!details.accessAll,
                    externalId: details.externalId ?? null,
                    collections: collectionAccessList(details.collections),
                    users,
                    ...changes,
                });
            };

            const renameGroup = async (g) => {
                const name = await promptDialog("Rename group", "Name:", g.name);
                if (!name?.trim() || name.trim() === g.name) return;
                await busy("Saving…", () => saveGroup(g, { name: name.trim() }));
            };

            const groupMembersDialog = async (g) => {
                const chosen = new Set(state.members.filter((m) => (m.groups || []).includes(g.id)).map((m) => m.id));
                const result = await dialog({
                    title: `Members of ${g.name}`,
                    width: "420px",
                    build: (closeMembers) => ({
                        body: h(
                            "div",
                            { class: "form" },
                            g.externalId === SYNC_MARKER ? h("p", { class: "org-notice" }, "This group follows the identity provider. Members you add here are removed again at their next login or sync.") : "",
                            h(
                                "div",
                                { class: "check-list" },
                                state.members.map((m) => {
                                    const cb = h("input", { type: "checkbox", checked: chosen.has(m.id) });
                                    cb.addEventListener("change", () => (cb.checked ? chosen.add(m.id) : chosen.delete(m.id)));
                                    return h("label", { class: "check" }, cb, m.name ? `${m.name} (${m.email})` : m.email);
                                }),
                            ),
                        ),
                        buttons: [h("button", { type: "button", class: "primary", onclick: () => closeMembers(true) }, "Save"), h("button", { type: "button", onclick: () => closeMembers(false) }, "Cancel")],
                    }),
                });
                if (result) await busy("Saving…", () => saveGroup(g, { users: [...chosen] }));
            };

            // ----- Collections
            const collectionsTab = () => {
                const cols = [...vault.collections.values()].filter((c) => c.organizationId === orgId).sort((a, b) => a.path.localeCompare(b.path));
                return h(
                    "div",
                    { class: "form" },
                    h("p", { class: "muted" }, "Owners and admins see all collections. Everyone else sees the collections given to them or to one of their groups."),
                    h(
                        "table",
                        { class: "org-table" },
                        h("thead", null, h("tr", null, h("th", null, "Collection"), h("th", null, ""))),
                        h(
                            "tbody",
                            null,
                            cols.map((c) =>
                                h("tr", { "data-collection": c.path }, h("td", null, c.path), h("td", { class: "org-actions" }, h("button", { type: "button", onclick: () => collectionAccessDialog(app, c.id, state) }, "Access…"))),
                            ),
                        ),
                    ),
                );
            };

            setTimeout(load, 0);
            return {
                body: h("div", { class: "org-dialog" }, tabBar, tabBody, status),
                buttons: [h("button", { type: "button", class: "primary", onclick: () => close(state.changed) }, "Close")],
                onCancel: () => close(state.changed),
            };
        },
    });
}

// ----- Collection access ---------------------------------------------------------------------------------

// Who can see a collection: groups and members with Bitwarden's permission levels
export async function collectionAccessDialog(app, collectionId, known = null) {
    const vault = app.vault;
    const col = vault.collections.get(collectionId);
    const orgId = col.organizationId;
    const org = vault.organizations.get(orgId);
    const api = orgApi(vault.api, orgId);
    let details, members, groups;
    try {
        [details, members, groups] = await Promise.all([
            vault.api.collectionDetails(orgId, collectionId),
            known?.members?.length ? known.members : api.members(),
            org.useGroups ? (known?.groups?.length ? known.groups : api.groups().catch(() => [])) : [],
        ]);
    } catch (e) {
        return alertDialog("Collection access", e.message || String(e));
    }
    const rows = [];
    const row = (kind, id, label, current, fixed) => {
        const on = h("input", { type: "checkbox", checked: !!current || !!fixed, disabled: !!fixed });
        const level = h("select", { disabled: !!fixed }, ACCESS_LEVELS.map((l) => h("option", { value: l.key, selected: current ? levelOf(current) === l.key : l.key === "edit" }, l.label)));
        const sync = () => (level.disabled = !!fixed || !on.checked);
        on.addEventListener("change", sync);
        sync();
        rows.push({ kind, id, on, level, fixed });
        return h("tr", { "data-access": label }, h("td", null, h("label", { class: "check" }, on, label)), h("td", null, fixed ? h("span", { class: "muted" }, fixed) : level));
    };
    const groupRows = groups.map((g) => row("group", g.id, `Group: ${g.name}`, details.groups?.find((x) => x.id === g.id)));
    const memberRows = members
        .filter((m) => m.status !== MemberStatus.Revoked)
        .map((m) => row("user", m.id, m.name ? `${m.name} (${m.email})` : m.email, details.users?.find((x) => x.id === m.id), m.type === 0 || m.type === 1 ? "All collections (owner or admin)" : null));
    const saved = await dialog({
        title: `Access to ${col.path}`,
        width: "620px",
        build: (close) => {
            const err = h("div", { class: "form-error", role: "alert" });
            const save = async () => {
                const pick = (kind) => rows.filter((r) => r.kind === kind && r.on.checked && !r.fixed).map((r) => ({ id: r.id, ...accessOf(r.level.value) }));
                try {
                    await vault.api.updateCollection(orgId, collectionId, {
                        name: details.name,
                        externalId: details.externalId ?? null,
                        groups: pick("group"),
                        users: pick("user"),
                    });
                    close(true);
                } catch (e) {
                    err.textContent = e.message || String(e);
                }
            };
            return {
                body: h(
                    "div",
                    { class: "form" },
                    h("table", { class: "org-table" }, h("thead", null, h("tr", null, h("th", null, "Group or member"), h("th", null, "Permission"))), h("tbody", null, groupRows, memberRows)),
                    err,
                ),
                buttons: [h("button", { type: "button", class: "primary", onclick: save }, "Save"), h("button", { type: "button", onclick: () => close(false) }, "Cancel")],
            };
        },
    });
    if (saved) toast("Access saved", "ok");
    return saved;
}

// ----- Pending confirmations -----------------------------------------------------------------------------

// Number of members waiting for confirmation per organization the user manages: Map orgId -> count
export async function pendingConfirmations(vault) {
    const result = new Map();
    for (const org of vault.organizations.values()) {
        if (!vault.canManageOrg(org.id) || !vault.orgKeys.has(org.id)) continue;
        try {
            const members = await orgApi(vault.api, org.id).members();
            const n = members.filter((m) => m.status === MemberStatus.Accepted).length;
            if (n) result.set(org.id, n);
        } catch {
            /* no access to the member list */
        }
    }
    return result;
}
