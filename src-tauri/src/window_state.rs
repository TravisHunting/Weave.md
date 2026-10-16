//! Native window placement is separate from article/workspace state. In particular,
//! a maximized or minimized window must retain its normal restore bounds.
use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Window};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SavedPlacement {
    version: u8,
    normal: Bounds,
    scale_factor: f64,
    maximized: bool,
}

#[derive(Clone, Copy, Debug)]
struct Screen {
    work: Bounds,
    scale_factor: f64,
}

pub struct WindowState {
    path: PathBuf,
}

impl WindowState {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read(&self) -> Option<SavedPlacement> {
        // A corrupt or future state file must never prevent the app from opening.
        if std::fs::metadata(&self.path).ok()?.len() > 16_384 {
            return None;
        }
        let saved: SavedPlacement =
            serde_json::from_slice(&std::fs::read(&self.path).ok()?).ok()?;
        saved.valid().then_some(saved)
    }

    pub fn restore(&self, window: &Window) -> tauri::Result<()> {
        let monitors = window.available_monitors()?;
        let primary = window.primary_monitor()?;
        let screens: Vec<_> = monitors.iter().map(screen).collect();
        let primary_index = primary
            .as_ref()
            .and_then(|primary| {
                monitors
                    .iter()
                    .position(|monitor| monitor.position() == primary.position())
            })
            .unwrap_or(0);
        let saved = self.read();
        if let Some((bounds, scale)) = restore_bounds(saved.as_ref(), &screens, primary_index) {
            // Move first so any monitor-DPI transition precedes the final size.
            window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
            // Windows retains invisible resize borders on a frameless window.
            // WINDOWPLACEMENT stores outer bounds, while set_size expects the
            // client size. Preserve that distinction to avoid growth on restart.
            let outer = window.outer_size()?;
            let inner = window.inner_size()?;
            let width = bounds
                .width
                .saturating_sub(outer.width.saturating_sub(inner.width))
                .max(1);
            let height = bounds
                .height
                .saturating_sub(outer.height.saturating_sub(inner.height))
                .max(1);
            // Small displays and changed scaling must still leave every control reachable.
            window.set_min_size(Some(PhysicalSize::new(
                ((800.0 * scale).round() as u32).min(width),
                ((600.0 * scale).round() as u32).min(height),
            )))?;
            window.set_size(PhysicalSize::new(width, height))?;
        }
        if saved.is_some_and(|placement| placement.maximized) {
            window.maximize()?;
        }
        Ok(())
    }

