# Sharing passwords: organizations, collections and groups

Sharing works the Bitwarden way, and all of it is already part of Vaultwarden:

* An **organization** owns shared items. Every member who has access to an item gets it in their own
  vault, in every app, and changes are pushed to all of them automatically (live sync).
* **Collections** are the "folders" of an organization and decide who can access which items.
  Like personal folders they can be nested with `/` (`Infra/Servers`).
* **Groups** bundle members (`Admins`, `Family`, `Developers`) so you give a group access to a
  collection instead of every person individually.
* Your **personal folders** stay personal: they only organize your own view. A shared item can be in
  one of your folders and in a collection at the same time.

## Enabling groups

Groups are a beta feature in Vaultwarden and are disabled by default:

```env
ORG_GROUPS_ENABLED=true
```

## Setting it up

In the web manager (`https://<your-domain>/manager/`), see [web-manager.md](web-manager.md#organizations):
*Organizations → New organization…*, then *Organizations → <name>…* to invite and confirm members,
create groups and give them access to collections.

Or in the Bitwarden web vault (`https://<your-domain>/`):

1. **New organization** (any plan name, everything is free on Vaultwarden).
2. *Admin Console → Members → Invite member*. With `SSO_ONLY=true` invited people join by logging in
   with SSO.
3. *Admin Console → Groups → New group*, add members.
4. *Collections → New collection*, and under *Access* give groups or members *Can view*,
   *Can view, except passwords*, *Can edit*, *Can edit, except passwords* or *Can manage*.
5. Owners and admins confirm new members (*Members → Confirm*), this exchanges the encryption key.

## Sharing items with the web manager

In the manager (`https://<your-domain>/manager/`) your organizations and their collections are shown
below your own folders:

* **Drag personal entries onto a collection** to move them into the organization (or select them and
  use *Move to organization…*). They are re-encrypted with the organization key in your browser; their
  attachments, custom fields and history come along.
* Drag organization entries onto another collection of the same organization to move them there, or
  use *Collections…* to put an entry in several collections.
* Add, rename (<kbd>F2</kbd>) and delete collections from the tree (requires the *manage* permission).
  Renaming a collection renames its sub collections too.
* *Manage organization…* in the context menu of an organization opens its members, groups and
  collections; *Collection access…* on a collection decides who sees it.
* A KeePass database can be imported directly into an organization: the KeePass groups become nested
  collections. This is a quick way to share a team KeePass database.

## Organizations from Keycloak groups

With an identity provider, memberships, roles and groups can follow its groups (for example
`/vaultwarden/Family/admins`), and only selected people may create organizations. See
[keycloak.md](keycloak.md) and [permissions.md](permissions.md).

## Adding passwords automatically ("pushing" from scripts)

The server can not create items on its own, because it never sees plain text (end-to-end encryption).
Scripts can add or update items with the official Bitwarden CLI, which encrypts on the client:

```sh
bw config server https://vault.example.com
bw login --apikey             # personal API key from Account settings → Security → Keys
export BW_SESSION=$(bw unlock --raw)
bw get template item | jq '.name="db-prod" | .login={username:"app",password:"s3cret"} |
  .organizationId="<org-id>" | .collectionIds=["<collection-id>"]' | bw encode | bw create item
```

Items created like this in an organization collection appear at every member with access, just like
items created in the apps. (With `SSO_ONLY=true`, `bw login --apikey` needs `SSO_ONLY_ALLOW_API_KEY=true`,
which is the default.)
