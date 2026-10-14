//! Storage for the icons of the web manager (e.g. the icons imported from KeePass).
//!
//! The Bitwarden data model has no icons, and the official clients drop unknown properties when they save an item,
//! so the icons are kept next to the vault: one document per user (personal items and folders) and one per
//! organization (organization items and collections). The documents are encrypted in the browser with the user key
//! or the organization key, the server only stores them.

use std::collections::HashMap;

use rocket::serde::json::Json;
use serde_json::Value;

use crate::{
    api::{EmptyResult, JsonResult},
    auth::Headers,
    db::{
        DbConn,
        models::{ManagerIcons, Membership, MembershipType, OrganizationId},
    },
};

/// Larger documents are refused (the custom images are small PNGs, so this leaves room for thousands of them)
const MAX_DATA_LEN: usize = 8 * 1024 * 1024;

pub fn routes() -> Vec<rocket::Route> {
    routes![get_icons, put_icons, put_org_icons]
}

fn icons_json(icons: Option<ManagerIcons>) -> Value {
    icons.map_or(Value::Null, |i| {
        json!({
            "data": i.data,
            "revisionDate": crate::util::format_date(&i.revision_date),
        })
    })
}

/// The personal document and the documents of all organizations the user is a confirmed member of
#[get("/manager/icons")]
async fn get_icons(headers: Headers, conn: DbConn) -> Json<Value> {
    let personal = ManagerIcons::find(&headers.user.uuid, &conn).await;
    let mut organizations = HashMap::new();
    for member in Membership::find_confirmed_by_user(&headers.user.uuid, &conn).await {
        if let Some(icons) = ManagerIcons::find(&member.org_uuid, &conn).await {
            organizations.insert(member.org_uuid.to_string(), icons_json(Some(icons)));
        }
    }
    Json(json!({
        "personal": icons_json(personal),
        "organizations": organizations,
        "object": "managerIcons",
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IconsData {
    /// EncString of the JSON document
    data: String,
}

impl IconsData {
    fn validate(&self) -> EmptyResult {
        if self.data.len() > MAX_DATA_LEN {
            err!("The icons are too large")
        }
        // Only encrypted data is stored (type 2: AES-CBC with HMAC)
        if !self.data.starts_with("2.") {
            err!("The icons must be encrypted")
        }
        Ok(())
    }
}

#[put("/manager/icons", data = "<data>")]
async fn put_icons(data: Json<IconsData>, headers: Headers, conn: DbConn) -> JsonResult {
    let data = data.into_inner();
    data.validate()?;
    let icons = ManagerIcons::new(headers.user.uuid.to_string(), data.data);
    icons.save(&conn).await?;
    Ok(Json(icons_json(Some(icons))))
}

/// Managers, admins and owners change the icons of an organization
#[put("/manager/organizations/<org_id>/icons", data = "<data>")]
async fn put_org_icons(org_id: OrganizationId, data: Json<IconsData>, headers: Headers, conn: DbConn) -> JsonResult {
    let data = data.into_inner();
    data.validate()?;
    match Membership::find_confirmed_by_user_and_org(&headers.user.uuid, &org_id, &conn).await {
        Some(member) if member.atype >= MembershipType::Manager => {}
        _ => err!("Only managers, admins and owners can change the icons of an organization"),
    }
    let icons = ManagerIcons::new(org_id.to_string(), data.data);
    icons.save(&conn).await?;
    Ok(Json(icons_json(Some(icons))))
}
