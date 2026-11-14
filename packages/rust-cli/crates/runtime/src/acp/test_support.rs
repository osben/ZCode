//! Test helpers shared by the ACP unit tests.
#![allow(
    clippy::disallowed_methods,
    reason = "tests build the mock agent with cargo"
)]

use std::path::{Path, PathBuf};

/// The mock agent of `rust-cli-acp`, built once per test process (a no-op when it is current).
pub(crate) fn mock_agent() -> PathBuf {
    static BUILT: std::sync::Once = std::sync::Once::new();
    let exe = std::env::current_exe().expect("test binary");
    // target/<profile>/deps/<test> → target/<profile>/acp-mock-agent
    let dir = exe.parent().and_then(Path::parent).expect("target dir");
    let path = dir.join(format!("acp-mock-agent{}", std::env::consts::EXE_SUFFIX));
    // The directory is the profile's (`debug` for dev), so a `--release` or custom-profile run builds where it reads.
    let profile = match dir.file_name().and_then(|name| name.to_str()) {
        Some("debug") | None => Vec::new(),
        Some(profile) => vec!["--profile".to_owned(), profile.to_owned()],
    };
    BUILT.call_once(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
        let status = std::process::Command::new(cargo)
            .args(["build", "-p", "rust-cli-acp", "--bin", "acp-mock-agent"])
            .args(&profile)
            .status()
            .expect("cargo");
        assert!(status.success(), "building acp-mock-agent failed");
    });
    assert!(path.exists(), "{} is missing", path.display());
    path
}
