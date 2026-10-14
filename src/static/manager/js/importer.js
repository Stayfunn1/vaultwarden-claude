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

// options: { organizationId, skipExisting, signal: { cancelled }, icons: IconStore (stores the icons of entries and groups) }
// onProgress({ phase, done, total })
export async function importEntries(vault, converted, options = {}, onProgress = () => {}) {
    const organizationId = options.organizationId || null;
    const signal = options.signal || { cancelled: false };
    const result = { created: 0, skipped: 0, attachments: 0, icons: 0, failed: [], warnings: [...(converted.warnings || [])] };
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
    const phase = organizationId ? "Creating collections" : "Creating folders";
    onProgress({ phase, done, total: paths.length });
    // One level at a time, so parents always exist before their children. Paths of the same level are
    // independent of each other (nesting only comes from the names) and can be created in parallel.
    const levels = new Map();
    for (const p of new Set(paths)) {
        const depth = p.split("/").length;
        if (!levels.has(depth)) levels.set(depth, []);
        levels.get(depth).push(p);
    }
    for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
        await mapLimit(levels.get(depth), 6, async (p) => {
            checkCancelled();
            const id = organizationId ? await vault.ensureCollectionPath(organizationId, p) : await vault.ensureFolderPath(p);
            containerIds.set(p, id);
            onProgress({ phase, done: ++done, total: paths.length });
        });
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
    done = 0;
    // WebCrypto runs asynchronously, so encrypting several entries at once is a lot faster
    const prepared = await mapLimit(entries, 8, async (entry) => {
        checkCancelled();
        const view = entry.view;
        view.organizationId = organizationId;
        view.folderId = organizationId ? null : containerFor(entry);
        const cipherKey = SymmetricKey.generate();
        const req = await vault.encryptCipher(view, { organizationId, cipherKey });
        // The original dates of the entry (Vaultwarden keeps them for new items)
        if (entry.dates) {
            req.creationDate = entry.dates.created || entry.dates.modified;
            req.revisionDate = entry.dates.modified || entry.dates.created;
        }
        if (++done % 25 === 0 || done === entries.length) onProgress({ phase: "Encrypting", done, total: entries.length });
        return { entry, req, cipherKey, containerId: containerFor(entry) };
    });

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
            // Without an answer from the server (network error, proxy timeout, 5xx) the batch may or may
            // not have been stored. Retrying could create duplicates, so stop and let the user run the
            // import again: "skip existing entries" then continues where it stopped.
            if (!(e.status >= 400 && e.status < 500)) {
                throw new Error(`The import was interrupted: ${e.message}. Run the import again, entries that were already imported are skipped.`);
            }
            // The server rejected the batch (nothing was stored), find the broken entries one by one
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
    const createdIds = new Map(); // prepared entry -> cipher id, for the entries created one by one
    await mapLimit(withFiles, 3, async (p) => {
        if (signal.cancelled) return;
        let cipherId;
        try {
            cipherId = (await createSingle(vault, p, organizationId)).id;
            createdIds.set(p, cipherId);
            result.created++;
        } catch (err) {
            result.failed.push({ name: p.entry.sourceTitle, path: p.entry.folderPath, error: err.message });
            uploaded++;
            progress();
            return;
        }
        let uploadedFiles = 0;
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
                uploadedFiles++;
            } catch (err) {
                // An entry is imported completely or not at all: an incomplete entry would be skipped
                // when the import is run again, so its attachment (or long notes) would be lost.
                result.created--;
                const error = `attachment "${att.fileName}" failed: ${err.message}`;
                try {
                    await vault.api.deleteCiphersPermanently([cipherId]);
                    result.failed.push({ name: p.entry.sourceTitle, path: p.entry.folderPath, error });
                } catch {
                    result.created++;
                    result.warnings.push(`${p.entry.sourceTitle}: ${error} (the entry was imported without it)`);
                }
                uploaded++;
                progress();
                return;
            }
        }
        result.attachments += uploadedFiles;
        uploaded++;
        progress();
    });
    checkCancelled();

    onProgress({ phase: "Synchronizing", done: 0, total: 1 });
    await vault.sync();

    // Verify that every entry really is in the vault now
    const present = new Set();
    for (const c of vault.ciphers.values()) {
        if (c.deletedDate || (c.organizationId || null) !== organizationId) continue;
        if (organizationId) {
            for (const colId of c.collectionIds) {
                const col = vault.collections.get(colId);
                if (col) present.add(entryKey(col.path, c.name, c.login?.username));
            }
        } else {
            const f = c.folderId ? vault.folders.get(c.folderId) : null;
            present.add(entryKey(f ? f.path : "", c.name, c.login?.username));
        }
    }
    // ----- 6. Icons ---------------------------------------------------------------------
    if (options.icons && converted.groupIcons) {
        try {
            result.icons = await storeIcons(vault, options.icons, organizationId, prepared, createdIds, containerIds, converted.groupIcons);
        } catch (e) {
            result.warnings.push(`The icons could not be saved: ${e.message}`);
        }
    }

    const failedNames = new Set(result.failed.map((f) => entryKey(f.path, f.name, "")));
    for (const p of prepared) {
        const path = organizationId ? p.entry.folderPath || orgRootCollection : p.entry.folderPath;
        if (!present.has(entryKey(path, p.entry.view.name, p.entry.view.login?.username)) && !failedNames.has(entryKey(p.entry.folderPath, p.entry.sourceTitle, ""))) {
            result.created--;
            result.failed.push({ name: p.entry.sourceTitle, path: p.entry.folderPath, error: "not found in the vault after the import" });
        }
    }
    onProgress({ phase: "Done", done: 1, total: 1 });
    return result;
}

// The bulk import does not return the new ids, so entries are found by folder, title and user name
// (entries which are the same in all three get their icons in the order of the KeePass file)
async function storeIcons(vault, icons, organizationId, prepared, createdIds, containerIds, groupIcons) {
    if (!icons.canEdit(organizationId)) return 0;
    const candidates = new Map();
    const known = new Set(createdIds.values());
    for (const c of vault.ciphers.values()) {
        if (c.deletedDate || (c.organizationId || null) !== organizationId || known.has(c.id)) continue;
        const paths = organizationId
            ? c.collectionIds.map((id) => vault.collections.get(id)?.path).filter(Boolean)
            : [c.folderId ? vault.folders.get(c.folderId)?.path || "" : ""];
        for (const path of paths) {
            const k = entryKey(path, c.name, c.login?.username);
            if (!candidates.has(k)) candidates.set(k, []);
            candidates.get(k).push(c.id);
        }
    }
    const changes = [];
    const taken = new Set();
    for (const p of prepared) {
        if (!p.entry.icon) continue;
        let id = createdIds.get(p);
        if (!id) {
            const path = organizationId ? p.entry.folderPath || "Imported" : p.entry.folderPath || "";
            id = (candidates.get(entryKey(path, p.entry.view.name, p.entry.view.login?.username)) || []).find((c) => !taken.has(c));
        }
        if (!id) continue;
        taken.add(id);
        changes.push({ organizationId, kind: "item", id, icon: p.entry.icon });
    }
    for (const [path, icon] of groupIcons) {
        const id = containerIds.get(path);
        if (id) changes.push({ organizationId, kind: "group", id, icon });
    }
    if (changes.length) await icons.apply(changes);
    return changes.length;
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