    pub fn save(&self, window: &Window) -> Result<(), String> {
        let saved = capture(window)?;
        if !saved.valid() {
            return Err("Window placement was invalid".into());
        }
        let parent = self
            .path
            .parent()
            .ok_or("Window state directory unavailable")?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        serde_json::to_writer_pretty(&mut temporary, &saved).map_err(|error| error.to_string())?;
        temporary
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temporary
            .persist(&self.path)
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl SavedPlacement {
    fn valid(&self) -> bool {
        self.version == 1
            && (100..=100_000).contains(&self.normal.width)
            && (100..=100_000).contains(&self.normal.height)
            && (-100_000..=100_000).contains(&self.normal.x)
            && (-100_000..=100_000).contains(&self.normal.y)
            && self.scale_factor.is_finite()
            && (0.25..=16.0).contains(&self.scale_factor)
    }
}

fn screen(monitor: &tauri::Monitor) -> Screen {
    let area = monitor.work_area();
    Screen {
        work: Bounds {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        scale_factor: monitor.scale_factor(),
    }
}

fn intersection(first: Bounds, second: Bounds) -> i64 {
    let width = (i64::from(first.x) + i64::from(first.width))
        .min(i64::from(second.x) + i64::from(second.width))
        - i64::from(first.x.max(second.x));
    let height = (i64::from(first.y) + i64::from(first.height))
        .min(i64::from(second.y) + i64::from(second.height))
        - i64::from(first.y.max(second.y));
    width.max(0) * height.max(0)
}

fn restore_bounds(
    saved: Option<&SavedPlacement>,
    screens: &[Screen],
    primary: usize,
) -> Option<(Bounds, f64)> {
    let fallback = *screens.get(primary).or_else(|| screens.first())?;
    let saved = saved.filter(|placement| placement.valid());
    let matching = saved.and_then(|placement| {
        screens
            .iter()
            .map(|screen| (screen, intersection(placement.normal, screen.work)))
            .filter(|(_, area)| *area > 0)
            .max_by_key(|(_, area)| *area)
            .map(|(screen, _)| *screen)
    });
    let target = matching.unwrap_or(fallback);
    if target.work.width == 0 || target.work.height == 0 {
        return None;
    }
    let (width, height) = if let Some(saved) = saved {
        let ratio = target.scale_factor / saved.scale_factor;
        (
            (f64::from(saved.normal.width) * ratio).round() as u32,
            (f64::from(saved.normal.height) * ratio).round() as u32,
        )
    } else {
        (
            (1500.0 * target.scale_factor).round() as u32,
            (1000.0 * target.scale_factor).round() as u32,
        )
    };
    let width = width
        .max((800.0 * target.scale_factor).round() as u32)
        .min(target.work.width);
    let height = height
        .max((600.0 * target.scale_factor).round() as u32)
        .min(target.work.height);
    let (x, y) = if matching.is_some() {
        let normal = saved.unwrap().normal;
        (
            i64::from(normal.x).clamp(
                i64::from(target.work.x),
                i64::from(target.work.x) + i64::from(target.work.width - width),
            ),
            i64::from(normal.y).clamp(
                i64::from(target.work.y),
                i64::from(target.work.y) + i64::from(target.work.height - height),
            ),
        )
    } else {
        (
            i64::from(target.work.x) + i64::from((target.work.width - width) / 2),
            i64::from(target.work.y) + i64::from((target.work.height - height) / 2),
        )
    };
    Some((
        Bounds {
            x: x as i32,
            y: y as i32,
            width,
            height,
        },
        target.scale_factor,
    ))
}

// GetWindowPlacement retains the normal rectangle even when Windows has
// minimized or maximized the window. Resize-event snapshots do not: the ordering
// of those events can replace restore bounds with the maximized rectangle.
#[cfg(windows)]
fn capture(window: &Window) -> Result<SavedPlacement, String> {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Placement {
        length: u32,
        flags: u32,
        show_cmd: u32,
        min_position: Point,
        max_position: Point,
        normal: Rect,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowPlacement(window: *mut c_void, placement: *mut Placement) -> i32;
    }
    let mut placement = Placement {
        length: std::mem::size_of::<Placement>() as u32,
        ..Placement::default()
    };
    let handle = window.hwnd().map_err(|error| error.to_string())?;
    // SAFETY: the handle is owned by the live Tauri window and the initialized
    // structure has the Win32 WINDOWPLACEMENT layout and size.
    if unsafe { GetWindowPlacement(handle.0, &mut placement) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?;
    // WINDOWPLACEMENT uses workspace coordinates; Tauri uses screen coordinates.
    // Account for a taskbar on the top or left before saving the normal position.
    let (offset_x, offset_y) = monitor
        .as_ref()
        .map(|monitor| {
            (
                monitor.work_area().position.x - monitor.position().x,
                monitor.work_area().position.y - monitor.position().y,
            )
        })
        .unwrap_or((0, 0));
    let minimized = matches!(placement.show_cmd, 2 | 6 | 7 | 11);
    Ok(SavedPlacement {
        version: 1,
        normal: Bounds {
            x: placement.normal.left + offset_x,
            y: placement.normal.top + offset_y,
            width: (placement.normal.right - placement.normal.left).max(0) as u32,
            height: (placement.normal.bottom - placement.normal.top).max(0) as u32,
        },
        scale_factor: window.scale_factor().map_err(|error| error.to_string())?,
        maximized: placement.show_cmd == 3 || (minimized && placement.flags & 2 != 0),
    })
}

#[cfg(not(windows))]
fn capture(window: &Window) -> Result<SavedPlacement, String> {
    let previous = window.state::<WindowState>().read();
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized || window.is_minimized().map_err(|error| error.to_string())? {
        if let Some(mut saved) = previous {
            saved.maximized = maximized;
            return Ok(saved);
        }
    }
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    Ok(SavedPlacement {
        version: 1,
        normal: Bounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        scale_factor: window.scale_factor().map_err(|error| error.to_string())?,
        maximized,
    })
}

pub fn save(window: &Window) {
    if window.label() == "main" {
        if let Some(state) = window.try_state::<WindowState>() {
            if let Err(error) = state.save(window) {
                eprintln!("Unable to save window placement: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement(normal: Bounds, scale_factor: f64) -> SavedPlacement {
        SavedPlacement {
            version: 1,
            normal,
            scale_factor,
            maximized: true,
        }
    }
    fn display(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> Screen {
        Screen {
            work: Bounds {
                x,
                y,
                width,
                height,
            },
            scale_factor,
        }
    }

    #[test]
    fn normal_bounds_on_a_second_monitor_are_preserved() {
        let saved = placement(
            Bounds {
                x: -1750,
                y: 80,
                width: 1200,
                height: 850,
            },
            1.0,
        );
        let screens = [
            display(0, 0, 1920, 1040, 1.0),
            display(-1920, 0, 1920, 1040, 1.0),
        ];
        assert_eq!(
            restore_bounds(Some(&saved), &screens, 0).unwrap().0,
            saved.normal
        );
    }

    #[test]
    fn disconnected_monitor_returns_window_to_primary_work_area() {
        let saved = placement(
            Bounds {
                x: -1800,
                y: 50,
                width: 1200,
                height: 900,
            },
            1.0,
        );
        let screens = [display(0, 40, 1920, 1040, 1.0)];
        assert_eq!(
            restore_bounds(Some(&saved), &screens, 0).unwrap().0,
            Bounds {
                x: 360,
                y: 110,
                width: 1200,
                height: 900
            }
        );
    }

    #[test]
    fn dpi_change_preserves_logical_size_and_keeps_window_reachable() {
        let saved = placement(
            Bounds {
                x: 1500,
                y: 700,
                width: 1000,
                height: 650,
            },
            1.0,
        );
        let screens = [display(0, 40, 2560, 1400, 2.0)];
        assert_eq!(
            restore_bounds(Some(&saved), &screens, 0).unwrap().0,
            Bounds {
                x: 560,
                y: 140,
                width: 2000,
                height: 1300
            }
        );
    }

    #[test]
    fn small_display_clamps_window_and_respects_taskbar() {
        let saved = placement(
            Bounds {
                x: 20,
                y: 0,
                width: 1500,
                height: 1000,
            },
            1.0,
        );
        let screens = [display(48, 0, 720, 520, 1.0)];
        assert_eq!(
            restore_bounds(Some(&saved), &screens, 0).unwrap().0,
            screens[0].work
        );
    }

    #[test]
    fn corrupt_and_future_files_fall_back_without_blocking_startup() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("window-state.json");
        let state = WindowState::new(path.clone());
        std::fs::write(&path, b"{interrupted").unwrap();
        assert!(state.read().is_none());
        let mut saved = placement(
            Bounds {
                x: 1,
                y: 2,
                width: 1000,
                height: 700,
            },
            1.0,
        );
        saved.version = 2;
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        assert!(state.read().is_none());
        saved.version = 1;
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        assert!(state.read().unwrap().maximized);
    }

    #[test]
    fn invalid_saved_geometry_uses_a_visible_default() {
        let saved = placement(
            Bounds {
                x: i32::MAX,
                y: 0,
                width: u32::MAX,
                height: 10,
            },
            1.0,
        );
        let screens = [display(0, 0, 1920, 1040, 1.0)];
        assert_eq!(
            restore_bounds(Some(&saved), &screens, 0).unwrap().0,
            Bounds {
                x: 210,
                y: 20,
                width: 1500,
                height: 1000
            }
        );
    }
}
