use serde_json::{Value, json};
use std::{
    env, fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

const LIMIT: u64 = 262_144;
const DEADLINE: Duration = Duration::from_millis(500);

fn transmit(payload: Value) {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let send = || -> std::io::Result<()> {
            let endpoint = env::var("PASSPORT_ENDPOINT").unwrap_or_default();
            if endpoint.is_empty() {
                return Ok(());
            }
            let mut message = payload;
            message["token"] = env::var("PASSPORT_TOKEN").unwrap_or_default().into();
            message["generation"] = env::var("PASSPORT_GENERATION").unwrap_or_default().into();
            message["run"] = env::var("PASSPORT_AGENT_RUN").unwrap_or_default().into();
            let mut bytes = serde_json::to_vec(&message)?;
            if bytes.len() > 16_384 {
                return Ok(());
            }
            bytes.push(b'\n');
            #[cfg(unix)]
            {
                let mut pipe = std::os::unix::net::UnixStream::connect(endpoint)?;
                pipe.set_write_timeout(Some(DEADLINE))?;
                pipe.write_all(&bytes)?;
                pipe.set_read_timeout(Some(DEADLINE))?;
                let mut ack = [0_u8; 1];
                pipe.read_exact(&mut ack)?;
            }
            #[cfg(windows)]
            {
                let mut pipe = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(endpoint)?;
                pipe.write_all(&bytes)?;
                let mut ack = [0_u8; 1];
                pipe.read_exact(&mut ack)?;
            }
            Ok(())
        };
        let _ = send();
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(DEADLINE);
}
fn event(source: &str, kind: &str, payload: &Value) -> Value {
    // Forward only identifiers and a bounded completion excerpt. The main
    // process enforces the current opt-in before displaying or persisting it.
    let mut message = json!({"source":source,"event":kind,"session":payload.get("session_id").or(payload.get("thread-id")).and_then(Value::as_str).unwrap_or(""),"turn":payload.get("turn-id").and_then(Value::as_str).unwrap_or(""),"request":payload.get("tool_use_id").or(payload.get("elicitation_id")).and_then(Value::as_str).unwrap_or("")});
    if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
        if cwd.len() <= 4096 { message["cwd"] = cwd.into(); }
    }
    if let Some(source) = payload.get("source").and_then(Value::as_str) {
        if matches!(source, "startup" | "resume" | "clear" | "compact") {
            message["sessionSource"] = source.into();
        }
    }
    if let Some(transcript) = payload.get("transcript_path").and_then(Value::as_str) {
        if transcript.len() <= 4096 { message["transcript"] = transcript.into(); }
    }
    if matches!(kind, "completed" | "stop-candidate") {
        if let Some(text) = payload.get("last_assistant_message").or(payload.get("last-assistant-message")).and_then(Value::as_str) {
            message["summary"] = text.chars().take(200).collect::<String>().into();
        }
    }
    message
}
fn hook_kind(payload: &Value, codex: bool) -> Option<&str> {
    let kind = payload[if codex { "type" } else { "hook_event_name" }].as_str()?;
    // Subagent completions aren't the user's turn. Background input requests
    // explicitly forwarded by Notification still need attention.
    if payload.get("agent_id").is_some() && kind != "Notification" { return None; }
    Some(match kind {
        "SessionStart" => "session-start",
        "agent-turn-complete" => "completed",
        "Stop" => "stop-candidate",
        "PermissionRequest" => "permission-candidate",
        "PreToolUse" => match payload["tool_name"].as_str().unwrap_or("") {
            "AskUserQuestion" | "ExitPlanMode" => "input-candidate",
            _ => "tool-start",
        },
        "Elicitation" => "input-candidate",
        "ElicitationResult" => "input-resolved",
        "Notification" => match payload["notification_type"].as_str().unwrap_or("") {
            "permission_prompt" => "permission",
            "elicitation_dialog" | "elicitation_url_dialog" | "agent_needs_input" => "input-required",
            "elicitation_response" | "elicitation_complete" => "input-resolved",
            "quota_auto_resume_stale" | "quota_auto_resume_disabled" => "attention",
            _ => return None,
        },
        "UserPromptSubmit" => "turn-start",
        "PostToolUse" | "PostToolUseFailure" => "tool-done",
        "StopFailure" => "turn-failed",
        "SessionEnd" => "session-end",
        _ => return None,
    })
}

