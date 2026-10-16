//! Resolve and transfer the complete application data directory before any window opens.
use crate::native_files::{self as files, err, Result};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn read(path: &Path) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(err(e)),
    }
}

fn check_path(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err("Storage locations must be absolute paths.".into());
    }
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            if files::linked(&metadata) {
                return Err("Storage locations cannot use linked folders.".into());
            }
        }
    }
    Ok(())
}

pub fn pointer(default: &Path) -> PathBuf {
    default.parent().unwrap().join("location.json")
}

pub fn pending(default: &Path) -> Result<Option<PathBuf>> {
    Ok(read(&pointer(default))?["pending"]
        .as_str()
        .map(PathBuf::from))
}

pub fn schedule(
    default: &Path,
    current: &Path,
    parent: &Path,
    workspaces: &[Value],
) -> Result<PathBuf> {
    check_path(parent)?;
    let parent = fs::canonicalize(parent).map_err(err)?;
    let target = parent.join(".weave");
    check_path(&target)?;
    let original_current = current.to_path_buf();
    let current = fs::canonicalize(current).map_err(err)?;
    if target == current {
        let file = pointer(default);
        if file.exists() {
            if fs::canonicalize(default).is_ok_and(|path| path == current) {
                fs::remove_file(file).map_err(err)?;
            } else {
                files::json_write(&file, &json!({"active":current}))?;
            }
        }
        return Ok(original_current);
    }
    if target.starts_with(&current) || current.starts_with(&target) {
        return Err("Choose a folder separate from the current data location.".into());
    }
    for workspace in workspaces {
        if let Some(root) = workspace["root"].as_str() {
            if let Ok(root) = fs::canonicalize(root) {
                if target.starts_with(&root) || root.starts_with(&target) {
                    return Err("Choose a data location outside Markdown workspaces.".into());
                }
            }
        }
    }
    if target.exists() {
        return Err(
            "The selected folder already contains a .weave directory. Choose another folder."
                .into(),
        );
    }
    let file = pointer(default);
    fs::create_dir_all(file.parent().unwrap()).map_err(err)?;
    files::json_write(&file, &json!({"active":current,"pending":target}))?;
    Ok(target)
}

fn transfer(source: &Path, target: &Path) -> Result<()> {
    // WebView2 may finish deleting temporary profile files just after Weave exits.
    // Start a fresh copy if one disappears or is briefly held without file sharing.
    for attempt in 0..25 {
        match transfer_once(source, target) {
            Ok(()) => return Ok(()),
            Err(error)
                if attempt < 24
                    && ["os error 2", "os error 5", "os error 32", "os error 33"]
                        .iter()
                        .any(|code| error.contains(code)) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the bounded transfer loop returns")
}

fn transfer_once(source: &Path, target: &Path) -> Result<()> {
    check_path(source)?;
    check_path(target)?;
    if target.exists() {
        return Err(format!(
            "Storage destination already exists: {}",
            target.display()
        ));
    }
    fs::create_dir_all(target.parent().ok_or("Invalid data location")?).map_err(err)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(source.join("native.lock"))
        .or_else(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(source.join("native.lock"))
            } else {
                Err(e)
            }
        })
        .map_err(err)?;
    lock.try_lock_exclusive()
        .map_err(|_| "Close all other Weave windows before moving application data.".to_string())?;
    let staging = target
        .parent()
        .unwrap()
        .join(format!(".weave-transfer-{}", files::id()));
    let result = (|| -> Result<()> {
        fs::create_dir(&staging).map_err(err)?;
        for entry in fs::read_dir(source).map_err(err)? {
            let entry = entry.map_err(err)?;
            if entry.file_name() == "native.lock" || entry.file_name() == "runtime" {
                continue;
            }
            let target_entry = staging.join(entry.file_name());
            files::copy_tree(&entry.path(), &target_entry)?;
            if files::manifest(&entry.path())? != files::manifest(&target_entry)? {
                return Err("Storage copy did not match its source.".into());
            }
        }
        fs::File::create(staging.join("native.lock")).map_err(err)?;
        // Earlier releases allowed the database to live separately. Bring it home.
        let mut config = read(&staging.join("storage.json"))?;
        if let Some(external) = config["databaseDirectory"].as_str() {
            let external = Path::new(external);
            check_path(external)?;
            if fs::canonicalize(external).map_err(err)? != fs::canonicalize(source).map_err(err)? {
                let external_lock = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(external.join("native.lock"))
                    .map_err(err)?;
                external_lock.try_lock_exclusive().map_err(|_| {
                    "Close other Weave windows before moving the legacy database.".to_string()
                })?;
                let db = external.join("weave.sqlite");
                let old = crate::database::Database::open(&db)?;
                old.checkpoint()?;
                drop(old);
                fs::copy(&db, staging.join("weave.sqlite")).map_err(err)?;
            }
            config.as_object_mut().unwrap().remove("databaseDirectory");
            files::json_write(&staging.join("storage.json"), &config)?;
        }
        let db = staging.join("weave.sqlite");
        if db.exists() {
            let opened = crate::database::Database::open(&db)?;
            let check: String = opened.quick_check()?;
            if check != "ok" {
                return Err("Transferred database failed integrity validation.".into());
            }
            drop(opened);
        }
        files::json_write(
            &staging.join("transfer-marker.json"),
            &json!({"source":source,"target":target}),
        )?;
        fs::rename(&staging, target).map_err(err)?;
        Ok(())
    })();
    if result.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn consolidate_database(runtime: &Path) -> Result<()> {
    let storage = runtime.join("storage.json");
    let mut config = read(&storage)?;
    let Some(external) = config["databaseDirectory"].as_str() else {
        return Ok(());
    };
    let external = PathBuf::from(external);
    check_path(&external)?;
    if fs::canonicalize(&external).map_err(err)? == fs::canonicalize(runtime).map_err(err)? {
        config.as_object_mut().unwrap().remove("databaseDirectory");
        return files::json_write(&storage, &config);
    }
    let lock = |directory: &Path| -> Result<fs::File> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("native.lock"))
            .map_err(err)?;
        file.try_lock_exclusive()
            .map_err(|_| "Close other Weave windows before migrating the database.".to_string())?;
        Ok(file)
    };
    let _runtime_lock = lock(runtime)?;
    let _external_lock = lock(&external)?;
    let source = external.join("weave.sqlite");
    let opened = crate::database::Database::open(&source)?;
    opened.checkpoint()?;
    drop(opened);
    let target = runtime.join("weave.sqlite");
    if !target.exists() {
        let mut staged = tempfile::NamedTempFile::new_in(runtime).map_err(err)?;
        std::io::copy(&mut fs::File::open(&source).map_err(err)?, &mut staged).map_err(err)?;
        staged.flush().map_err(err)?;
        staged.as_file().sync_all().map_err(err)?;
        staged.persist_noclobber(&target).map_err(err)?;
    } else if files::manifest(&source)? != files::manifest(&target)? {
        return Err("The existing application data folder contains a different database; the legacy database was preserved.".into());
    }
    let verified = crate::database::Database::open(&target)?;
    let check: String = verified.quick_check()?;
    if check != "ok" {
        return Err("Migrated database failed integrity validation.".into());
    }
    drop(verified);
    config.as_object_mut().unwrap().remove("databaseDirectory");
    files::json_write(&storage, &config)
}

