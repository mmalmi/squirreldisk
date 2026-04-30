use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictedPath {
    pub path: String,
    pub operation: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSnapshot {
    pub path: String,
    pub tree: serde_json::Value,
    pub used: u64,
    pub errors: Option<u64>,
    pub restricted_paths: Option<Vec<RestrictedPath>>,
    pub scanned_at: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSnapshotSummary {
    pub path: String,
    pub used: u64,
    pub errors: u64,
    pub restricted_count: usize,
    pub scanned_at: u64,
}

fn scan_snapshot_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("scan-snapshots");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn snapshot_file(app_handle: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let hash = path
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    Ok(scan_snapshot_dir(app_handle)?.join(format!("{hash:016x}.json")))
}

#[tauri::command]
pub fn get_scan_snapshot(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<Option<ScanSnapshot>, String> {
    let file = snapshot_file(&app_handle, &path)?;
    if !file.exists() {
        return Ok(None);
    }

    let snapshot: ScanSnapshot =
        serde_json::from_slice(&fs::read(file).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;

    if snapshot.path == path {
        Ok(Some(snapshot))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn list_scan_snapshots(
    app_handle: tauri::AppHandle,
) -> Result<Vec<ScanSnapshotSummary>, String> {
    let dir = scan_snapshot_dir(&app_handle)?;
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut snapshots = Vec::new();

    for entry in entries.flatten() {
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let bytes = match fs::read(entry.path()) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let snapshot = match serde_json::from_slice::<ScanSnapshot>(&bytes) {
            Ok(snapshot) => snapshot,
            Err(_) => continue,
        };
        let restricted_count = snapshot.restricted_paths.as_ref().map_or(0, Vec::len);
        snapshots.push(ScanSnapshotSummary {
            path: snapshot.path,
            used: snapshot.used,
            errors: snapshot.errors.unwrap_or(restricted_count as u64),
            restricted_count,
            scanned_at: snapshot.scanned_at.unwrap_or(0),
        });
    }

    snapshots.sort_by(|a, b| b.scanned_at.cmp(&a.scanned_at));
    Ok(snapshots)
}

#[tauri::command]
pub fn save_scan_snapshot(
    app_handle: tauri::AppHandle,
    snapshot: ScanSnapshot,
) -> Result<(), String> {
    let file = snapshot_file(&app_handle, &snapshot.path)?;
    let temp_file = file.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;

    fs::write(&temp_file, bytes).map_err(|error| error.to_string())?;
    fs::rename(temp_file, file).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_scan_snapshot(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = snapshot_file(&app_handle, &path)?;
    if file.exists() {
        fs::remove_file(file).map_err(|error| error.to_string())?;
    }
    Ok(())
}
