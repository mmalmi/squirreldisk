#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![allow(unexpected_cfgs)]
mod scan;
mod snapshots;
mod window_style;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{DiskExt, System, SystemExt};
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

#[cfg(target_os = "macos")]
use window_vibrancy::NSVisualEffectMaterial;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SquirrelDisk<'a> {
    name: &'a str,
    s_mount_point: String,
    total_space: u64,
    available_space: u64,
    is_removable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteOutcome {
    deleted_bytes: u64,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(MyState(Default::default()))
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            // window.open_devtools();
            #[cfg(target_os = "macos")]
            window_vibrancy::apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None)
                .expect("Error applying blurred bg");

            #[cfg(target_os = "windows")]
            window_vibrancy::apply_blur(&window, Some((18, 18, 18, 125)))
                .expect("Error applying blurred bg");

            #[cfg(any(windows, target_os = "macos"))]
            window_style::set_window_styles(&window).unwrap();

            // app.listen_global("scan_stop", |event| {
            //     let s = app.state::<MyState>();
            //     s.0.lock().unwrap().take().unwrap().kill();
            // });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_disks,
            start_scanning,
            stop_scanning,
            show_in_folder,
            delete_permanently,
            open_full_disk_access_settings,
            snapshots::get_scan_snapshot,
            snapshots::list_scan_snapshots,
            snapshots::save_scan_snapshot,
            snapshots::delete_scan_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn open_full_disk_access_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn delete_permanently(path: String) -> Result<DeleteOutcome, String> {
    if path.trim().is_empty() {
        return Err("Path is empty".to_string());
    }

    delete_permanently_at_path(&PathBuf::from(path))
}

fn delete_permanently_at_path(path: &Path) -> Result<DeleteOutcome, String> {
    if let Some(reason) = deletion_protection_reason(path) {
        return Err(reason);
    }

    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    let deleted_bytes = measured_delete_bytes(path).unwrap_or(0);

    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())?;
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }

    Ok(DeleteOutcome { deleted_bytes })
}

fn deletion_protection_reason(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return Some("Only absolute scanned paths can be deleted".to_string());
    }

    if path.parent().is_none() {
        return Some("Refusing to delete a filesystem root".to_string());
    }

    let normalized = normalized_path_text(path);
    let protected_exact = [
        "/",
        "/Applications",
        "/Library",
        "/System",
        "/Users",
        "/Volumes",
        "/bin",
        "/dev",
        "/etc",
        "/private",
        "/sbin",
        "/usr",
        "/var",
    ];

    if protected_exact.contains(&normalized.as_str()) {
        return Some(format!("Refusing to delete protected path {normalized}"));
    }

    if std::env::var("HOME")
        .ok()
        .map(|home| normalized == normalized_path_text(Path::new(&home)))
        .unwrap_or(false)
    {
        return Some("Refusing to delete the home directory itself".to_string());
    }

    None
}

fn normalized_path_text(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let trimmed = text.trim_end_matches('/');

    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn measured_delete_bytes(path: &Path) -> std::io::Result<u64> {
    let metadata = fs::symlink_metadata(path)?;

    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        let mut total = 0;
        for entry in fs::read_dir(path)? {
            total += measured_delete_bytes(&entry?.path()).unwrap_or(0);
        }
        Ok(total)
    } else {
        Ok(metadata.len())
    }
}

#[tauri::command]
fn show_in_folder(path: String) {
    #[cfg(target_os = "windows")]
    {
        use regex::Regex;

        let re = Regex::new(r"/").unwrap();
        let result = re.replace_all(&path, "\\");
        Command::new("explorer")
            .args(["/select,", format!("{}", result).as_str()]) // The comma after select is not a typo
            .spawn()
            .unwrap();
    }

    #[cfg(target_os = "linux")]
    {
        // if path.contains(",") {
        // see https://gitlab.freedesktop.org/dbus/dbus/-/issues/76
        let new_path = match fs::metadata(&path).unwrap().is_dir() {
            true => path,
            false => {
                let mut path2 = PathBuf::from(path);
                path2.pop();
                path2.into_os_string().into_string().unwrap()
            }
        };
        Command::new("xdg-open").arg(&new_path).spawn().unwrap();
        // } else {
        //     Command::new("dbus-send")
        //         .args([
        //             "--session",
        //             "--dest=org.freedesktop.FileManager1",
        //             "--type=method_call",
        //             "/org/freedesktop/FileManager1",
        //             "org.freedesktop.FileManager1.ShowItems",
        //             format!("array:string:\"file://{path}\"").as_str(),
        //             "string:\"\"",
        //         ])
        //         .spawn()
        //         .unwrap();
        // }
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open").args(["-R", &path]).spawn().unwrap();
    }
}
// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
fn get_disks() -> String {
    let mut sys = System::new_all();
    sys.refresh_all();

    let mut vec: Vec<SquirrelDisk> = Vec::new();

    for disk in sys.disks() {
        vec.push(SquirrelDisk {
            name: disk.name().to_str().unwrap(),
            s_mount_point: disk.mount_point().display().to_string(),
            total_space: disk.total_space(),
            available_space: disk.available_space(),
            is_removable: disk.is_removable(),
        });
    }
    serde_json::to_string(&vec).unwrap().into()
}

pub struct MyState(Mutex<Option<CommandChild>>);

#[tauri::command]
fn start_scanning(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, MyState>,
    path: String,
    ratio: String,
) -> Result<(), ()> {
    scan::start(app_handle, state, path, ratio)
}

#[tauri::command]
fn stop_scanning(
    _app_handle: tauri::AppHandle,
    state: tauri::State<'_, MyState>,
    _path: String,
) -> Result<(), ()> {
    scan::stop(state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_delete_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "squirreldisk-delete-{name}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn deletion_protection_rejects_roots_and_major_system_dirs() {
        assert!(deletion_protection_reason(Path::new("/")).is_some());
        assert!(deletion_protection_reason(Path::new("/System")).is_some());
        assert!(deletion_protection_reason(Path::new("/Users")).is_some());
        assert!(deletion_protection_reason(Path::new("/tmp/squirreldisk-file")).is_none());
    }

    #[test]
    fn delete_permanently_removes_files_and_reports_bytes() {
        let dir = temp_delete_dir("file");
        let file_path = dir.join("large.tmp");
        let mut file = fs::File::create(&file_path).unwrap();
        file.write_all(&[7_u8; 4096]).unwrap();
        drop(file);

        let outcome = delete_permanently_at_path(&file_path).unwrap();

        assert!(!file_path.exists());
        assert_eq!(outcome.deleted_bytes, 4096);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn delete_permanently_removes_directories_recursively() {
        let dir = temp_delete_dir("directory");
        let target = dir.join("collected");
        fs::create_dir_all(target.join("nested")).unwrap();
        fs::write(target.join("a.bin"), &[1_u8; 200]).unwrap();
        fs::write(target.join("nested/b.bin"), &[2_u8; 300]).unwrap();

        let outcome = delete_permanently_at_path(&target).unwrap();

        assert!(!target.exists());
        assert_eq!(outcome.deleted_bytes, 500);
        fs::remove_dir_all(dir).unwrap();
    }
}