fn hook(mode: &str, args: &[String]) {
    let payload: Value = if mode == "codex-notify" {
        let raw = args.first().map(String::as_str).unwrap_or("");
        if raw.len() > LIMIT as usize {
            return;
        }
        serde_json::from_str(raw).unwrap_or(Value::Null)
    } else {
        let mut raw = Vec::new();
        if std::io::stdin()
            .take(LIMIT + 1)
            .read_to_end(&mut raw)
            .is_err()
            || raw.len() > LIMIT as usize
        {
            return;
        }
        serde_json::from_slice(&raw).unwrap_or(Value::Null)
    };
    if !payload.is_object() {
        return;
    }
    let Some(normalized) = hook_kind(&payload, mode == "codex-notify") else { return; };
    transmit(event(
        if mode == "codex-notify" || mode == "codex-hook" {
            "codex"
        } else {
            "claude"
        },
        normalized,
        &payload,
    ));
}
fn executable(name: &str) -> Option<PathBuf> {
    let suffixes = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat", ""]
    } else {
        vec![""]
    };
    for dir in env::split_paths(&env::var_os("PATH").unwrap_or_default()) {
        for suffix in &suffixes {
            let file = dir.join(format!("{name}{suffix}"));
            if file.is_file() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if fs::metadata(&file).is_ok_and(|m| m.permissions().mode() & 0o111 == 0) {
                        continue;
                    }
                }
                return Some(file);
            }
        }
    }
    None
}
fn has_key(value: &toml::Value, key: &str) -> bool {
    match value {
        toml::Value::Table(table) => {
            table.contains_key(key) || table.values().any(|v| has_key(v, key))
        }
        toml::Value::Array(items) => items.iter().any(|v| has_key(v, key)),
        _ => false,
    }
}
fn has_tui_key(value: &toml::Value, key: &str) -> bool {
    match value {
        toml::Value::Table(table) => {
            table.get("tui").and_then(|tui| tui.get(key)).is_some()
                || table.values().any(|value| has_tui_key(value, key))
        }
        toml::Value::Array(items) => items.iter().any(|value| has_tui_key(value, key)),
        _ => false,
    }
}
const TUI_NOTIFICATION_KEYS: [&str; 3] = [
    "notifications",
    "notification_method",
    "notification_condition",
];
fn probe(executable: &PathBuf, argument: &str, limit: u64) -> Option<String> {
    let Ok(mut child) = Command::new(executable)
        .arg(argument)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return None;
    };
    let output = child.stdout.take();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(output) = output {
            let _ = output.take(limit).read_to_end(&mut bytes);
        }
        let _ = tx.send(bytes);
    });
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(50)) {
                        return Some(String::from_utf8_lossy(&bytes).into_owned());
                    }
                }
                return None;
            }
            Err(_) => return None,
            _ => {}
        }
        if start.elapsed() > Duration::from_secs(1) {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn codex_interactive(args: &[String]) -> bool {
    if args.iter().any(|a| matches!(a.as_str(), "--remote" | "--help" | "-h" | "--version" | "-V")
        || a.starts_with("--remote=")) { return false; }
    let mut values = false;
    for arg in args {
        if values { values = false; continue; }
        if matches!(arg.as_str(), "-c" | "--config" | "-p" | "--profile" | "-m" | "--model"
            | "-a" | "--ask-for-approval" | "-s" | "--sandbox" | "-C" | "--cd"
            | "--enable" | "--disable" | "--local-provider" | "--add-dir" | "-i" | "--image") {
            values = true;
        } else if arg == "--" { return true; }
        else if !arg.starts_with('-') {
            return !matches!(arg.as_str(), "exec" | "e" | "review" | "login" | "logout" | "mcp"
                | "plugin" | "app-server" | "remote-control" | "app" | "completion" | "update"
                | "doctor" | "sandbox" | "debug" | "apply" | "a" | "cloud" | "exec-server"
                | "features" | "help" | "agents" | "queue" | "archive" | "delete"
                | "migrate-rollouts" | "unarchive" | "fork");
        }
    }
    true
}
fn codex_overrides(args: &[String]) -> (bool, [bool; 3]) {
    let mut notify = false;
    let mut tui = [false; 3];
    // An explicit configuration/profile selection always takes precedence.
    if args.iter().any(|a| {
        matches!(
            a.as_str(),
            "-p" | "--profile" | "-c" | "--config" | "-C" | "--cd" | "--remote"
        ) || a.starts_with("--config=")
            || a.starts_with("--profile=")
            || a.starts_with("--cd=")
            || a.starts_with("--remote=")
            || a.starts_with("-c")
            || a.starts_with("-p")
            || a.starts_with("-C")
    }) {
        return (false, [false; 3]);
    }
    let home = env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| {
        env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|p| PathBuf::from(p).join(".codex"))
    });
    let mut files = Vec::new();
    if cfg!(unix) {
        files.push(PathBuf::from("/etc/codex/config.toml"));
    }
    if let Some(program_data) = env::var_os("ProgramData") {
        files.push(PathBuf::from(program_data).join("OpenAI/Codex/config.toml"));
    }
    if let Some(home) = home {
        files.push(home.join("config.toml"));
    }
    if let Ok(cwd) = env::current_dir() {
        for parent in cwd.ancestors() {
            files.push(parent.join(".codex/config.toml"));
        }
    }
    for file in files {
        if !file.exists() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(file) else {
            return (false, [false; 3]);
        };
        let Ok(config) = raw.parse::<toml::Table>() else {
            return (false, [false; 3]);
        };
        let config = toml::Value::Table(config);
        notify |= has_key(&config, "notify");
        for (index, key) in TUI_NOTIFICATION_KEYS.iter().enumerate() {
            tui[index] |= has_tui_key(&config, key);
        }
    }
    (!notify, tui.map(|present| !present))
}
fn run(agent: &str, args: &[String]) -> i32 {
    if agent != "claude" && agent != "codex" {
        return 2;
    }
    let Some(executable) = executable(agent) else {
        eprintln!(
            "Passport: {agent} 실행 파일을 찾지 못했습니다. 이 셸에서 CLI 설치와 PATH를 확인하세요."
        );
        return 127;
    };
    let info = format!(
        "{agent}: {} · {}",
        executable.display(),
        probe(&executable, "--version", 1024).unwrap_or_else(|| "버전 확인 불가".into())
            .chars().filter(|c| !c.is_control()).take(128).collect::<String>()
    );
    transmit(
        json!({"source":"terminal","event":"profile-result","detail":info.chars().take(4096).collect::<String>()}),
    );
    let mut cli_args = Vec::new();
    let helper = env::current_exe().unwrap_or_default();
    if agent == "codex" && env::var("PASSPORT_RESUME").as_deref() == Ok("1")
        && codex_interactive(args) && !args.iter().any(|a| a == "--no-daemon")
        && probe(&executable, "--help", 16384).is_some_and(|text| text.contains("--no-daemon")) {
        // A shared server outlives the PTY and retains another client's hook
        // environment. Keep the authenticated run binding owned by this CLI.
        cli_args.push("--no-daemon".into());
    }
    if agent == "claude" && env::var("PASSPORT_CLAUDE").as_deref() == Ok("1") {
        if args
            .iter()
            .any(|a| a == "--settings" || a.starts_with("--settings="))
        {
            eprintln!(
                "Passport: 명시한 Claude --settings를 보존합니다. 앱 알림 연동을 생략합니다."
            );
        } else if let Ok(settings) = env::var("PASSPORT_CLAUDE_SETTINGS") {
            cli_args.extend(["--settings".into(), settings]);
        }
    }
    if agent == "codex" && env::var("PASSPORT_CODEX").as_deref() == Ok("1") {
        let (notify, tui) = codex_overrides(args);
        if notify {
            cli_args.extend([
                "-c".into(),
                format!(
                    "notify={}",
                    json!([helper.to_string_lossy(), "codex-notify"])
                ),
            ]);
        } else {
            eprintln!(
                "Passport: 기존 Codex notify/config 설정을 유지합니다. 완료 알림 연동이 생략될 수 있습니다."
            );
        }
        if tui.iter().any(|enabled| !enabled) {
            eprintln!(
                "Passport: 기존 Codex TUI 알림 설정을 유지합니다. 승인·질문 알림이 일부 생략될 수 있습니다."
            );
        }
        for (enabled, setting) in tui.into_iter().zip([
            "tui.notifications=[\"approval-requested\",\"plan-mode-prompt\",\"async-question\"]",
            "tui.notification_method=\"osc9\"",
            "tui.notification_condition=\"always\"",
        ]) {
            if enabled {
                cli_args.extend(["-c".into(), setting.into()]);
            }
        }
    }
    if agent == "codex" && env::var("PASSPORT_RESUME").as_deref() == Ok("1") {
        // A separate inline source merges with file hooks. Keep the command
        // stable so normal /hooks trust survives a new terminal generation.
        let conflict = args.iter().any(|a| a.contains("hooks.") || a.starts_with("hooks="));
        if !conflict {
            let command = if cfg!(windows) {
                format!("\"{}\" codex-hook", helper.to_string_lossy())
            } else {
                format!("'{}' codex-hook", helper.to_string_lossy().replace('\'', "'\"'\"'"))
            };
            for name in ["SessionStart", "UserPromptSubmit"] {
                cli_args.extend(["-c".into(), format!("hooks.{name}=[{{hooks=[{{type=\"command\",command={}}}]}}]", json!(command))]);
            }
        }
    }
    cli_args.extend_from_slice(args);
    // Never invoke arbitrary shell text. Windows npm launchers use cmd's native
    // argument escaping provided by std::process for .cmd/.bat executables.
    let mut command = Command::new(executable);
    command
        .args(cli_args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let run = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    command.env("PASSPORT_AGENT_RUN", &run);
    // Child hooks receive the run ID. The parent includes it explicitly below.
    let mut start = event(agent, "run-start", &Value::Null);
    start["agentRun"] = run.clone().into();
    if env::var("PASSPORT_RESUME").as_deref() == Ok("1") {
        start["cwd"] = env::current_dir().unwrap_or_default().to_string_lossy().into_owned().into();
        let home = env::var(if agent == "codex" { "CODEX_HOME" } else { "CLAUDE_CONFIG_DIR" }).unwrap_or_default();
        start["home"] = home.into();
        if args.len() <= 128 && serde_json::to_vec(args).is_ok_and(|v| v.len() <= 8192) { start["args"] = json!(args); }
    }
    transmit(start);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        command.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            Ok(())
        });
    }
    #[cfg(windows)]
    unsafe {
        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn SetConsoleCtrlHandler(
                handler: Option<unsafe extern "system" fn(u32) -> i32>,
                add: i32,
            ) -> i32;
        }
        unsafe extern "system" fn ignore_interrupt(kind: u32) -> i32 {
            if kind == 0 || kind == 1 { 1 } else { 0 }
        }
        SetConsoleCtrlHandler(Some(ignore_interrupt), 1);
    }
    let code = match command.status() {
        Ok(status) => status.code().unwrap_or(130),
        Err(error) => {
            eprintln!("Passport: {agent}: {error}");
            126
        }
    };
    let mut end = event(agent, "run-end", &Value::Null);
    end["agentRun"] = run.into();
    end["exitCode"] = code.into();
    transmit(end);
    code
}
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("");
    if mode == "path-contains" {
        let needle = args.get(1).map(String::as_str).unwrap_or("");
        let exists = env::split_paths(&env::var_os("PATH").unwrap_or_default())
            .any(|p| p.to_string_lossy().eq_ignore_ascii_case(needle));
        std::process::exit(if exists { 0 } else { 1 });
    }
    if mode == "macro" {
        #[cfg(windows)]
        if args.len() >= 4 {
            let name = &args[1];
            if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return;
            }
            if args[3] != "1" {
                if [
                    "cd", "chdir", "dir", "echo", "set", "path", "prompt", "type", "copy", "move",
                    "del", "erase", "exit", "if", "for", "call", "start", "cls", "md", "rd",
                    "mkdir", "rmdir", "ren", "rename", "pushd", "popd", "shift", "date", "time",
                    "ver", "vol", "color", "title",
                ]
                .contains(&name.to_ascii_lowercase().as_str())
                {
                    transmit(
                        json!({"source":"terminal","event":"profile-result","detail":format!("{name}: 기존 cmd 명령 유지")}),
                    );
                    return;
                }
                let existing = Command::new("doskey.exe")
                    .args(["/macros", "/exename=cmd.exe"])
                    .output()
                    .ok();
                let prefix = format!("{name}=");
                if existing.is_some_and(|o| {
                    String::from_utf8_lossy(&o.stdout).lines().any(|line| {
                        line.to_ascii_lowercase()
                            .starts_with(&prefix.to_ascii_lowercase())
                    })
                }) || Command::new("where.exe")
                    .arg(name)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success())
                {
                    transmit(
                        json!({"source":"terminal","event":"profile-result","detail":format!("{name}: 기존 명령 유지")}),
                    );
                    return;
                }
            }
            let quote = |v: &str| format!("\"{}\"", v.replace('"', "").replace('$', "$$"));
            let executable = if args[2]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            {
                args[2].clone()
            } else {
                quote(&args[2])
            };
            let value = std::iter::once(executable)
                .chain(args[4..].iter().map(|v| quote(v)))
                .collect::<Vec<_>>()
                .join(" ");
            // DOSKEY reads its own command line; CRT argv quoting would become
            // part of the macro name and backslash-escape the target's quotes.
            use std::os::windows::process::CommandExt;
            let applied = Command::new("doskey.exe")
                .arg("/exename=cmd.exe")
                .raw_arg(format!("{name}={value} $*"))
                .status()
                .is_ok_and(|s| s.success());
            transmit(
                json!({"source":"terminal","event":"profile-result","detail":format!("{name}: {} (cmd 대화형 매크로)", if applied { "적용" } else { "실패" })}),
            );
        }
        return;
    }
    if mode == "cwd" {
        transmit(json!({"source":"terminal","event":"cwd","cwd":env::current_dir().unwrap_or_default().to_string_lossy()}));
        return;
    }
    if mode == "resume" {
        let result = (|| -> Option<i32> {
            let file = env::var("PASSPORT_AGENT_RESUME").ok()?;
            let bytes = fs::read(file).ok()?;
            if bytes.len() > 16384 { return None; }
            let value: Value = serde_json::from_slice(&bytes).ok()?;
            let agent = value["agent"].as_str()?;
            if agent != "codex" && agent != "claude" { return None; }
            let current_home = env::var(if agent == "codex" { "CODEX_HOME" } else { "CLAUDE_CONFIG_DIR" }).unwrap_or_default();
            if value["home"].as_str().unwrap_or("") != current_home { return None; }
            env::set_current_dir(value["cwd"].as_str()?).ok()?;
            let arguments: Vec<String> = value["args"].as_array()?.iter().map(|v| v.as_str().map(String::from)).collect::<Option<_>>()?;
            Some(run(agent, &arguments))
        })();
        match result {
            Some(code) => std::process::exit(code),
            None => { eprintln!("Passport: AI 작업 폴더·대화 저장 위치·실행 옵션을 확인하지 못해 자동 재개를 생략했습니다."); std::process::exit(1); }
        }
    }
    if mode == "run" {
        std::process::exit(run(
            args.get(1).map(String::as_str).unwrap_or(""),
            args.get(2..).unwrap_or(&[]),
        ));
    }
    if mode == "ready" {
        transmit(json!({"source":"terminal","event":"ready"}));
        return;
    }
    if mode == "result" {
        transmit(
            json!({"source":"terminal","event":"profile-result","detail":args.get(1).map(String::as_str).unwrap_or("")}),
        );
        return;
    }
    // One deadline covers input + parse + transport, including an unclosed stdin.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        if let Some(mode) = args.first() {
            hook(mode, &args[1..]);
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(DEADLINE);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn standalone_codex_only_for_local_interactive_clients() {
        let interactive = |args: &[&str]| codex_interactive(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(interactive(&[]));
        assert!(interactive(&["-a", "never", "-s", "danger-full-access", "resume", "session-id"]));
        assert!(interactive(&["--model", "exec", "a normal prompt"]));
        assert!(!interactive(&["exec", "hello"]));
        assert!(!interactive(&["-c", "model='fixture'", "agents"]));
        assert!(!interactive(&["--remote=localhost:9000"]));
        assert!(!interactive(&["--remote", "localhost:9000", "resume"]));
        assert!(!interactive(&["--help"]));
    }
    #[test]
    fn resume_hooks_forward_only_bounded_native_metadata() {
        let value = event("claude", "session-start", &json!({
            "session_id":"test-id", "source":"startup",
            "transcript_path":"/tmp/conversation.jsonl", "prompt":"private"
        }));
        assert_eq!(value["sessionSource"], "startup");
        assert_eq!(value["transcript"], "/tmp/conversation.jsonl");
        assert!(value.get("prompt").is_none());
        let oversized = event("codex", "session-start", &json!({
            "source":"other", "transcript_path":"x".repeat(4097)
        }));
        assert!(oversized.get("sessionSource").is_none());
        assert!(oversized.get("transcript").is_none());
    }
    #[test]
    fn unrelated_tui_preferences_do_not_disable_notifications() {
        let config: toml::Value =
            toml::from_str("[tui]\nstatus_line=['model-name']\nstatus_line_use_colors=true\n")
                .unwrap();
        for key in TUI_NOTIFICATION_KEYS {
            assert!(!has_tui_key(&config, key));
        }
        let explicit: toml::Value =
            toml::from_str("[tui]\nnotifications=false\nnotification_method='bel'\n").unwrap();
        assert!(has_tui_key(&explicit, "notifications"));
        assert!(has_tui_key(&explicit, "notification_method"));
        assert!(!has_tui_key(&explicit, "notification_condition"));
    }
    #[test]
    fn actionable_hooks_and_bounded_excerpts() {
        for kind in ["idle_prompt", "auth_success", "agent_completed", "quota_auto_resume_fired"] {
            assert_eq!(hook_kind(&json!({"hook_event_name":"Notification","notification_type":kind}), false), None);
        }
        assert_eq!(hook_kind(&json!({"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}), false), Some("input-candidate"));
        assert_eq!(hook_kind(&json!({"hook_event_name":"Notification","notification_type":"agent_needs_input","agent_id":"background"}), false), Some("input-required"));
        assert_eq!(hook_kind(&json!({"hook_event_name":"Stop","agent_id":"child"}), false), None);
        let excerpt = event("codex", "completed", &json!({"last-assistant-message":"한".repeat(300),"input-messages":["private"]}));
        assert_eq!(excerpt["summary"].as_str().unwrap().chars().count(), 200);
        assert!(!excerpt.to_string().contains("private"));
        assert!(event("claude", "permission", &json!({"last_assistant_message":"private"})).get("summary").is_none());
    }
    #[test]
    fn event_does_not_copy_secrets() {
        let event = event(
            "claude",
            "permission",
            &json!({"session_id":"s","tool_input":{"secret":"do-not-send"},"message":"private"}),
        );
        assert!(!event.to_string().contains("private"));
        assert!(!event.to_string().contains("do-not-send"));
    }
}
