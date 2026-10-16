fn main() {
    // Embed the portable reader template written by `npm run build:desktop`. A
    // build without it still compiles; exporting then reports how to fix it.
    let source = std::path::Path::new("../dist/export-template.html");
    println!("cargo:rerun-if-changed=../dist/export-template.html");
    let template = std::fs::read_to_string(source).unwrap_or_default();
    let out =
        std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("export-template.html");
    std::fs::write(out, template).expect("write export template");
    #[cfg(feature = "server")]
    {
        println!("cargo:rerun-if-changed=../dist/server/index.html");
        let page = std::fs::read("../dist/server/index.html")
            .expect("Run npm run build:server before building the headless server");
        std::fs::write(
            std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("server.html"),
            page,
        )
        .expect("write server frontend");
    }
    #[cfg(feature = "desktop")]
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new().static_vc_runtime(true)),
    )
    .expect("Unable to build Weave native resources");
}
