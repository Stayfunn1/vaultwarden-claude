// Icons of entries, folders and collections, stored next to the vault.
//
// The Bitwarden data model has no icons, so they are kept in one document per owner: the user (personal
// entries and folders) and every organization (its entries and collections). The documents are encrypted
// with the user key or the organization key before they leave the browser:
//   { v: 1, items: { <cipher id>: ref }, groups: { <folder or collection id>: ref }, custom: { <hash>: <data URL> } }
// A ref is "s:<KeePass icon number>" or "c:<hash>" (a custom image of the same document).

import { encryptString, decryptString, sha256, utf8 } from "./bwcrypto.js";

const PERSONAL = "me";

const emptyDoc = () => ({ v: 1, items: {}, groups: {}, custom: {} });

async function imageHash(dataUrl) {
    const digest = await sha256(utf8(dataUrl));
    return [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class IconStore {
    constructor(vault) {
        this.vault = vault;
        this.docs = new Map(); // owner -> document
    }

    static owner(organizationId) {
        return organizationId || PERSONAL;
    }

    keyFor(owner) {
        return owner === PERSONAL ? this.vault.userKey : this.vault.orgKeys.get(owner);
    }

    async load() {
        const res = await this.vault.api.get("/api/manager/icons");
        const docs = new Map();
        const read = async (owner, entry) => {
            const key = this.keyFor(owner);
            if (!entry?.data || !key) return;
            try {
                docs.set(owner, { ...emptyDoc(), ...JSON.parse(await decryptString(entry.data, key)) });
            } catch (e) {
                console.error(`Unable to read the icons of ${owner}`, e);
            }
        };
        await read(PERSONAL, res.personal);
        for (const [orgId, entry] of Object.entries(res.organizations || {})) await read(orgId, entry);
        this.docs = docs;
    }

    resolve(doc, ref) {
        if (!doc || !ref) return null;
        if (ref.startsWith("s:")) return { standard: Number(ref.slice(2)), ref };
        if (ref.startsWith("c:")) {
            const image = doc.custom[ref.slice(2)];
            return image ? { image, ref } : null;
        }
        return null;
    }

    itemIcon(view) {
        const doc = this.docs.get(IconStore.owner(view.organizationId));
        return this.resolve(doc, doc?.items[view.id]);
    }

    groupIcon(id, organizationId) {
        const doc = this.docs.get(IconStore.owner(organizationId));
        return this.resolve(doc, doc?.groups[id]);
    }

    // The custom images an owner has, for the icon picker: [{ ref, image }]
    customImages(organizationId) {
        const doc = this.docs.get(IconStore.owner(organizationId));
        return Object.entries(doc?.custom || {}).map(([hash, image]) => ({ ref: `c:${hash}`, image }));
    }

    // Personal icons can always be changed, organization icons by managers, admins and owners
    canEdit(organizationId) {
        if (!organizationId) return true;
        const org = this.vault.organizations.get(organizationId);
        return !!org && this.vault.orgKeys.has(organizationId) && [0, 1, 3, 4].includes(org.type);
    }

    // changes: [{ organizationId, kind: "item" | "group", id, icon }] where icon is { standard }, { ref },
    // { image: <data URL> } or null (back to the default icon). Saves every changed document.
    async apply(changes) {
        const byOwner = new Map();
        for (const c of changes) {
            const owner = IconStore.owner(c.organizationId);
            if (!byOwner.has(owner)) byOwner.set(owner, []);
            byOwner.get(owner).push(c);
        }
        for (const [owner, list] of byOwner) {
            const key = this.keyFor(owner);
            if (!key) throw new Error("Missing key to save the icons");
            const doc = structuredClone(this.docs.get(owner) || emptyDoc());
            for (const c of list) {
                const map = c.kind === "group" ? doc.groups : doc.items;
                let ref = null;
                if (c.icon?.standard !== undefined) ref = `s:${c.icon.standard}`;
                else if (c.icon?.image) {
                    const hash = await imageHash(c.icon.image);
                    doc.custom[hash] = c.icon.image;
                    ref = `c:${hash}`;
                } else if (c.icon?.ref) ref = c.icon.ref;
                if (ref) map[c.id] = ref;
                else delete map[c.id];
            }
            this.prune(owner, doc);
            const data = await encryptString(JSON.stringify(doc), key);
            await this.vault.api.put(owner === PERSONAL ? "/api/manager/icons" : `/api/manager/organizations/${owner}/icons`, { data });
            this.docs.set(owner, doc);
        }
    }

    // Removes the icons of deleted entries, folders and collections, and images nothing uses any more
    prune(owner, doc) {
        const orgId = owner === PERSONAL ? null : owner;
        // Only owners and admins see every item and collection of an organization
        const seesAll = !orgId || [0, 1].includes(this.vault.organizations.get(orgId)?.type);
        if (!seesAll) return;
        for (const id of Object.keys(doc.items)) {
            const c = this.vault.ciphers.get(id);
            if (!c || (c.organizationId || null) !== orgId) delete doc.items[id];
        }
        for (const id of Object.keys(doc.groups)) {
            const exists = orgId ? this.vault.collections.has(id) : this.vault.folders.has(id);
            if (!exists) delete doc.groups[id];
        }
        const used = new Set([...Object.values(doc.items), ...Object.values(doc.groups)]);
        for (const hash of Object.keys(doc.custom)) {
            if (!used.has(`c:${hash}`)) delete doc.custom[hash];
        }
    }
}
