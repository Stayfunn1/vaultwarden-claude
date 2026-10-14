//! Permissions and organization memberships from the groups of the identity provider.
//!
//! The groups (or roles) are read from a claim of the ID token or the userinfo response
//! (`SSO_GROUPS_CLAIM`) at every SSO login and token refresh, and by the Keycloak directory sync.
//! - `SSO_ACCESS_GROUPS`: only members of these groups can use Vaultwarden.
//! - `SSO_ORG_CREATION_GROUPS`: members of these groups can create organizations.
//! - `SSO_ORG_SYNC`: groups named `<prefix>/<organization>[/owners|admins|managers|<group>]` decide
//!   the membership, role and groups of existing organizations.
//!
//! Memberships and groups created or adopted by the sync are marked with `SYNC_MARKER` in their
//! `external_id`. Only those are changed or revoked later, everything managed by hand stays as it is.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::{
    CONFIG,
    api::EmptyResult,
    db::{
        DbConn,
        models::{Group, GroupUser, Membership, MembershipStatus, MembershipType, Organization, SsoUser, User},
    },
};

pub const SYNC_MARKER: &str = "vaultwarden-sso-sync";

/// True when any group based feature is configured
pub fn enabled() -> bool {
    !CONFIG.sso_access_groups().trim().is_empty()
        || !CONFIG.sso_org_creation_groups().trim().is_empty()
        || CONFIG.sso_org_sync()
}

fn clean(group: &str) -> String {
    group.trim().trim_matches('/').trim().to_owned()
}

fn config_list(value: &str) -> Vec<String> {
    value.split(',').map(clean).filter(|g| !g.is_empty()).collect()
}

fn matches_any(groups: &[String], wanted: &[String]) -> bool {
    groups.iter().any(|g| wanted.iter().any(|w| w.eq_ignore_ascii_case(g)))
}

/// Reads the groups from the first of the given claim sets which contains `SSO_GROUPS_CLAIM`.
/// Returns `None` when no claim set contains it, which is different from an empty group list.
pub fn groups_from_claims(claim_sets: &[&Value]) -> Option<Vec<String>> {
    let path = CONFIG.sso_groups_claim();
    'sets: for claims in claim_sets {
        let mut value = *claims;
        for part in path.split('.').filter(|p| !p.is_empty()) {
            match value.get(part) {
                Some(v) => value = v,
                None => continue 'sets,
            }
        }
        let groups: Vec<String> = match value {
            Value::Array(items) => items.iter().filter_map(Value::as_str).map(clean).collect(),
            Value::String(s) => s.split(',').map(clean).collect(),
            _ => Vec::new(),
        };
        return Some(groups.into_iter().filter(|g| !g.is_empty()).collect());
    }
    None
}