pub fn resolve(default: &Path, legacy: Option<&Path>) -> Result<PathBuf> {
    check_path(default)?;
    fs::create_dir_all(
        default
            .parent()
            .ok_or("Invalid application data directory")?,
    )
    .map_err(err)?;
    let file = pointer(default);
    let config = read(&file)?;
    let active = config["active"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| default.to_path_buf());
    check_path(&active)?;
    if let Some(pending) = config["pending"].as_str() {
        let target = PathBuf::from(pending);
        if target == active {
            files::json_write(&file, &json!({"active":target}))?;
            return Ok(target);
        }
        if target.exists() {
            let marker = read(&target.join("transfer-marker.json"))?;
            if marker["source"] != json!(active) || marker["target"] != json!(target) {
                return Err("Storage destination appeared before transfer; the existing folder was not changed.".into());
            }
        } else {
            transfer(&active, &target)?;
        }
        let default_target = fs::canonicalize(default.parent().unwrap())
            .map_err(err)?
            .join(".weave");
        if target == default_target {
            fs::remove_file(&file).map_err(err)?;
        } else {
            files::json_write(&file, &json!({"active":target}))?;
        }
        let _ = fs::remove_file(target.join("transfer-marker.json"));
        return Ok(target);
    }
    if active == default && !default.exists() {
        if let Some(legacy) = legacy.filter(|p| p.is_dir()) {
            if legacy != default {
                transfer(legacy, default)?;
                let _ = fs::remove_file(default.join("transfer-marker.json"));
            }
        }
    }
    fs::create_dir_all(&active).map_err(err)?;
    consolidate_database(&active)?;
    Ok(active)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_database_location_joins_the_application_data_folder() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("LocalAppData/Weave/.weave");
        let external = temp.path().join("old-database");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir(&external).unwrap();
        drop(crate::database::Database::open(&external.join("weave.sqlite")).unwrap());
        files::json_write(
            &data.join("storage.json"),
            &json!({"databaseDirectory":external,"collections":[{"name":"keep"}]}),
        )
        .unwrap();
        assert_eq!(resolve(&data, None).unwrap(), data);
        assert!(data.join("weave.sqlite").exists());
        assert!(external.join("weave.sqlite").exists());
        let config = read(&data.join("storage.json")).unwrap();
        assert!(config["databaseDirectory"].is_null());
        assert_eq!(config["collections"][0]["name"], "keep");
    }
}
