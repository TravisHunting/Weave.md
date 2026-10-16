//! No Tauri, WebView, window system, Node.js, or external assets at runtime.
fn main() {
    let mut args: Vec<_> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|a| a == "server" || a == "--server")
    {
        args.remove(0);
    }
    std::process::exit(weave::server::cli(args));
}