/// Decodes the claims of a JWT without verifying it.
/// Only used for tokens received directly from the identity provider.
pub fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = data_encoding::BASE64URL_NOPAD.decode(payload.trim_end_matches('=').as_bytes()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Checks `SSO_ACCESS_GROUPS` for groups received from the identity provider
pub fn check_access(groups: Option<&[String]>) -> EmptyResult {
    let wanted = config_list(&CONFIG.sso_access_groups());
    if wanted.is_empty() {
        return Ok(());
    }
    match groups {
        Some(groups) if matches_any(groups, &wanted) => Ok(()),
        Some(_) => {
            err!("You are not allowed to use this Vaultwarden. Ask your administrator to add you to the right group.")
        }
        None => err!(format!(
            "The identity provider did not send the groups of the user (claim `{}`), access can not be checked",
            CONFIG.sso_groups_claim()
        )),
    }
}

/// Checks `SSO_ACCESS_GROUPS` with the groups stored at the last SSO login, for non SSO logins.
/// Users which never logged in with SSO are not affected.
pub async fn check_stored_access(user: &User, conn: &DbConn) -> EmptyResult {
    if config_list(&CONFIG.sso_access_groups()).is_empty() {
        return Ok(());
    }
    match SsoUser::find_by_user(&user.uuid, conn).await.and_then(|s| s.groups()) {
        Some(groups) => check_access(Some(&groups)),
        None => Ok(()),
    }
}

/// `ORG_CREATION_USERS`, extended with `SSO_ORG_CREATION_GROUPS`
pub async fn can_create_org(user: &User, conn: &DbConn) -> bool {
    let wanted = config_list(&CONFIG.sso_org_creation_groups());
    if wanted.is_empty() {
        return CONFIG.is_org_creation_allowed(&user.email);
    }
    // With creation groups, "everyone" no longer applies, only an explicit list of users is kept
    let users = CONFIG.org_creation_users();
    let email = user.email.to_lowercase();
    if users.split(',').any(|u| u.trim() == email) {
        return true;
    }
    match SsoUser::find_by_user(&user.uuid, conn).await.and_then(|s| s.groups()) {
        Some(groups) => matches_any(&groups, &wanted),
        None => false,
    }
}

/// Stores the groups, runs the organization sync and checks `SSO_ACCESS_GROUPS`.
/// The groups are stored even when the access is refused, so the user can not fall back to a password or
/// API key login. Sync errors are only logged. `None` (the identity provider did not send the claim) changes nothing.
pub async fn apply(user: &User, groups: Option<Vec<String>>, conn: &DbConn) -> EmptyResult {
    let Some(groups) = groups else {
        return Ok(());
    };
    if let Err(e) = SsoUser::set_groups(&user.uuid, &groups, conn).await {
        error!("Unable to store the identity provider groups of {}: {e:?}", user.email);
    }
    if CONFIG.sso_org_sync()
        && let Err(e) = sync_organizations(user, &groups, conn).await
    {
        error!("Organization sync for {} failed: {e:?}", user.email);
    }
    check_access(Some(&groups))
}

#[derive(Debug)]
struct WantedOrg {
    name: String,
    role: MembershipType,
    groups: Vec<String>,
}

/// Parses `<prefix>/<organization>[/owners|admins|managers|<group>]`, keyed by lower case organization name
fn wanted_organizations(groups: &[String]) -> HashMap<String, WantedOrg> {
    let prefix = clean(&CONFIG.sso_org_sync_prefix()).to_lowercase();
    let mut wanted: HashMap<String, WantedOrg> = HashMap::new();
    for group in groups {
        let parts: Vec<&str> = group.split('/').map(str::trim).filter(|p| !p.is_empty()).collect();
        if parts.len() < 2 || parts[0].to_lowercase() != prefix {
            continue;
        }
        let entry = wanted.entry(parts[1].to_lowercase()).or_insert_with(|| WantedOrg {
            name: parts[1].to_owned(),
            role: MembershipType::User,
            groups: Vec::new(),
        });
        if let Some(sub) = parts.get(2) {
            let role = match sub.to_lowercase().as_str() {
                "owners" => Some(MembershipType::Owner),
                "admins" => Some(MembershipType::Admin),
                "managers" => Some(MembershipType::Manager),
                _ => None,
            };
            match role {
                Some(role) if role > entry.role => entry.role = role,
                Some(_) => {}
                None => {
                    if !entry.groups.iter().any(|g| g.eq_ignore_ascii_case(sub)) {
                        entry.groups.push((*sub).to_owned());
                    }
                }
            }
        }
    }
    wanted
}

fn is_managed(external_id: Option<&String>) -> bool {
    external_id.is_some_and(|e| e == SYNC_MARKER)
}

async fn is_last_owner(member: &Membership, conn: &DbConn) -> bool {
    member.atype == MembershipType::Owner
        && member.status == MembershipStatus::Confirmed as i32
        && Membership::count_confirmed_by_org_and_type(&member.org_uuid, MembershipType::Owner, conn).await <= 1
}

/// Brings the organization memberships of one user in line with the identity provider groups
pub async fn sync_organizations(user: &User, groups: &[String], conn: &DbConn) -> EmptyResult {
    let wanted = wanted_organizations(groups);
    let orgs = Organization::get_all(conn).await;
    let known: HashSet<String> = orgs.iter().map(|o| o.name.to_lowercase()).collect();
    for w in wanted.values() {
        if !known.contains(&w.name.to_lowercase()) {
            warn!("Organization sync: there is no organization named \"{}\" (create it first)", w.name);
        }
    }

    for org in &orgs {
        let want = wanted.get(&org.name.to_lowercase());
        let existing = Membership::find_by_user_and_org(&user.uuid, &org.uuid, conn).await;
        let member = match (want, existing) {
            (Some(w), None) => {
                let mut m = Membership::new(user.uuid.clone(), org.uuid.clone(), None);
                m.atype = w.role as i32;
                // The key exchange still needs an owner or admin to confirm the member in a client
                m.status = if user.private_key.is_some() {
                    MembershipStatus::Accepted as i32
                } else {
                    MembershipStatus::Invited as i32
                };
                m.external_id = Some(SYNC_MARKER.to_owned());
                m.save(conn).await?;
                info!("Organization sync: added {} to {} as {:?}", user.email, org.name, w.role);
                Some(m)
            }
            (Some(w), Some(mut m)) => {
                update_membership(user, org, w, &mut m, conn).await?;
                Some(m)
            }
            (None, Some(mut m)) => {
                if is_managed(m.external_id.as_ref()) && m.status > MembershipStatus::Revoked as i32 {
                    if is_last_owner(&m, conn).await {
                        warn!("Organization sync: not revoking the last owner of {} ({})", org.name, user.email);
                    } else {
                        m.revoke();
                        m.save(conn).await?;
                        info!("Organization sync: revoked {} in {}", user.email, org.name);
                    }
                }
                None
            }
            (None, None) => None,
        };

        if let (Some(w), Some(m)) = (want, member)
            && CONFIG.org_groups_enabled()
            && m.status > MembershipStatus::Revoked as i32
        {
            sync_groups(org, &m, &w.groups, conn).await?;
        }
    }
    Ok(())
}

/// Brings an existing membership in line with the groups. Memberships managed by hand are adopted by the sync,
/// except owners and revoked members, which are left alone.
async fn update_membership(
    user: &User,
    org: &Organization,
    want: &WantedOrg,
    m: &mut Membership,
    conn: &DbConn,
) -> EmptyResult {
    let managed = is_managed(m.external_id.as_ref());
    if !managed && (m.atype == MembershipType::Owner || m.status <= MembershipStatus::Revoked as i32) {
        return Ok(());
    }
    let mut changed = !managed;
    m.external_id = Some(SYNC_MARKER.to_owned());
    if m.atype != want.role as i32 {
        if is_last_owner(m, conn).await {
            warn!("Organization sync: not changing the last owner of {} ({})", org.name, user.email);
        } else {
            m.atype = want.role as i32;
            changed = true;
        }
    }
    if m.status <= MembershipStatus::Revoked as i32 {
        m.restore();
        changed = true;
        info!("Organization sync: restored {} in {}", user.email, org.name);
    }
    if m.status == MembershipStatus::Invited as i32 && user.private_key.is_some() {
        m.status = MembershipStatus::Accepted as i32;
        changed = true;
    }
    if changed {
        m.save(conn).await?;
    }
    Ok(())
}

/// Vaultwarden groups of one member in one organization
async fn sync_groups(org: &Organization, member: &Membership, wanted: &[String], conn: &DbConn) -> EmptyResult {
    let mut org_groups = Group::find_by_organization(&org.uuid, conn).await;
    let current = GroupUser::find_by_member(&member.uuid, conn).await;

    for name in wanted {
        let group_id = if let Some(group) = org_groups.iter_mut().find(|g| g.name.eq_ignore_ascii_case(name)) {
            if !is_managed(group.external_id.as_ref()) {
                group.external_id = Some(SYNC_MARKER.to_owned());
                group.save(conn).await?;
            }
            group.uuid.clone()
        } else {
            let mut group = Group::new(org.uuid.clone(), name.clone(), false, Some(SYNC_MARKER.to_owned()));
            group.save(conn).await?;
            info!("Organization sync: created group {name} in {}", org.name);
            let id = group.uuid.clone();
            org_groups.push(group);
            id
        };
        if !current.iter().any(|gu| gu.groups_uuid == group_id) {
            GroupUser::new(group_id, member.uuid.clone()).save(conn).await?;
        }
    }

    for gu in current {
        let Some(group) = org_groups.iter().find(|g| g.uuid == gu.groups_uuid) else {
            continue;
        };
        if is_managed(group.external_id.as_ref()) && !wanted.iter().any(|w| w.eq_ignore_ascii_case(&group.name)) {
            gu.delete(conn).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_claims() {
        let claims = json!({
            "groups": ["/vaultwarden/Family", "Users "],
            "realm_access": { "roles": ["vw-access", "offline_access"] },
        });
        assert_eq!(groups_from_claims(&[&claims]), Some(vec!["vaultwarden/Family".to_owned(), "Users".to_owned()]));
        assert_eq!(
            groups_from_claims(&[&json!({}), &claims]),
            Some(vec!["vaultwarden/Family".to_owned(), "Users".to_owned()])
        );
        assert_eq!(groups_from_claims(&[&json!({"other": 1})]), None);
        assert_eq!(groups_from_claims(&[&json!({"groups": []})]), Some(vec![]));
    }

    #[test]
    fn organization_mapping() {
        let groups: Vec<String> = [
            "vaultwarden/Family",
            "Vaultwarden/family/admins",
            "vaultwarden/Family/Parents",
            "vaultwarden/Team/managers",
            "vaultwarden/Team/owners",
            "other/Thing",
            "vaultwarden",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let wanted = wanted_organizations(&groups);
        assert_eq!(wanted.len(), 2);
        assert_eq!(wanted["family"].role, MembershipType::Admin);
        assert_eq!(wanted["family"].groups, vec!["Parents".to_owned()]);
        assert_eq!(wanted["team"].role, MembershipType::Owner);
        assert!(wanted["team"].groups.is_empty());
    }

    #[test]
    fn jwt_payload() {
        let token = format!("x.{}.y", data_encoding::BASE64URL_NOPAD.encode(br#"{"groups":["a"]}"#));
        assert_eq!(jwt_claims(&token), Some(json!({"groups": ["a"]})));
    }
}
