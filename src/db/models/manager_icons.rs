use chrono::{NaiveDateTime, Utc};
use diesel::prelude::*;

use crate::{
    api::EmptyResult,
    db::{DbConn, schema::manager_icons},
    error::MapResult,
};

/// The icons of the web manager for the items, folders and collections of one user or organization.
/// `data` is encrypted in the browser (with the user key or the organization key), the server can not read it.
#[derive(Identifiable, Queryable, Insertable, AsChangeset)]
#[diesel(table_name = manager_icons)]
#[diesel(primary_key(owner_uuid))]
pub struct ManagerIcons {
    pub owner_uuid: String,
    pub data: String,
    pub revision_date: NaiveDateTime,
}

impl ManagerIcons {
    pub fn new(owner_uuid: String, data: String) -> Self {
        Self {
            owner_uuid,
            data,
            revision_date: Utc::now().naive_utc(),
        }
    }

    pub async fn find(owner_uuid: &str, conn: &DbConn) -> Option<Self> {
        let owner_uuid = owner_uuid.to_owned();
        conn.run(move |conn| {
            manager_icons::table.filter(manager_icons::owner_uuid.eq(owner_uuid)).first::<Self>(conn).ok()
        })
        .await
    }

    pub async fn save(&self, conn: &DbConn) -> EmptyResult {
        db_run! { conn:
            mysql {
                diesel::insert_into(manager_icons::table)
                    .values(self)
                    .on_conflict(diesel::dsl::DuplicatedKeys)
                    .do_update()
                    .set(self)
                    .execute(conn)
                    .map_res("Error saving manager icons")
            }
            postgresql, sqlite {
                diesel::insert_into(manager_icons::table)
                    .values(self)
                    .on_conflict(manager_icons::owner_uuid)
                    .do_update()
                    .set(self)
                    .execute(conn)
                    .map_res("Error saving manager icons")
            }
        }
    }

    pub async fn delete_by_owner(owner_uuid: &str, conn: &DbConn) -> EmptyResult {
        let owner_uuid = owner_uuid.to_owned();
        conn.run(move |conn| {
            diesel::delete(manager_icons::table.filter(manager_icons::owner_uuid.eq(owner_uuid)))
                .execute(conn)
                .map_res("Error deleting manager icons")
        })
        .await
    }
}
