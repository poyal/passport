// Isolated native process fixture; not a Passport or OS permission test.
use std::{env, fs, path::PathBuf};
fn main() {
    let Ok(root) = env::var("PASSPORT_UPDATE_TRANSACTION") else {
        return;
    };
    let root = PathBuf::from(root);
    let data = PathBuf::from(env::var("PASSPORT_DATA_DIR").unwrap());
    fs::write(data.join("passport.sqlite"), b"new-database").unwrap();
    let exe = env::current_exe().unwrap();
    let marker = if cfg!(target_os = "macos") {
        exe.parent().unwrap().join("../Resources/fail-startup")
    } else {
        exe.parent().unwrap().join("fail-startup")
    };
    if marker.exists() {
        std::process::exit(2);
    }
    fs::write(
        root.join("healthy"),
        env::var("PASSPORT_UPDATE_TOKEN").unwrap(),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(500));
}
