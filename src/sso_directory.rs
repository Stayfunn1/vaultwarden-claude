//! Directory sync with Keycloak, so changes apply without waiting for a login of the user.
//!
//! The users and their groups (or realm roles) are read with the admin REST API of the realm, using the service
//! account of the SSO client (`SSO_CLIENT_ID`, needs the `view-users` role of `realm-management`).
//! - New Keycloak users with access get an account linked to their Keycloak user, so they can be added to
//!   organizations before their first login (`SSO_DIRECTORY_SYNC_CREATE_USERS`).
//! - Existing accounts with the same e-mail address are linked like at an SSO login (`SSO_SIGNUPS_MATCH_EMAIL`).
//! - The groups are stored and the organization sync runs, see `sso_groups`.
//! - Accounts of users which are disabled in or removed from Keycloak are disabled and logged out, and enabled again
//!   when they return (`SSO_DIRECTORY_SYNC_DISABLE_USERS`). Accounts disabled by an administrator stay disabled.

use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
};

use chrono::{NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    CONFIG,
    api::{ApiResult, EmptyResult, WS_USERS},
    db::{
        DbConn, DbPool,
        models::{Device, SsoUser, User},
    },
    sso::OIDCIdentifier,
    sso_client::Client,
};

const PAGE_SIZE: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeycloakUser {
    id: String,
    username: Option<String>,
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
    enabled: bool,
    first_name: Option<String>,
    last_name: Option<String>,
}

