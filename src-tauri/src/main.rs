#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![allow(unexpected_cfgs)]
mod scan;
mod snapshots;
mod window_style;

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{DiskExt, System, SystemExt};
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

#[cfg(target_os = "macos")]
use window_vibrancy::NSVisualEffectMaterial;

#[cfg(target_os = "linux")]
use {std::fs::metadata, std::path::PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SquirrelDisk<'a> {
    name: &'a str,
    s_mount_point: String,
    total_space: u64,
    available_space: u64,
    is_removable: bool,
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
            move_to_trash,
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
fn move_to_trash(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Path is empty".to_string());
    }

    if !Path::new(&path).exists() {
        return Err("Path no longer exists".to_string());
    }

    trash_path(&path)
}

#[cfg(target_os = "macos")]
fn trash_path(path: &str) -> Result<(), String> {
    let script = format!(
        "tell application \"Finder\" to delete POSIX file {}",
        apple_script_string(path)
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|error| error.to_string())?;

    command_result(output, "Finder could not move the item to Trash")
}

#[cfg(target_os = "macos")]
fn apple_script_string(value: &str) -> String {
    let mut escaped = String::from("\"");

    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            _ => escaped.push(ch),
        }
    }

    escaped.push('"');
    escaped
}

#[cfg(target_os = "linux")]
fn trash_path(path: &str) -> Result<(), String> {
    let output = Command::new("gio")
        .args(["trash", path])
        .output()
        .map_err(|error| error.to_string())?;

    command_result(output, "gio could not move the item to Trash")
}

#[cfg(target_os = "windows")]
fn trash_path(path: &str) -> Result<(), String> {
    let escaped = path.replace('\'', "''");
    let script = format!(
        r#"
Add-Type -AssemblyName Microsoft.VisualBasic
$path = '{}'
if (Test-Path -LiteralPath $path -PathType Container) {{
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin')
}} else {{
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin')
}}
"#,
        escaped
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| error.to_string())?;

    command_result(output, "Windows could not move the item to Recycle Bin")
}

fn command_result(output: std::process::Output, fallback: &str) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(fallback.to_string())
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
        let new_path = match metadata(&path).unwrap().is_dir() {
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
