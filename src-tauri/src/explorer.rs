use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

pub fn reveal(app: &AppHandle, path: &str) -> Result<(), String> {
    // The service has already checked workspace scope and rejected links and
    // traversal. Explorer's explicit /select command selects the actual file;
    // the opener's Windows PIDL fallback can silently open only its parent.
    #[cfg(windows)]
    if std::path::Path::new(path).is_file() {
        use std::os::windows::process::CommandExt;
        let argument = selection_argument(path)?;
        let windows = std::env::var_os("SystemRoot").ok_or("Windows directory is unavailable")?;
        std::process::Command::new(std::path::PathBuf::from(windows).join("explorer.exe"))
            .raw_arg(argument)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn selection_argument(path: &str) -> Result<String, String> {
    if path.contains(['"', '\0', '\r', '\n']) {
        return Err("Invalid Explorer path".into());
    }
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", unc)
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    };
    Ok(format!("/select,\"{}\"", path))
}

#[cfg(all(test, windows))]
mod tests {
    use super::selection_argument;
    #[test]
    fn selects_exact_file_with_spaces_commas_and_unc_paths() {
        assert_eq!(
            selection_argument(r"C:\Notes\Folder\A, B.md").unwrap(),
            r#"/select,"C:\Notes\Folder\A, B.md""#
        );
        assert_eq!(
            selection_argument(r"\\?\UNC\server\share\A B.md").unwrap(),
            r#"/select,"\\server\share\A B.md""#
        );
        assert!(selection_argument("C:\\bad\"argument").is_err());
    }
}
