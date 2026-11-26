#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const ORB_SIZE: f64 = 56.0;
const CARD_WIDTH: f64 = 360.0;
/// How long the modal waits for a desktop snapshot before opening over a solid
/// scrim. On Wayland the screenshot portal can block indefinitely (for example
/// on a permission prompt), and the window is hidden while it runs.
const CAPTURE_TIMEOUT: Duration = Duration::from_millis(2500);

const TREE_LABEL: &str = "tree";
/// Matches #modal-backdrop in style.css, so the tree window's first frame isn't white.
const TREE_BACKGROUND: Color = Color(10, 15, 29, 255);

/// Set while a snapshot is in flight, so a stuck portal call isn't joined by more.
static CAPTURE_BUSY: AtomicBool = AtomicBool::new(false);

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
    /// The tree window is open and the orb is hidden.
    Tree,
}

struct Runtime {
    data: AppData,
    mode: Mode,
    /// Blurred-desktop snapshot waiting for the tree window to pick it up.
    snapshot: Option<String>,
}

pub struct AppState(Mutex<Runtime>);

#[derive(Serialize)]
pub struct ViewResult {
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

/// Snapshots the monitor containing (x, y). Returns None when capture is refused
/// (e.g. a declined Wayland portal prompt); the tree then uses a solid scrim.
fn capture_desktop_bg(x: i32, y: i32) -> Option<String> {
    let monitor = xcap::Monitor::from_point(x, y)
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

/// Whether to snapshot the desktop for the blurred backdrop. Not on Wayland:
/// the only route there is the screenshot portal, which asks for permission and
/// makes GNOME flash the whole screen white on every capture, each time the
/// tree opens. The tree then sits on a solid background. Setting
/// CONTEXTED_MIND_BLUR=1 turns the snapshot back on.
fn desktop_capture_allowed() -> bool {
    if std::env::var_os("CONTEXTED_MIND_BLUR").is_some_and(|v| v == "1") {
        return true;
    }
    !is_wayland_session()
}

/// Read from the session, not GDK_BACKEND, which main() forces to x11.
fn is_wayland_session() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")
            || std::env::var_os("WAYLAND_DISPLAY").is_some())
}

/// Runs the snapshot on its own thread and gives up after CAPTURE_TIMEOUT, so a
/// screenshot portal that never answers can't leave the app with no window.
async fn capture_with_timeout(x: i32, y: i32) -> Option<String> {
    if !desktop_capture_allowed() || CAPTURE_BUSY.swap(true, Ordering::SeqCst) {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let shot = capture_desktop_bg(x, y);
        CAPTURE_BUSY.store(false, Ordering::SeqCst);
        let _ = tx.send(shot);
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(CAPTURE_TIMEOUT).ok().flatten())
        .await
        .ok()
        .flatten()
}

/// Shows the orb on every workspace. Re-applied after each hide/show and
/// fullscreen change, since some X11 window managers drop sticky state on remap.
fn stick_to_all_workspaces(window: &WebviewWindow) {
    let _ = window.set_visible_on_all_workspaces(true);
}

/// Puts the window back to orb size at the saved position.
fn restore_orb_geometry(window: &WebviewWindow, x: i32, y: i32) {
    let _ = window.set_size(LogicalSize::new(ORB_SIZE, ORB_SIZE));
    let _ = window.set_position(PhysicalPosition::new(x, y));
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
            restore_orb_geometry(&window, x, y);
            let _ = window.set_always_on_top(true);
            Ok(ViewResult { flipped: false })
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
            Ok(ViewResult { flipped: flip })
        }
        _ => Err("Unknown mode".into()),
    }
}

/// Opens the context tree in its own window. The tree used to be the orb window
/// grown to fullscreen, but WebKitGTK on Wayland/XWayland (seen on GNOME with
/// Intel graphics) failed to repaint a transparent window resized that far,
/// leaving it see-through or white. This window is opaque and created at the
/// monitor's size, so it is never transparent and never resized.
#[tauri::command]
async fn open_tree(
    flipped: bool,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(tree) = app.get_webview_window(TREE_LABEL) {
        let _ = tree.set_focus();
        return Ok(());
    }
    {
        let mut rt = state.0.lock().unwrap();
        if rt.mode == Mode::Hover {
            remember_orb_position(&window, &mut rt, flipped);
        }
        rt.mode = Mode::Tree;
        rt.snapshot = None;
    }

    // Read the monitor while the orb is still mapped; a hidden X11 window can
    // report a stale or missing monitor.
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let (px, py) = window
        .outer_position()
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));

    // Hide the orb so it and the hover card aren't part of the snapshot.
    let _ = window.hide();
    let snapshot = if desktop_capture_allowed() {
        wait_ms(80).await;
        capture_with_timeout(px, py).await
    } else {
        None
    };
    state.0.lock().unwrap().snapshot = snapshot;

    let mut builder = WebviewWindowBuilder::new(&app, TREE_LABEL, WebviewUrl::App("index.html".into()))
        .title("Contexted Mind")
        .decorations(false)
        .transparent(false)
        .background_color(TREE_BACKGROUND)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .focused(true);
    if let Some(m) = &monitor {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        builder = builder.position(pos.x, pos.y).inner_size(size.width, size.height);
    }
    // Fullscreen covers GNOME's top bar; the explicit monitor-sized geometry
    // above is the fallback if the window manager declines.
    builder = builder.fullscreen(true);

    match builder.build() {
        Ok(tree) => {
            let _ = tree.set_focus();
            Ok(())
        }
        Err(e) => {
            show_orb(&app);
            Err(e.to_string())
        }
    }
}

