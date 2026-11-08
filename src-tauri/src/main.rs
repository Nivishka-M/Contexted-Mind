#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow};

const ORB_SIZE: f64 = 56.0;
const CARD_WIDTH: f64 = 360.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TaskNode {
    pub id: String,
    pub title: String,
    pub done: bool,
    #[serde(default)]
    pub children: Vec<TaskNode>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppData {
    pub active_task_id: Option<String>,
    pub tasks: Vec<TaskNode>,
    // Physical pixels, the unit the OS reports window positions in.
    pub saved_x: i32,
    pub saved_y: i32,
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            active_task_id: None,
            tasks: vec![],
            saved_x: 40,
            saved_y: 120,
        }
    }
}

/// What the frontend may change. The orb position is owned by Rust, so a task
/// edit can never overwrite it with a stale value.
#[derive(Deserialize, Debug)]
pub struct TreeUpdate {
    pub active_task_id: Option<String>,
    pub tasks: Vec<TaskNode>,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Pill,
    Hover,
    Modal,
}

struct Runtime {
    data: AppData,
    mode: Mode,
}

pub struct AppState(Mutex<Runtime>);

#[derive(Serialize)]
pub struct ViewResult {
    /// Blurred-desktop snapshot, only when entering the modal.
    background: Option<String>,
    /// The hover card opened to the left because the orb is near the right edge.
    flipped: bool,
}

fn storage_path() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("contexted-mind");
    let _ = fs::create_dir_all(&dir);
    dir.push("tasks.json");
    dir
}

fn load_from(path: &Path) -> AppData {
    let Ok(raw) = fs::read_to_string(path) else {
        return AppData::default();
    };
    match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(_) => {
            // Keep an unreadable file so the next save can't destroy the user's tree.
            let _ = fs::rename(path, path.with_extension("corrupt.json"));
            AppData::default()
        }
    }
}

/// Writes through a temp file so a crash mid-save can't truncate the tree.
fn save_to(path: &Path, data: &AppData) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(data)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)
}

#[tauri::command]
fn get_state(state: State<AppState>) -> AppData {
    state.0.lock().unwrap().data.clone()
}

#[tauri::command]
fn save_tree(update: TreeUpdate, state: State<AppState>) -> Result<(), String> {
    let mut rt = state.0.lock().unwrap();
    rt.data.active_task_id = update.active_task_id;
    rt.data.tasks = update.tasks;
    save_to(&storage_path(), &rt.data).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Snapshots the monitor the orb is on. Returns None when capture is refused
/// (e.g. a declined Wayland portal prompt); the modal then uses a solid scrim.
fn capture_desktop_bg(window: &WebviewWindow) -> Option<String> {
    let pos = window.outer_position().ok()?;
    let monitor = xcap::Monitor::from_point(pos.x, pos.y)
        .ok()
        .or_else(|| xcap::Monitor::all().ok()?.into_iter().next())?;
    let shot = monitor.capture_image().ok()?;

    // A quarter-size frame is plenty once blurred, and keeps encode and decode cheap.
    let rgb = image::DynamicImage::ImageRgba8(shot).into_rgb8();
    let small = image::imageops::resize(
        &rgb,
        (rgb.width() / 4).max(1),
        (rgb.height() / 4).max(1),
        image::imageops::FilterType::Triangle,
    );
    let mut buf = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut buf, 70)
        .encode_image(&small)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        BASE64.encode(buf.into_inner())
    ))
}

/// Records where the orb sits. Called only while the window is orb-anchored,
/// and undoes the left shift applied when the hover card was flipped.
fn remember_orb_position(window: &WebviewWindow, rt: &mut Runtime, flipped: bool) {
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let shift = if flipped {
        ((CARD_WIDTH - ORB_SIZE) * window.scale_factor().unwrap_or(1.0)) as i32
    } else {
        0
    };
    rt.data.saved_x = pos.x + shift;
    rt.data.saved_y = pos.y;
    let _ = save_to(&storage_path(), &rt.data);
}

/// True when a hover card opened to the right of the orb would leave its monitor.
fn card_needs_flip(window: &WebviewWindow) -> bool {
    let (Ok(Some(monitor)), Ok(pos), Ok(scale)) = (
        window.current_monitor(),
        window.outer_position(),
        window.scale_factor(),
    ) else {
        return false;
    };
    let right_edge = monitor.position().x + monitor.size().width as i32;
    pos.x + (CARD_WIDTH * scale) as i32 > right_edge
}

