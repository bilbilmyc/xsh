use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const SOURCE_HASH: &str = "e1b0bc1c1302f065d512525598da92c269f773bf5f1640439e2f1be6fff035d6";
const URI_HASH: &str = "e972a1d06183926ff398ddceec5bef5ab8e48f3f70916dd05905c88871012d2d";

fn main() {
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-changed=vendor/freerdp-3.32.2.tar.gz");
    println!("cargo:rerun-if-changed=vendor/uriparser-1.0.2.tar.gz");
    for variable in ["XSH_OPENSSL_ROOT", "XSH_FREERDP_SOURCE", "CMAKE", "PERL"] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let target = std::env::var("TARGET").unwrap();
    let source = if let Some(source) = std::env::var_os("XSH_FREERDP_SOURCE") {
        PathBuf::from(source)
    } else {
        let source = out.join("source/freerdp");
        let archive = std::fs::read("vendor/freerdp-3.32.2.tar.gz").unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&archive)), SOURCE_HASH);
        if !source.join("CMakeLists.txt").is_file() {
            tar::Archive::new(GzDecoder::new(archive.as_slice()))
                .unpack(out.join("source"))
                .expect("unpack pinned FreeRDP sources");
        }
        source
    };
    let ssl_root = if let Some(root) = std::env::var_os("XSH_OPENSSL_ROOT") {
        PathBuf::from(root)
    } else {
        // OUT_DIR is scoped to the target and build dependency fingerprint.
        // Editing the C adapter should not rebuild OpenSSL from scratch.
        let cached = out.join("openssl-build/install");
        let crypto = if target.contains("msvc") {
            "libcrypto.lib"
        } else {
            "libcrypto.a"
        };
        let ssl = if target.contains("msvc") {
            "libssl.lib"
        } else {
            "libssl.a"
        };
        if cached.join("include/openssl/opensslv.h").is_file()
            && cached.join("lib").join(crypto).is_file()
            && cached.join("lib").join(ssl).is_file()
        {
            cached
        } else {
            let artifacts = openssl_src::Build::new().build();
            artifacts.include_dir().parent().unwrap().to_path_buf()
        }
    };
    let msvc = target.contains("msvc");
    let uri_source = out.join("uri-source/uriparser");
    let uri_archive = std::fs::read("vendor/uriparser-1.0.2.tar.gz").unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&uri_archive)), URI_HASH);
    if !uri_source.join("CMakeLists.txt").is_file() {
        tar::Archive::new(GzDecoder::new(uri_archive.as_slice()))
            .unpack(out.join("uri-source"))
            .expect("unpack pinned URI parser sources");
    }
    // WinPR's Windows URL fallback treats plain certificate DNS names as URLs
    // and rejects them. Bundle the parser instead of weakening name checks.
    let uri = cmake::Config::new(uri_source)
        .out_dir(out.join("uri-build"))
        .profile("Release")
        .static_crt(true)
        .define("URIPARSER_SHARED_LIBS", "OFF")
        .define("URIPARSER_BUILD_TESTS", "OFF")
        .define("URIPARSER_BUILD_DOCS", "OFF")
        .define("URIPARSER_BUILD_TOOLS", "OFF")
        .define("URIPARSER_BUILD_WCHAR_T", "OFF")
        .define("URIPARSER_MSVC_STATIC_CRT", "ON")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        .define("CMAKE_INSTALL_LIBDIR", "lib")
        .build();
    let ssl_lib = |name: &str| {
        ssl_root.join("lib").join(if msvc {
            format!("lib{name}.lib")
        } else {
            format!("lib{name}.a")
        })
    };
    let prefix = cmake::Config::new("native")
        .profile("Release")
        .static_crt(true)
        .define("FREERDP_SOURCE", source)
        .define("OPENSSL_ROOT_DIR", &ssl_root)
        .define("OPENSSL_INCLUDE_DIR", ssl_root.join("include"))
        .define("OPENSSL_SSL_LIBRARY", ssl_lib("ssl"))
        .define("OPENSSL_CRYPTO_LIBRARY", ssl_lib("crypto"))
        .define("CMAKE_INSTALL_LIBDIR", "lib")
        .define("uriparser_DIR", uri.join("lib/cmake/uriparser-1.0.2"))
        .define(
            "XSH_RDP_TEST_PEER",
            if std::env::var_os("CARGO_FEATURE_TEST_PEER").is_some() {
                "ON"
            } else {
                "OFF"
            },
        )
        .build();
    println!(
        "cargo:rustc-link-search=native={}",
        prefix.join("lib").display()
    );
    println!("cargo:rustc-link-lib=dylib=xsh-rdp-native");
    if target.contains("apple") {
        // Unit tests load the copy next to their executable. The desktop also
        // adds the Frameworks rpath when constructing its application bundle.
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    }

    // The library is part of XSH, including cargo test executables. Tauri also
    // bundles this same library into the installed application's resources.
    let profile_dir = out.ancestors().nth(3).expect("cargo profile directory");
    let (library, installed) = if target.contains("windows") {
        ("xsh-rdp-native.dll", prefix.join("bin/xsh-rdp-native.dll"))
    } else if target.contains("apple") {
        (
            "libxsh-rdp-native.dylib",
            prefix.join("lib/libxsh-rdp-native.dylib"),
        )
    } else {
        (
            "libxsh-rdp-native.so",
            prefix.join("lib/libxsh-rdp-native.so"),
        )
    };
    for directory in [profile_dir.to_path_buf(), profile_dir.join("deps")] {
        std::fs::create_dir_all(&directory).unwrap();
        copy_if_changed(&installed, &directory.join(library));
    }
    println!("cargo:library={}", installed.display());
}

fn copy_if_changed(source: &Path, destination: &Path) {
    if std::fs::read(source).ok() != std::fs::read(destination).ok() {
        std::fs::copy(source, destination).expect("copy bundled RDP library");
    }
}