impl KeycloakUser {
    fn display_name(&self) -> Option<String> {
        let full = [self.first_name.as_deref(), self.last_name.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if full.is_empty() {
            self.username.clone()
        } else {
            Some(full)
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Keycloak users with an e-mail address
    pub users: usize,
    pub created: usize,
    pub linked: usize,
    pub disabled: usize,
    pub enabled: usize,
    /// Linked users outside `SSO_ACCESS_GROUPS`
    pub without_access: usize,
    /// Users which could not be synced, with the reason
    pub skipped: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub finished: NaiveDateTime,
    pub report: Option<SyncReport>,
    pub error: Option<String>,
}

static LAST_RUN: LazyLock<Mutex<Option<LastRun>>> = LazyLock::new(|| Mutex::new(None));
static RUNNING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Result of the last sync since the start of the server
pub fn last_run() -> Option<LastRun> {
    LAST_RUN.lock().ok().and_then(|l| l.clone())
}

/// Scheduled job, see `SSO_DIRECTORY_SYNC_SCHEDULE`
pub async fn sync_job(pool: DbPool) {
    match pool.get().await {
        Ok(conn) => {
            run(&conn).await.ok();
        }
        Err(e) => error!("Directory sync: no database connection: {e:?}"),
    }
}

/// Runs the sync and remembers the result. Only one sync runs at a time.
pub async fn run(conn: &DbConn) -> ApiResult<SyncReport> {
    let Ok(_running) = RUNNING.try_lock() else {
        err!("A directory sync is already running")
    };
    let result = sync(conn).await;
    let last = match &result {
        Ok(report) => {
            info!(
                "Directory sync: {} users, {} created, {} linked, {} disabled, {} enabled, {} without access, {} skipped",
                report.users,
                report.created,
                report.linked,
                report.disabled,
                report.enabled,
                report.without_access,
                report.skipped.len()
            );
            for reason in &report.skipped {
                warn!("Directory sync: skipped {reason}");
            }
            LastRun {
                finished: Utc::now().naive_utc(),
                report: Some(report.clone()),
                error: None,
            }
        }
        Err(e) => {
            error!("Directory sync failed: {}", e.message());
            LastRun {
                finished: Utc::now().naive_utc(),
                report: None,
                error: Some(e.message().to_owned()),
            }
        }
    };
    if let Ok(mut l) = LAST_RUN.lock() {
        *l = Some(last);
    }
    result
}

/// The admin REST API of the realm: `SSO_DIRECTORY_SYNC_URL`, or derived from the issuer
/// (`https://host[/auth]/realms/<realm>` becomes `https://host[/auth]/admin/realms/<realm>`)
pub fn admin_url(issuer: &str) -> ApiResult<String> {
    let configured = CONFIG.sso_directory_sync_url();
    if !configured.trim().is_empty() {
        return Ok(configured.trim().trim_end_matches('/').to_owned());
    }
    let issuer = issuer.trim_end_matches('/');
    let Some(i) = issuer.rfind("/realms/") else {
        err!("Unable to derive the Keycloak admin API URL from the issuer, set SSO_DIRECTORY_SYNC_URL")
    };
    Ok(format!("{}/admin{}", &issuer[..i], &issuer[i..]))
}

/// With `SSO_GROUPS_CLAIM=realm_access.roles` the realm roles are synced, else the full paths of the groups
fn uses_realm_roles() -> bool {
    CONFIG.sso_groups_claim().trim() == "realm_access.roles"
}

async fn fetch_users(client: &Client, base: &str, token: &str) -> ApiResult<Vec<KeycloakUser>> {
    let mut users: Vec<KeycloakUser> = Vec::new();
    loop {
        let page = client.get_json(&format!("{base}/users?first={}&max={PAGE_SIZE}", users.len()), token).await?;
        let page: Vec<KeycloakUser> = match serde_json::from_value(page) {
            Ok(page) => page,
            Err(e) => err!(format!("Unexpected answer of the Keycloak users API: {e}")),
        };
        let count = page.len();
        users.extend(page);
        if count < PAGE_SIZE {
            return Ok(users);
        }
    }
}

async fn fetch_groups(client: &Client, base: &str, token: &str, user_id: &str) -> ApiResult<Vec<String>> {
    let (url, key) = if uses_realm_roles() {
        (format!("{base}/users/{user_id}/role-mappings/realm/composite"), "name")
    } else {
        (format!("{base}/users/{user_id}/groups?briefRepresentation=true&first=0&max=10000"), "path")
    };
    let value = client.get_json(&url, token).await?;
    let Some(items) = value.as_array() else {
        err!("Unexpected answer of the Keycloak groups API")
    };
    Ok(items
        .iter()
        .filter_map(|g| g.get(key).or_else(|| g.get("name")).and_then(Value::as_str))
        .map(crate::sso_groups::clean)
        .filter(|g| !g.is_empty())
        .collect())
}

async fn sync(conn: &DbConn) -> ApiResult<SyncReport> {
    if !CONFIG.sso_enabled() {
        err!("SSO is not enabled")
    }
    let client = Client::cached().await?;
    let base = admin_url(&client.issuer)?;
    let token = client.service_account_token().await?;
    let kc_users = fetch_users(&client, &base, &token).await?;
    if kc_users.is_empty() {
        // Rather a missing permission of the service account than an empty realm, so do not disable everyone
        err!("Keycloak returned no users, nothing was changed. Check the roles of the service account.")
    }

    let mut report = SyncReport::default();
    let mut seen: HashSet<String> = HashSet::new();
    for kc in &kc_users {
        let identifier = OIDCIdentifier::new(&client.issuer, &kc.id);
        seen.insert(identifier.to_string());
        let Some(email) = kc.email.as_deref().map(str::trim).filter(|e| !e.is_empty()) else {
            continue;
        };
        report.users += 1;

        let groups = if crate::sso_groups::enabled() {
            match fetch_groups(&client, &base, &token, &kc.id).await {
                Ok(groups) => Some(groups),
                Err(e) => {
                    report.skipped.push(format!("{email}: unable to read the groups: {}", e.message()));
                    continue;
                }
            }
        } else {
            None
        };
        let has_access = crate::sso_groups::check_access(groups.as_deref()).is_ok();

        let (mut user, sso_user) = match SsoUser::find_by_identifier(&identifier, conn).await {
            Some(found) => found,
            None => match link_or_create(kc, email, &identifier, has_access, &mut report, conn).await? {
                Some(found) => found,
                None => continue,
            },
        };

        if CONFIG.sso_directory_sync_disable_users() {
            if !kc.enabled && user.enabled {
                disable(&mut user, conn).await?;
                report.disabled += 1;
            } else if kc.enabled && !user.enabled && sso_user.disabled_by_sync {
                enable(&mut user, conn).await?;
                report.enabled += 1;
            }
        }
        if groups.is_some() && crate::sso_groups::apply(&user, groups, conn).await.is_err() {
            report.without_access += 1;
        }
    }

    // Accounts linked to Keycloak users which no longer exist
    if CONFIG.sso_directory_sync_disable_users() {
        let prefix = format!("{}/", client.issuer);
        for (mut user, sso_user) in SsoUser::get_all(conn).await {
            let identifier = sso_user.identifier.to_string();
            if user.enabled && identifier.starts_with(&prefix) && !seen.contains(&identifier) {
                disable(&mut user, conn).await?;
                report.disabled += 1;
            }
        }
    }
    Ok(report)
}

/// Links an existing account with the same e-mail address (like an SSO login would), or creates a new account
async fn link_or_create(
    kc: &KeycloakUser,
    email: &str,
    identifier: &OIDCIdentifier,
    has_access: bool,
    report: &mut SyncReport,
    conn: &DbConn,
) -> ApiResult<Option<(User, SsoUser)>> {
    match SsoUser::find_by_mail(email, conn).await {
        Some((_, Some(_))) => {
            report.skipped.push(format!("{email}: the account is linked to another SSO user"));
            Ok(None)
        }
        Some((user, None)) => {
            if user.private_key.is_some() && !CONFIG.sso_signups_match_email() {
                report.skipped.push(format!("{email}: an account exists and SSO_SIGNUPS_MATCH_EMAIL is disabled"));
                return Ok(None);
            }
            if !kc.email_verified {
                report.skipped.push(format!("{email}: an account exists and the address is not verified in Keycloak"));
                return Ok(None);
            }
            let sso_user = SsoUser::new(user.uuid.clone(), identifier.clone());
            sso_user.save(conn).await?;
            info!("Directory sync: linked {email} to its Keycloak user");
            report.linked += 1;
            Ok(Some((user, sso_user)))
        }
        None => {
            if !CONFIG.sso_directory_sync_create_users() || !kc.enabled || !has_access {
                return Ok(None);
            }
            let mut user = User::new(email, kc.display_name());
            user.save(conn).await?;
            let sso_user = SsoUser::new(user.uuid.clone(), identifier.clone());
            sso_user.save(conn).await?;
            info!("Directory sync: created an account for {email}");
            report.created += 1;
            Ok(Some((user, sso_user)))
        }
    }
}

/// Disables the account and ends all its sessions, like the admin page does
async fn disable(user: &mut User, conn: &DbConn) -> EmptyResult {
    user.reset_security_stamp(conn).await?;
    user.enabled = false;
    user.save(conn).await?;
    WS_USERS.send_logout(user, None, conn).await;
    Device::delete_all_by_user(&user.uuid, conn).await?;
    SsoUser::set_disabled_by_sync(&user.uuid, true, conn).await?;
    info!("Directory sync: disabled {}", user.email);
    Ok(())
}

async fn enable(user: &mut User, conn: &DbConn) -> EmptyResult {
    user.enabled = true;
    user.save(conn).await?;
    SsoUser::set_disabled_by_sync(&user.uuid, false, conn).await?;
    info!("Directory sync: enabled {}", user.email);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_url_from_issuer() {
        assert_eq!(
            admin_url("https://kc.example.com/realms/main").unwrap(),
            "https://kc.example.com/admin/realms/main"
        );
        assert_eq!(
            admin_url("https://kc.example.com/auth/realms/main/").unwrap(),
            "https://kc.example.com/auth/admin/realms/main"
        );
        assert!(admin_url("https://login.example.com").is_err());
    }
}
