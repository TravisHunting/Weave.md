//! Desktop storage location policy, separate from workspace/graph operations.
use std::path::{Path, PathBuf};

pub fn application_data() -> Result<PathBuf, String> {
    if cfg!(windows) {
        return std::env::var_os("LOCALAPPDATA")
            .map(|p| PathBuf::from(p).join("Weave"))
            .ok_or_else(|| {
                "LOCALAPPDATA is unavailable; Weave needs a writable application data directory."
                    .into()
            });
    }
    linux_data_directory(
        std::env::var_os("XDG_DATA_HOME").as_deref().map(Path::new),
        std::env::var_os("HOME").as_deref().map(Path::new),
    )
}

fn linux_data_directory(xdg: Option<&Path>, home: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = xdg.filter(|path| path.is_absolute()) {
        return Ok(path.join("Weave"));
    }
    home.filter(|path| path.is_absolute()).map(|path| path.join(".local/share/Weave"))
        .ok_or_else(|| "A user data directory is unavailable; Weave needs a writable application data directory.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn honors_absolute_xdg_and_ignores_relative_values() {
        let temp = tempfile::tempdir().unwrap();
        let xdg = temp.path().join("data");
        assert_eq!(
            linux_data_directory(Some(&xdg), Some(temp.path())).unwrap(),
            xdg.join("Weave")
        );
        assert_eq!(
            linux_data_directory(Some(Path::new("relative")), Some(temp.path())).unwrap(),
            temp.path().join(".local/share/Weave")
        );
        assert!(linux_data_directory(None, None).is_err());
    }
}