/// A clickable part of the orb window, in CSS pixels.
#[derive(Deserialize, Debug)]
pub struct HitShape {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    /// An ellipse filling the box rather than the box itself.
    round: bool,
}

/// Approximates a shape with whole-pixel rectangles (x, y, width, height):
/// one per pixel row for a round shape, so its corners stay click-through.
fn shape_rects(s: &HitShape) -> Vec<(i32, i32, i32, i32)> {
    let (x0, y0) = (s.x.floor() as i32, s.y.floor() as i32);
    let (w, h) = ((s.x + s.w).ceil() as i32 - x0, (s.y + s.h).ceil() as i32 - y0);
    if w <= 0 || h <= 0 {
        return vec![];
    }
    if !s.round {
        return vec![(x0, y0, w, h)];
    }
    let (rx, ry) = (w as f64 / 2.0, h as f64 / 2.0);
    (0..h)
        .filter_map(|row| {
            let dy = (row as f64 + 0.5 - ry) / ry;
            let half = rx * (1.0 - dy * dy).max(0.0).sqrt();
            let left = (rx - half).floor() as i32;
            let right = (rx + half).ceil() as i32;
            (right > left).then_some((x0 + left, y0 + row, right - left, 1))
        })
        .collect()
}

/// Limits where the orb window takes clicks, so clicks on its see-through
/// corners reach the window underneath. Linux only: it sets an X11 input
/// shape, and the app always runs on X11 or XWayland there.
#[tauri::command]
fn set_hit_region(shapes: Vec<HitShape>, window: WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            use gtk::prelude::WidgetExt;
            let Ok(gtk_window) = target.gtk_window() else {
                return;
            };
            let region = gtk::cairo::Region::create();
            for (x, y, w, h) in shapes.iter().flat_map(shape_rects) {
                let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(x, y, w, h));
            }
            gtk_window.input_shape_combine_region(Some(&region));
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (shapes, window);
}

/// Hands the desktop snapshot to the tree window once, then forgets it.
#[tauri::command]
fn take_snapshot(state: State<AppState>) -> Option<String> {
    state.0.lock().unwrap().snapshot.take()
}

#[tauri::command]
fn close_tree(app: AppHandle) {
    match app.get_webview_window(TREE_LABEL) {
        // The Destroyed event brings the orb back.
        Some(tree) => {
            let _ = tree.destroy();
        }
        None => show_orb(&app),
    }
}

/// Puts the orb back where it was and tells its page to reset to the pill.
fn show_orb(app: &AppHandle) {
    let Some(orb) = app.get_webview_window("main") else {
        return;
    };
    let (x, y) = {
        let state = app.state::<AppState>();
        let mut rt = state.0.lock().unwrap();
        rt.mode = Mode::Pill;
        rt.snapshot = None;
        (rt.data.saved_x, rt.data.saved_y)
    };
    restore_orb_geometry(&orb, x, y);
    let _ = orb.show();
    let _ = orb.set_always_on_top(true);
    stick_to_all_workspaces(&orb);
    let _ = orb.emit("tree-closed", ());
}

/// Gives the compositor or window manager a moment to apply a window change.
async fn wait_ms(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(ms));
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
        // WebKitGTK's GPU compositing under XWayland (seen on GNOME with Intel
        // graphics) repaints only the regions under the pointer or focus, so
        // rows and buttons flicker and vanish. Software painting redraws the
        // whole page and is plenty fast for this UI. WEBKIT_DISABLE_COMPOSITING_MODE=0
        // turns GPU compositing back on.
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    let data = load_from(&storage_path());
    let (x, y) = (data.saved_x, data.saved_y);

    tauri::Builder::default()
        .manage(AppState(Mutex::new(Runtime {
            data,
            mode: Mode::Pill,
            snapshot: None,
        })))
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_tree,
            set_view_mode,
            open_tree,
            take_snapshot,
            set_hit_region,
            close_tree,
            quit_app
        ])
        .on_window_event(|window, event| {
            if window.label() == TREE_LABEL {
                if let WindowEvent::Destroyed = event {
                    show_orb(window.app_handle());
                }
            }
        })
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                // Windows creates new windows at least 136px wide, ignoring the
                // configured size, which would leave an invisible click-blocking strip.
                let _ = window.set_size(LogicalSize::new(ORB_SIZE, ORB_SIZE));
                let _ = window.set_position(PhysicalPosition::new(x, y));
                let _ = window.show();
                stick_to_all_workspaces(&window);
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
    fn round_hit_shape_leaves_corners_out() {
        let rects = shape_rects(&HitShape { x: 4.0, y: 4.0, w: 48.0, h: 48.0, round: true });
        assert_eq!(rects.len(), 48);
        let inside = |px: i32, py: i32| {
            rects.iter().any(|&(x, y, w, h)| px >= x && px < x + w && py >= y && py < y + h)
        };
        assert!(inside(28, 28), "centre");
        assert!(inside(5, 28) && inside(50, 28), "left and right edges");
        assert!(!inside(5, 5) && !inside(50, 50), "corners");
        assert!(!inside(0, 0) && !inside(55, 28), "outside the box");
    }

    #[test]
    fn square_hit_shape_is_one_rect() {
        let rects = shape_rects(&HitShape { x: 4.2, y: 4.0, w: 352.0, h: 48.0, round: false });
        assert_eq!(rects, vec![(4, 4, 353, 48)]);
    }

    #[test]
    fn missing_file_gives_empty_tree() {
        let path = temp_file("missing").with_file_name("absent.json");
        assert!(load_from(&path).tasks.is_empty());
    }
}
