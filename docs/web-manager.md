# Web manager and KeePass import

This fork ships an extra web client, the **web manager**, at `https://<your-domain>/manager/`.
It is a compact vault manager in the style of KeePass 2, built for large vaults with many folders,
and it contains a KeePass importer that also moves your attachments, custom fields and history.

It does not replace anything: the normal Bitwarden web vault, browser extension, desktop and mobile
apps and the CLI keep working exactly as before, on the same data, at the same time.

## How it works (and why it is safe to mix with the Bitwarden apps)

Like every Bitwarden client, the manager does all encryption in your browser. It derives your keys
from your master password, decrypts the vault locally, and encrypts every change before it is sent.
The server only ever stores encrypted data, also for KeePass imports: the `.kdbx` file is opened in
the browser and its password is never sent anywhere.

It writes data exactly like the current official clients do (an individual key per item, URI
checksums, password history, attachments encrypted with their own key), so everything created or
changed in the manager is immediately usable in all Bitwarden apps, and the other way around.
This is verified with the official Bitwarden CLI.

## Logging in

* E-mail + master password, with two-step login (authenticator app, e-mail, YubiKey OTP, FIDO2
  security keys). Duo is not supported in the manager, use the Bitwarden web vault for that.
* Single sign-on (OpenID Connect) when `SSO_ENABLED=true`. With `SSO_ONLY=true` the manager only offers
  SSO. After SSO you unlock the vault with your master password, see [sso-only.md](sso-only.md).
* The vault locks after 15 minutes of inactivity (Tools → Options, also when the tab is hidden if you
  want) and on <kbd>Ctrl</kbd>+<kbd>L</kbd>.
  Reloading the page also locks it; logging in again is only needed after logging out.

New accounts created by single sign-on (or by the Keycloak directory sync) choose their master password
at their first SSO login in the manager, like in the Bitwarden apps.

## Migrating from KeePass

1. Log in to the manager.
2. **File → Import KeePass database…**
3. Choose your `.kdbx` file, enter its master password and/or key file, and click **Open**.
   Supported: KDBX 3.1 and 4.x with AES or ChaCha20, AES-KDF, Argon2d and Argon2id (KeePass 2.x and
   KeePassXC defaults). For anything else (for example Twofish) use KeePass' *File → Export →
   KeePass XML (2.x)* and import that XML file instead (delete the XML file afterwards, it is not encrypted).
4. Check the summary and options, choose where to import (your own vault or an organization) and
   optionally a parent folder such as `KeePass`, then click **Import**.

What is imported, and how:

