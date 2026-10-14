-- Groups reported by the identity provider (JSON array), used for access rules and organization sync
ALTER TABLE sso_users ADD COLUMN idp_groups TEXT;
-- Set when the directory sync disabled the user, so it is enabled again when the user returns
ALTER TABLE sso_users ADD COLUMN disabled_by_sync BOOLEAN NOT NULL DEFAULT FALSE;
