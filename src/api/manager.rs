//! The web manager: a compact, KeePass 2 style vault manager with a KeePass importer, served at `/manager/`.
//!
//! It only consists of static files. Like the official Bitwarden clients, it does all encryption and
//! decryption in the browser and uses the normal client API, so the server never sees any plain text.

use std::{collections::HashMap, path::PathBuf, sync::LazyLock};

use rocket::{
    Route,
    http::{ContentType, uri::Origin},
    response::Redirect,
    serde::json::Json,
};
use serde_json::Value;

use crate::{CONFIG, crypto::sha256_hex, util::EtagCached};

pub fn routes() -> Vec<Route> {
    if CONFIG.web_manager_enabled() {
        routes![manager_config, manager_files]
    } else {
        Vec::new()
    }
}

macro_rules! manager_files {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_bytes!(concat!("../static/manager/", $path)).as_slice())),*]
    };
}

// NOTE: Add new files of the manager here
const FILES: &[(&str, &[u8])] = manager_files![
    "index.html",
    "sso-callback.html",
    "manager.css",
    "js/api.js",
    "js/app.js",
    "js/bwcrypto.js",
    "js/dialogs.js",
    "js/editor.js",
    "js/importer.js",
    "js/keepass.js",
    "js/sso-callback.js",
    "js/table.js",
    "js/tree.js",
    "js/ui.js",
    "js/vault.js",
    "vendor/argon2.umd.min.js",
    "vendor/kdbxweb.min.js",
    "vendor/LICENSES.txt",
];

// The files with their etag, so browsers only download them again after an update
static FILE_MAP: LazyLock<HashMap<&'static str, (&'static [u8], String)>> =
    LazyLock::new(|| FILES.iter().map(|(path, data)| (*path, (*data, sha256_hex(data)))).collect());

fn content_type(path: &str) -> ContentType {
    path.rsplit_once('.').and_then(|(_, ext)| ContentType::from_extension(ext)).unwrap_or(ContentType::Plain)
}

/// Settings the manager needs before the user is logged in
#[get("/manager/config.json")]
fn manager_config() -> Json<Value> {
    Json(json!({
        "ssoEnabled": CONFIG.sso_enabled(),
        "ssoOnly": CONFIG.sso_enabled() && CONFIG.sso_only(),
        "webVaultEnabled": CONFIG.web_vault_enabled(),
    }))
}

#[derive(Responder)]
enum ManagerResponse {
    File(EtagCached<(ContentType, Vec<u8>)>),
    Redirect(Redirect),
}

#[get("/manager/<path..>", rank = 2)]
fn manager_files(path: PathBuf, uri: &Origin<'_>) -> Option<ManagerResponse> {
    let path = path.into_os_string().into_string().ok()?.replace('\\', "/");
    let path = if path.is_empty() {
        // The relative links of the page need the trailing slash
        if !uri.path().ends_with('/') {
            return Some(ManagerResponse::Redirect(Redirect::to(format!("{}/manager/", CONFIG.domain_path()))));
        }
        String::from("index.html")
    } else {
        path
    };

    #[cfg(debug_assertions)]
    if CONFIG.reload_templates() {
        // During development, load the files from disk, so changes are visible without a rebuild
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/static/manager");
        if FILE_MAP.contains_key(path.as_str()) {
            let data = std::fs::read(dir.join(&path)).ok()?;
            let etag = sha256_hex(&data);
            return Some(ManagerResponse::File(EtagCached::new((content_type(&path), data), &etag)));
        }
    }

    let (data, etag) = FILE_MAP.get(path.as_str())?;
    Some(ManagerResponse::File(EtagCached::new((content_type(&path), data.to_vec()), etag)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_manager_files_are_embedded() {
        // Every file in the manager folder must be listed in FILES, otherwise it would not be served
        fn walk(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let p = entry.unwrap().path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    out.push(p.strip_prefix(base).unwrap().to_str().unwrap().replace('\\', "/"));
                }
            }
        }
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/static/manager");
        let mut found = Vec::new();
        walk(&base, &base, &mut found);
        for f in found {
            assert!(FILES.iter().any(|(p, _)| *p == f), "{f} is not listed in FILES");
        }
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("js/app.js"), ContentType::JavaScript);
        assert_eq!(content_type("index.html"), ContentType::HTML);
        assert_eq!(content_type("manager.css"), ContentType::CSS);
    }
}