| KeePass                                        | Bitwarden / Vaultwarden                                                 |
|------------------------------------------------|--------------------------------------------------------------------------|
| Group tree                                     | Nested folders (`Internet/Mail`), or nested collections in an organization |
| Empty groups                                   | Folders (optional)                                                      |
| Title, User name, Password, URL, Notes         | Name, Username, Password, first URI, Notes                              |
| Additional URLs (`KP2A_URL…`, KeePassXC)       | Additional URIs                                                          |
| Custom string fields                           | Custom fields, copyable in every Bitwarden app                          |
| Protected custom fields ("Enable in-memory protection") | Hidden custom fields                                           |
| Attachments                                    | Attachments (encrypted)                                                 |
| TOTP (`otp`, KeePass 2.47+ `TimeOtp-*`, `TOTP Seed`) | Authenticator key (TOTP), incl. custom period/digits/algorithm and Steam |
| History                                        | Password history (last 5 different passwords)                           |
| Tags / expiry date                             | Custom fields `Tags` / `Expires` (optional)                             |
| Field references `{REF:U@I:…}`                 | Replaced by the referenced value (Bitwarden has no references)          |
| Recycle bin                                    | Skipped (optional)                                                       |
| Group names containing `/`                     | `/` is replaced by `∕`, otherwise it would create extra nesting         |
| Icons of entries and groups (standard and custom) | Icons in the manager (optional), see [Icons](#icons)                 |

Bitwarden limits notes to about 7,500 characters and custom fields to a few thousand. Longer values
are not cut off: they are stored completely as a `.txt` attachment (e.g. `notes.txt`) and the note
or field points to it.

Tips:

* **Skip entries that already exist** is on by default, so if an import is interrupted you can simply
  run it again: entries with the same folder, title and user name are not created twice.
* Attachments count against `USER_ATTACHMENT_LIMIT` / `ORG_ATTACHMENT_LIMIT` if you set those. If a
  reverse proxy is in front of Vaultwarden, make sure it allows large request bodies (for nginx
  `client_max_body_size 525m;`), otherwise big attachments or import batches fail.
* Importing into an organization requires owner/admin (or "manage all collections") rights there;
  entries from the root group go into a collection named `Imported`.

## Working with folders

Bitwarden stores folders as a flat list, nesting comes from `/` in the name (`Banking/EU`). The
Bitwarden apps show this as a tree, but renaming or moving a folder there leaves its sub folders behind.
The manager treats the tree as a real tree:

* **Rename** (<kbd>F2</kbd>) or **move** a folder (drag it onto another folder, or *Group → Move folder to…*)
  and all its sub folders and entries come along.
* **Delete** a folder (<kbd>Del</kbd> in the tree) together with its sub folders; the entries are either
  moved to the trash (like KeePass' recycle bin) or kept in the parent folder.
* **Drag entries** onto a folder to move them; select many with <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+click.
* Folders shown in *italics* only exist implicitly (an `a/b` folder without an `a` folder). They are
  created automatically when you put something in them; *Group → Create missing parent folders* creates
  them all, so every Bitwarden app nests the tree the same way.
* *Group → Merge duplicate folders* and *Delete empty folders…* clean up after messy imports.
* *View → Show entries of sub folders* lists everything below the selected folder (KeePass 2 behaviour).

Organizations appear below your own folders with their collections. Dragging personal entries onto
a collection moves them into the organization (see [sharing.md](sharing.md)).

## Organizations

The **Organizations** menu creates organizations (*New organization…*, if you are allowed to, see
[permissions.md](permissions.md)) and opens the ones you manage as owner or admin:

* **Members**: invite people by e-mail address, choose their role, **confirm** members who accepted
  their invitation (this gives them the organization key, encrypted with their own key), revoke,
  restore and remove them. A notice in the status bar shows members waiting for confirmation.
* **Groups** (with `ORG_GROUPS_ENABLED=true`): create, rename and delete groups and choose their members.
* **Collections**: decide which groups and members see a collection, with Bitwarden's permission levels
  (*Can view*, *Can view, except passwords*, *Can edit*, *Can edit, except passwords*, *Can manage*).
  The same dialog opens with *Collection access…* in the context menu of a collection.

Memberships and groups that follow your identity provider (`SSO_ORG_SYNC`, see [keycloak.md](keycloak.md))
are marked *synced*; their role is managed there.

## Icons

Entries, folders and collections can have their own icon, like in KeePass:

* The KeePass import takes over the icons of entries and groups: the 69 standard icons (shown with
  matching [Lucide](https://lucide.dev) icons, as the KeePass images can not be redistributed) and
  custom icons (the original images).
* *Change icon…* in the context menu of entries (also several at once), folders and collections, or the
  icon button next to the title in the entry editor. Pick a standard icon, a custom icon, add an image,
  or go back to the default icon.
* *View → Show website icons* shows the icon of the website of logins without their own icon, from the
  icon service of Vaultwarden (off by default, as it requests the icons through the server).

The Bitwarden apps have no icons for items and would drop unknown data when saving an item, so the
icons are stored next to the vault: one document for your own vault and one per organization, encrypted
with your key or the organization key in the browser. Everyone with access to an organization sees its
icons; managers, admins and owners can change them.

## Windows

Entries, the password generator and organizations open in **windows**, so you can keep several open next
to each other while you keep working in the main window:

* Drag a window by its title bar, resize it at its lower right corner. Every dialog can be moved this way.
* **–** minimizes a window into the **taskbar** at the bottom, **□** (or a double-click on the title bar)
  maximizes it. Click a window in the taskbar to bring it back or to minimize it; right-click it for more.
* **Windows** menu: *Cascade*, *Tile*, *Side by side*, *Minimize all*, *Restore all*, *Close all*, and
  a list of the open windows.
* Opening an entry that is already open brings its window to the front.
* The size of entry, generator and organization windows is remembered.
* Keyboard shortcuts of the main window do not apply inside a window; <kbd>Esc</kbd> closes the window,
  <kbd>Ctrl</kbd>+<kbd>L</kbd> locks everywhere. Locking closes all windows.

Prefer one editor at a time? Switch off *Open entries in windows* in the options.

## Options

**Tools → Options** has most of what KeePassXC offers that makes sense in a browser:

| Tab | Options |
|---|---|
| General | entries in windows, what a double-click on an entry does (KeePass behaviour, open, or open the URL), asking before moving to the trash, entries of sub folders, the folder shown after unlocking (last used, My vault, Favorites), how often changes from other devices are fetched, remembering the e-mail address |
| Interface | theme, accent color, font size, row spacing (compact, normal, comfortable), toolbar (icons, icons and text, hidden), status bar, entry details, alternating row colors, grid lines, date format (ISO, browser, relative), website icons, monospace passwords, colored digits and special characters, hiding user names in the list, passwords in the list, hiding notes until clicked |
| Security | clearing the clipboard (after a time and when locking), locking after inactivity, locking when the tab is hidden or the window minimized, showing passwords in the editor |
| Search | searching passwords and protected fields, case sensitivity, only the selected folder, keeping the search when another folder is selected |

*Defaults* resets them (columns and layout stay). The options are stored in this browser, per device.

## Dark mode

The sun/moon button in the toolbar (and on the login page) switches between light and dark.
*View → Theme* also offers *Follow system*, the default.

## Keyboard shortcuts

| Shortcut | Action | Shortcut | Action |
|---|---|---|---|
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Copy user name | <kbd>Ctrl</kbd>+<kbd>I</kbd> / <kbd>Insert</kbd> | Add entry |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Copy password | <kbd>Enter</kbd> / <kbd>Ctrl</kbd>+<kbd>E</kbd> | Edit entry |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> | Copy TOTP code | <kbd>Ctrl</kbd>+<kbd>K</kbd> | Duplicate entry |
| <kbd>Ctrl</kbd>+<kbd>U</kbd> | Open URL | <kbd>Del</kbd> | Move to trash (in the trash: delete permanently) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd> | Copy URL | <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>F3</kbd> | Search |
| <kbd>Ctrl</kbd>+<kbd>G</kbd> | Password generator | <kbd>F5</kbd> | Synchronize |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Lock | <kbd>F2</kbd> (tree) | Rename folder |

Double-click a user name or password cell to copy it, a URL to open it, anything else to edit the entry
(this can be changed in the options).
Custom fields are copied from the context menu (*Copy field*) or with the copy buttons in the details pane.
The clipboard is cleared after 20 seconds (Tools → Options).

## Configuration

| Variable | Default | |
|---|---|---|
| `WEB_MANAGER_ENABLED` | `true` | Serve the manager at `/manager/`. Independent of `WEB_VAULT_ENABLED`. |

The manager is part of the Vaultwarden binary, no extra files or containers are needed.
