// Uploads converted KeePass entries into the vault.
//
// Entries without attachments are sent in batches through the bulk import API (fast), entries
// with attachments are created one by one so their attachments can be uploaded afterwards.
// Everything is encrypted in the browser before it is sent.

import { SymmetricKey, encryptString, encryptBytes, encryptFile } from "./bwcrypto.js";
import { mapLimit, normalizeFolderPath } from "./vault.js";

const BATCH_COUNT = 250;
const BATCH_BYTES = 8 * 1024 * 1024;

function entryKey(path, name, username) {
    return [normalizeFolderPath(path || "").toLowerCase(), (name || "").toLowerCase(), (username || "").toLowerCase()].join("\u0000");
}

// options: { organizationId, skipExisting, signal: { cancelled } }
// onProgress({ phase, done, total })
export async function importEntries(vault, converted, options = {}, onProgress = () => {}) {
    const organizationId = options.organizationId || null;
    const signal = options.signal || { cancelled: false };
    const result = { created: 0, skipped: 0, attachments: 0, failed: [], warnings: [...(converted.warnings || [])] };
    const checkCancelled = () => {
        if (signal.cancelled) throw new Error("Import cancelled");
    };

    // ----- 1. Folders or collections ----------------------------------------------------
    const containerIds = new Map(); // path -> folder id or collection id
    const usedPaths = new Set(converted.entries.map((e) => e.folderPath).filter(Boolean));
    const paths = organizationId
        ? [...new Set([...converted.folderPaths].filter((p) => usedPaths.has(p) || options.createEmptyCollections))]
        : converted.folderPaths;
    // Org items always need a collection, entries in the root group go to the "Imported" collection
    const orgRootCollection = "Imported";
    if (organizationId && converted.entries.some((e) => !e.folderPath)) paths.push(orgRootCollection);

    let done = 0;
    onProgress({ phase: organizationId ? "Creating collections" : "Creating folders", done, total: paths.length });
    // Parents first, so `ensure*` never has to create them on the fly
    const sorted = [...paths].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    for (const p of sorted) {
        checkCancelled();
        const id = organizationId ? await vault.ensureCollectionPath(organizationId, p) : await vault.ensureFolderPath(p);
        containerIds.set(p, id);
        onProgress({ phase: organizationId ? "Creating collections" : "Creating folders", done: ++done, total: paths.length });
    }
    const containerFor = (entry) => {
        if (organizationId) return containerIds.get(entry.folderPath || orgRootCollection);
        return entry.folderPath ? containerIds.get(entry.folderPath) : null;
    };

    // ----- 2. Skip entries which already exist ----------------------------------------
    let entries = converted.entries;
    if (options.skipExisting) {
        const existing = new Set();
        for (const c of vault.ciphers.values()) {
            if (c.deletedDate || (c.organizationId || null) !== organizationId) continue;
            if (organizationId) {
                for (const colId of c.collectionIds) {
                    const col = vault.collections.get(colId);
                    if (col) existing.add(entryKey(col.path, c.name, c.login?.username));
                }
            } else {
                const f = c.folderId ? vault.folders.get(c.folderId) : null;
                existing.add(entryKey(f ? f.path : "", c.name, c.login?.username));
            }
        }
        entries = entries.filter((e) => {
            const path = organizationId ? e.folderPath || orgRootCollection : e.folderPath;
            if (existing.has(entryKey(path, e.view.name, e.view.login?.username))) {
                result.skipped++;
                return false;
            }
            return true;
        });
    }

    // ----- 3. Encrypt -----------------------------------------------------------------
    const prepared = [];
    done = 0;
    for (const entry of entries) {
        checkCancelled();
        const view = entry.view;
        view.organizationId = organizationId;
        view.folderId = organizationId ? null : containerFor(entry);
        const cipherKey = SymmetricKey.generate();
        const req = await vault.encryptCipher(view, { organizationId, cipherKey });
        prepared.push({ entry, req, cipherKey, containerId: containerFor(entry) });
        if (++done % 25 === 0 || done === entries.length) onProgress({ phase: "Encrypting", done, total: entries.length });
    }

    const plain = prepared.filter((p) => !p.entry.attachments.length);
    const withFiles = prepared.filter((p) => p.entry.attachments.length);
    const total = prepared.length;
    let uploaded = 0;
    const progress = () => onProgress({ phase: "Uploading entries", done: uploaded, total });

    // ----- 4. Bulk import of entries without attachments ------------------------------
    const batches = [];
    let current = [];
    let size = 0;
    for (const p of plain) {
        const s = JSON.stringify(p.req).length;
        if (current.length && (current.length >= BATCH_COUNT || size + s > BATCH_BYTES)) {
            batches.push(current);
            current = [];
            size = 0;
        }
        current.push(p);
        size += s;
    }
    if (current.length) batches.push(current);

    for (const batch of batches) {
        checkCancelled();
        try {
            await sendBatch(vault, batch, organizationId);
            result.created += batch.length;
        } catch (e) {
            // Find the broken entries by sending them one by one
            for (const p of batch) {
                try {
                    await createSingle(vault, p, organizationId);
                    result.created++;
                } catch (err) {
                    result.failed.push({ name: p.entry.sourceTitle, path: p.entry.folderPath, error: err.message });
                }
            }
        }
        uploaded += batch.length;
        progress();
    }

    // ----- 5. Entries with attachments ------------------------------------------------
    await mapLimit(withFiles, 3, async (p) => {
        if (signal.cancelled) return;
        let cipherId;
        try {
            cipherId = (await createSingle(vault, p, organizationId)).id;
            result.created++;
        } catch (err) {
            result.failed.push({ name: p.entry.sourceTitle, path: p.entry.folderPath, error: err.message });
            uploaded++;
            progress();
            return;
        }
        for (const att of p.entry.attachments) {
            try {
                const attKey = SymmetricKey.generate();
                const encData = await encryptFile(att.data, attKey);
                await vault.api.uploadAttachment(
                    cipherId,
                    await encryptString(att.fileName, p.cipherKey),
                    await encryptBytes(attKey.raw, p.cipherKey),
                    encData,
                );
                result.attachments++;
            } catch (err) {
                result.warnings.push(`${p.entry.sourceTitle}: attachment "${att.fileName}" failed: ${err.message}`);
            }
        }
        uploaded++;
        progress();
    });
    checkCancelled();

    onProgress({ phase: "Synchronizing", done: 0, total: 1 });
    await vault.sync();
    onProgress({ phase: "Done", done: 1, total: 1 });
    return result;
}

