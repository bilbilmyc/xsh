fn main() {
    // Cargo's links metadata orders this after the native dependency build.
    // Stage the exact library for this target so Tauri's CLI and build script
    // package the same component for dev, release and --target builds.
    let library = std::path::PathBuf::from(
        std::env::var_os("DEP_XSH_RDP_NATIVE_LIBRARY")
            .expect("xsh-rdp must provide its bundled native library"),
    );
    println!("cargo:rerun-if-changed={}", library.display());
    let runtime = std::path::Path::new("native-runtime");
    std::fs::create_dir_all(runtime).expect("create native runtime staging directory");
    let destination = runtime.join(library.file_name().unwrap());
    if std::fs::read(&destination).ok() != std::fs::read(&library).ok() {
        std::fs::copy(&library, destination).expect("stage bundled native RDP library");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    }
    tauri_build::build()
}
