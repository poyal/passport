use passport_helper::update::{self, Result};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing {key}").into())
}
fn record(root: &Path, state: &str) -> Result<()> {
    // Append-only records survive termination during a write: recovery uses
    // the last complete JSON line, never a partially overwritten journal.
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(root.join("journal.jsonl"))?;
    writeln!(file, "{}", json!({"state": state}))?;
    file.sync_all()?;
    Ok(())
}
fn last_state(root: &Path) -> String {
    fs::read_to_string(root.join("journal.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v["state"].as_str().map(str::to_owned))
        .last()
        .unwrap_or_default()
}
fn alive(pid: u32) -> Result<bool> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, ms: u32) -> u32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
            fn GetLastError() -> u32;
        }
        unsafe {
            let handle = OpenProcess(0x00100000, 0, pid);
            if handle.is_null() {
                return if GetLastError() == 87 {
                    Ok(false)
                } else {
                    Err("Cannot inspect parent process".into())
                };
            }
            let status = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            match status {
                0 => Ok(false),
                258 => Ok(true),
                _ => Err("Cannot wait for parent".into()),
            }
        }
    }
    #[cfg(unix)]
    {
        let code = unsafe { libc::kill(pid as i32, 0) };
        if code == 0 {
            Ok(true)
        } else {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(e.into())
            }
        }
    }
}
fn rename(from: &Path, to: &Path) -> Result<()> {
    for attempt in 0..20 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt == 19 => return Err(e.into()),
            Err(_) => thread::sleep(Duration::from_millis(250)),
        }
    }
    unreachable!()
}
fn snapshot(data: &Path, root: &Path, restore: bool) -> Result<()> {
    let backup = root.join("databases");
    if !restore {
        fs::create_dir(&backup)?;
    }
    for name in ["passport.sqlite", "share.sqlite"] {
        for suffix in ["", "-wal", "-shm"] {
            let name = format!("{name}{suffix}");
            let actual = data.join(&name);
            let saved = backup.join(&name);
            if restore {
                if actual.exists() {
                    fs::remove_file(&actual)?;
                }
                if saved.exists() {
                    fs::copy(saved, actual)?;
                }
            } else if actual.exists() {
                fs::copy(actual, saved)?;
            }
        }
    }
    Ok(())
}
fn launch(target: &Path, root: &Path, token: &str, health: bool) -> Result<std::process::Child> {
    let exe = target.join(if cfg!(windows) {
        "Passport.exe"
    } else {
        "Contents/MacOS/Passport"
    });
    let mut command = Command::new(exe);
    let request: Value = serde_json::from_slice(&fs::read(root.join("request.json"))?)?;
    command.env("PASSPORT_DATA_DIR", text(&request, "data")?);
    command
        .current_dir(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if health {
        command
            .env("PASSPORT_UPDATE_TRANSACTION", root)
            .env("PASSPORT_UPDATE_TOKEN", token);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command.spawn()?)
}
fn run(root: &Path, recover: bool) -> Result<()> {
    let root = fs::canonicalize(root)?;
    let request: Value = serde_json::from_slice(&fs::read(root.join("request.json"))?)?;
    let target = PathBuf::from(text(&request, "target")?);
    let data = fs::canonicalize(text(&request, "data")?)?;
    if !target.is_absolute()
        || target.parent().is_none()
        || target.starts_with(&data)
        || data.starts_with(&target)
        || !root.starts_with(data.join("updates"))
    {
        return Err("Unsafe update paths".into());
    }
    // Older launchers and manual recovery can start us inside the install.
    // Windows keeps that directory open until we change our working directory.
    #[cfg(windows)]
    std::env::set_current_dir(&root)?;
    // Lock lives outside the replaced app; a second helper never performs a
    // concurrent replacement. A stale lock is retained for explicit recovery.
    if let Ok(lock_pid) = fs::read_to_string(root.join("lock")) {
        let lock_pid: u32 = lock_pid.parse()?;
        if alive(lock_pid)? {
            return Err("Another updater is active".into());
        }
        fs::remove_file(root.join("lock"))?;
    }
    let mut _lock = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("lock"))?;
    write!(_lock, "{}", std::process::id())?;
    _lock.sync_all()?;
    let result = (|| -> Result<()> {
        let pid = request["pid"]
            .as_u64()
            .and_then(|p| u32::try_from(p).ok())
            .ok_or("Invalid PID")?;
        let start = Instant::now();
        while alive(pid)? {
            if start.elapsed() > Duration::from_secs(120) {
                return Err("App did not exit".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
        let state = last_state(&root);
        if !state.is_empty() {
            if !recover {
                return Err("Existing transaction requires recovery before another update".into());
            }
            if state == "complete" || state == "rolled-back" {
                return Ok(());
            }
            if let Ok(child_pid) = fs::read_to_string(root.join("child.pid")) {
                if alive(child_pid.parse()?)? {
                    return Err("Updated application is still running".into());
                }
            }
            let id = root
                .file_name()
                .ok_or("Missing transaction id")?
                .to_string_lossy();
            if !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
                return Err("Invalid transaction id".into());
            }
            let parent = target.parent().ok_or("Missing parent")?;
            let backup = parent.join(format!(".passport-backup-{id}"));
            let failed = parent.join(format!(".passport-failed-{id}"));
            if fs::read_to_string(root.join("healthy"))
                .is_ok_and(|value| Some(value.as_str()) == request["token"].as_str())
                && target.is_dir()
            {
                record(&root, "complete")?;
                if backup.is_dir() {
                    fs::remove_dir_all(backup)?;
                }
                return Ok(());
            }
            if backup.is_dir() {
                if target.exists() {
                    rename(&target, &failed)?;
                }
                rename(&backup, &target)?;
                snapshot(&data, &root, true)?;
                record(&root, "rolled-back")?;
                launch(&target, &root, text(&request, "token")?, false)?;
                if failed.exists() {
                    fs::remove_dir_all(failed)?;
                }
            } else if state == "prepared" && target.is_dir() {
                record(&root, "rolled-back")?;
            } else {
                return Err("Recovery backup is missing; no files were removed".into());
            }
            return Ok(());
        }
        let current = text(&request, "current")?;
        let next = text(&request, "version")?;
        // Public key is compiled into the helper, never accepted from request.json.
        let key = option_env!("PASSPORT_UPDATE_PUBLIC_KEY").unwrap_or("");
        let manifest = update::manifest(
            &fs::read(root.join("update.json"))?,
            &fs::read(root.join("update.sig"))?,
            key,
            current,
            next,
        )?;
        let platform = if cfg!(windows) {
            "win32-x64"
        } else {
            "darwin-arm64"
        };
        let asset = &manifest["platforms"][platform];
        if text(asset, "name")? != format!("Passport-{next}-{platform}-update.zip") {
            return Err("Invalid package name".into());
        }
        update::package(
            &root.join("package.zip"),
            asset["size"].as_u64().ok_or("Invalid size")?,
            text(asset, "sha256")?,
        )?;
        let parent = target.parent().ok_or("Missing parent")?;
        let id = root
            .file_name()
            .ok_or("Missing transaction id")?
            .to_string_lossy();
        if !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
            return Err("Invalid transaction id".into());
        }
        let stage = parent.join(format!(".passport-stage-{id}"));
        let backup = parent.join(format!(".passport-backup-{id}"));
        if backup.exists() {
            return Err("Backup already exists".into());
        }
        update::extract(&root.join("package.zip"), &stage)?;
        let executable = stage.join(if cfg!(windows) {
            "Passport.exe"
        } else {
            "Contents/MacOS/Passport"
        });
        if !executable.is_file() {
            return Err("Incomplete update".into());
        }
        #[cfg(unix)]
        {
            if !Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&stage)
                .status()?
                .success()
            {
                return Err("Invalid app signature".into());
            }
        }
        // NSIS removal entries live alongside the app. Preserve only these
        // installer-owned files; never copy old application DLLs into the update.
        if cfg!(windows) {
            for entry in fs::read_dir(&target)? {
                let e = entry?;
                let name = e.file_name();
                let lower = name.to_string_lossy().to_lowercase();
                if lower.starts_with("uninstall")
                    && lower.ends_with(".exe")
                    && e.file_type()?.is_file()
                {
                    if stage.join(&name).exists() {
                        return Err("Update must not replace uninstaller".into());
                    }
                    fs::copy(e.path(), stage.join(name))?;
                }
            }
        }
        snapshot(&data, &root, false)?;
        record(&root, "prepared")?;
        rename(&target, &backup)?;
        record(&root, "backed-up")?;
        if let Err(error) = rename(&stage, &target) {
            rename(&backup, &target)?;
            record(&root, "rolled-back")?;
            return Err(error);
        }
        record(&root, "installed")?;
        let token = text(&request, "token")?;
        let launch_result = launch(&target, &root, token, true);
        let mut child = match launch_result {
            Ok(c) => Some(c),
            Err(_) => None,
        };
        if let Some(child) = child.as_ref() {
            fs::write(root.join("child.pid"), child.id().to_string())?;
        }
        let mut healthy = false;
        if let Some(child) = child.as_mut() {
            loop {
                if fs::read_to_string(root.join("healthy")).is_ok_and(|s| s == token) {
                    healthy = true;
                    break;
                }
                if child.try_wait()?.is_some() {
                    break;
                }
                // Do not kill an app waiting for a Keychain prompt. Keep its backup
                // until the app reports readiness or exits.
                thread::sleep(Duration::from_millis(250));
            }
        }
        if healthy {
            record(&root, "complete")?;
            fs::remove_dir_all(&backup)?;
        } else {
            // The child is confirmed stopped, so restoring databases cannot
            // overwrite writes from a live application.
            rename(&target, &stage)?;
            rename(&backup, &target)?;
            snapshot(&data, &root, true)?;
            record(&root, "rolled-back")?;
            launch(&target, &root, token, false)?;
            fs::remove_dir_all(&stage)?;
        }
        Ok(())
    })();
    drop(_lock);
    let _ = fs::remove_file(root.join("lock"));
    if let Err(ref error) = result {
        let _ = fs::write(root.join("error.txt"), error.to_string());
        if last_state(&root).is_empty() && target.is_dir() {
            if let Some(pid) = request["pid"].as_u64().and_then(|p| u32::try_from(p).ok()) {
                if matches!(alive(pid), Ok(false)) {
                    let _ = launch(&target, &root, "", false);
                }
            }
        }
    }
    result
}
fn main() {
    let recover = std::env::args().any(|a| a == "--recover");
    let result = std::env::args_os()
        .nth(1)
        .ok_or("Missing transaction directory".into())
        .and_then(|p| run(Path::new(&p), recover));
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