async function sendBatch(vault, batch, organizationId) {
    if (organizationId) {
        const colIndex = new Map();
        const collections = [];
        const rel = [];
        batch.forEach((p, i) => {
            if (!p.containerId) return;
            if (!colIndex.has(p.containerId)) {
                colIndex.set(p.containerId, collections.length);
                const col = vault.collections.get(p.containerId);
                collections.push({ id: p.containerId, name: col?.name || "", externalId: null });
            }
            rel.push({ key: i, value: colIndex.get(p.containerId) });
        });
        await vault.api.importOrgCiphers(organizationId, {
            ciphers: batch.map((p) => p.req),
            collections,
            collectionRelationships: rel,
        });
        return;
    }
    const folderIndex = new Map();
    const folders = [];
    const rel = [];
    for (let i = 0; i < batch.length; i++) {
        const id = batch[i].containerId;
        if (!id) continue;
        if (!folderIndex.has(id)) {
            folderIndex.set(id, folders.length);
            // The name is ignored for existing folders, but required by the API
            folders.push({ id, name: await encryptString(vault.folders.get(id)?.name || "", vault.userKey) });
        }
        rel.push({ key: i, value: folderIndex.get(id) });
    }
    await vault.api.importCiphers({ ciphers: batch.map((p) => p.req), folders, folderRelationships: rel });
}

async function createSingle(vault, p, organizationId) {
    if (organizationId) {
        return vault.api.createOrgCipher(p.req, p.containerId ? [p.containerId] : []);
    }
    return vault.api.createCipher(p.req);
}
