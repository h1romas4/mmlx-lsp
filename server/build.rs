fn main() {
    println!("cargo:rerun-if-changed=locales");

    let target = std::env::var("TARGET").unwrap_or_default();
    if target != "wasm32-wasip1-threads" && target != "wasm32-wasip1" {
        return;
    }
    let sdk = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Cannot locate the project directory")
        .join("toolchains/wasi-sdk/build/install");
    let libraries = sdk.join(if target == "wasm32-wasip1-threads" {
        "share/wasi-sysroot/lib/wasm32-wasip1-threads"
    } else {
        "share/wasi-sysroot/lib/wasm32-wasi"
    });
    let compiler = format!("bin/clang++{}", std::env::consts::EXE_SUFFIX);
    for file in [
        sdk.join(&compiler),
        libraries.join("noeh/libc++.a"),
        libraries.join("noeh/libc++abi.a"),
    ] {
        println!("cargo:rerun-if-changed={}", file.display());
    }
    assert!(
        sdk.join(compiler).is_file()
            && libraries.join("noeh/libc++.a").is_file()
            && libraries.join("noeh/libc++abi.a").is_file(),
        "WASI SDK is missing or incomplete at {}. Build SDK 33 or extract its host release package into toolchains/wasi-sdk/build/install.",
        sdk.display()
    );

    for (binary, maximum) in [("mmlx-lsp-server", 134217728), ("mmlx-build", 1073741824)] {
        println!("cargo:rustc-link-arg-bin={binary}=--initial-memory=10485760");
        println!("cargo:rustc-link-arg-bin={binary}=--max-memory={maximum}");
    }
    if std::env::var_os("CARGO_FEATURE_EMULATION").is_some() {
        println!("cargo:rustc-link-search=native={}", libraries.display());
        println!(
            "cargo:rustc-link-search=native={}",
            libraries.join("noeh").display()
        );
        println!("cargo:rustc-link-lib=c++");
        println!("cargo:rustc-link-lib=c++abi");
        println!("cargo:rustc-link-arg-bin=mmlx-emulator=--initial-memory=10485760");
        println!("cargo:rustc-link-arg-bin=mmlx-emulator=--max-memory=134217728");
    }
}