#[tauri::command]
async fn set_view_mode(
    mode: String,
    flipped: bool,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ViewResult, String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    match mode.as_str() {
        "pill" => {
            let (x, y) = {
                let mut rt = state.0.lock().unwrap();
                if rt.mode == Mode::Hover {
                    remember_orb_position(&window, &mut rt, flipped);
                }
                rt.mode = Mode::Pill;
                (rt.data.saved_x, rt.data.saved_y)
            };
            let _ = window.set_fullscreen(false);
            let _ = window.set_size(LogicalSize::new(ORB_SIZE, ORB_SIZE));
            let _ = window.set_position(PhysicalPosition::new(x, y));
            let _ = window.set_always_on_top(true);
            Ok(ViewResult {
                background: None,
                flipped: false,
            })
        }
        "hover" => {
            let flip = card_needs_flip(&window);
            {
                let mut rt = state.0.lock().unwrap();
                remember_orb_position(&window, &mut rt, false);
                rt.mode = Mode::Hover;
            }
            if flip {
                if let Ok(pos) = window.outer_position() {
                    let shift = ((CARD_WIDTH - ORB_SIZE) * scale) as i32;
                    let _ = window.set_position(PhysicalPosition::new(pos.x - shift, pos.y));
                }
            }
            let _ = window.set_size(LogicalSize::new(CARD_WIDTH, ORB_SIZE));
            Ok(ViewResult {
                background: None,
                flipped: flip,
            })
        }
        "modal" => {
            {
                let mut rt = state.0.lock().unwrap();
                if rt.mode == Mode::Hover {
                    remember_orb_position(&window, &mut rt, flipped);
                }
                rt.mode = Mode::Modal;
            }
            // Hide first so the orb and hover card aren't part of the snapshot.
            let _ = window.hide();
            wait_for_compositor().await;
            let background = capture_desktop_bg(&window);
            let _ = window.set_fullscreen(true);
            let _ = window.show();
            let _ = window.set_always_on_top(true);
            let _ = window.set_focus();
            Ok(ViewResult {
                background,
                flipped: false,
            })
        }
        _ => Err("Unknown mode".into()),
    }
}

/// Gives the compositor a moment to remove the hidden window from the screen.
async fn wait_for_compositor() {
    let _ = tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(Duration::from_millis(60));
    })
    .await;
}

fn main() {
    // GNOME on Wayland ignores always-on-top and app-set positions, which this
    // app depends on. XWayland honours both. WebKitGTK's DMA-BUF renderer also
    // breaks transparent windows on some GPUs.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    let data = load_from(&storage_path());
    let (x, y) = (data.saved_x, data.saved_y);

    tauri::Builder::default()
        .manage(AppState(Mutex::new(Runtime {
            data,
            mode: Mode::Pill,
        })))
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_tree,
            set_view_mode,
            quit_app
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                // Windows creates new windows at least 136px wide, ignoring the
                // configured size, which would leave an invisible click-blocking strip.
                let _ = window.set_size(LogicalSize::new(ORB_SIZE, ORB_SIZE));
                let _ = window.set_position(PhysicalPosition::new(x, y));
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Contexted Mind");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("contexted-mind-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join("tasks.json")
    }

    #[test]
    fn save_then_load_round_trips() {
        let path = temp_file("round-trip");
        let data = AppData {
            active_task_id: Some("a".into()),
            tasks: vec![TaskNode {
                id: "a".into(),
                title: "Parent".into(),
                done: false,
                children: vec![TaskNode {
                    id: "b".into(),
                    title: "Child".into(),
                    done: true,
                    children: vec![],
                }],
            }],
            saved_x: -1200,
            saved_y: 300,
        };
        save_to(&path, &data).unwrap();
        assert_eq!(load_from(&path), data);
    }

    #[test]
    fn corrupt_file_is_kept_aside_not_overwritten() {
        let path = temp_file("corrupt");
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load_from(&path), AppData::default());
        let kept = path.with_extension("corrupt.json");
        assert_eq!(fs::read_to_string(kept).unwrap(), "{ not json");
    }

    #[test]
    fn missing_file_gives_empty_tree() {
        let path = temp_file("missing").with_file_name("absent.json");
        assert!(load_from(&path).tasks.is_empty());
    }
}
