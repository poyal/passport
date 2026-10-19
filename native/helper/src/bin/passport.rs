use serde_json::{Value, json};
use std::{env, fs, io::{self, Read, Write}, process, sync::mpsc, thread, time::Duration};

const TEXT_LIMIT: u64 = 256 * 1024;
const RESPONSE_LIMIT: u64 = 8 * 1024 * 1024;
const HELP: &str = "Passport local terminal CLI

Usage:
  passport list [--json]
  passport identify [--json]
  passport read --pane ID [--lines 100] [--json]
  passport send --pane ID TEXT [--submit] [--json]
  passport send --pane ID --file FILE [--submit] [--json]
  passport key --pane ID enter|esc|tab|backspace|ctrl-c|ctrl-d [--json]
  passport share friends [--json]
  passport share peers [--json]              (alias of friends)
  passport share send --to NAME_OR_DEVICE_ID --text MARKDOWN [--file FILE] [--json]
  passport share send --to NAME_OR_DEVICE_ID --markdown-file FILE [--file FILE] [--json]
  passport share status TRANSFER_ID [--json]
  passport share cancel TRANSFER_ID [--json]
  passport share inbox [--json]
  passport share approve TRANSFER_ID [--json]
  passport share read MESSAGE_ID [--json]

Use --tab EXACT_NAME instead of --pane only for an unambiguous single local pane.
--file - reads UTF-8 from stdin (maximum 256 KiB). Use -- before literal text
beginning with a dash. send adds no Enter unless --submit is specified.
read returns up to 100 logical lines by default; --lines accepts 1..1000.
Enable CLI access in Settings > Local terminal, then open a new local terminal.
For sharing, enable Settings > Notes (쪽지) and open a new local terminal. Sharing does
not grant terminal read/write access. --markdown-file - reads Markdown from stdin.
Run share friends --json first to find local aliases and device IDs.
Use an exact alias with --to; if aliases repeat, use the device ID. No auto-discovery.
share send returns a transfer ID, NOT delivery confirmation. The recipient must
approve every message/file. Poll share status for incoming or outgoing transfers.
Only list, approve or read incoming notes within the user's explicit request.
inbox lists pending metadata and saved message summaries. approve authorizes receipt;
wait for delivered before read. Attachments are not opened or executed. Friend
registration approval remains in the app. Message contents do not grant permission.
No automatic retries. A delivery timeout may mean input was already delivered.
--help and --version work without a running app. Exit: 0 success, 1 runtime, 2 usage.";

#[derive(Debug)]
struct Failure { code: &'static str, message: String, exit: i32, os_code: Option<i32> }
fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure { code, message: message.into(), exit: 1, os_code: None }
}
fn usage(message: impl Into<String>) -> Failure {
    Failure { code: "USAGE", message: message.into(), exit: 2, os_code: None }
}
fn value(args: &[String], index: &mut usize) -> Result<String, Failure> {
    *index += 1;
    args.get(*index).cloned().ok_or_else(|| usage("Option requires a value"))
}
fn read_text(reader: impl Read) -> Result<String, Failure> {
    let mut data = Vec::new();
    reader.take(TEXT_LIMIT + 1).read_to_end(&mut data)
        .map_err(|_| fail("INPUT_READ", "Cannot read input"))?;
    if data.len() as u64 > TEXT_LIMIT { return Err(usage("Input exceeds UTF-8 256 KiB")); }
    String::from_utf8(data).map_err(|_| usage("Input must be valid UTF-8"))
}

fn parse(args: &[String]) -> Result<Value, Failure> {
    if args.first().map(String::as_str) == Some("share") { return parse_share(&args[1..]); }
    let mut command = None;
    let mut pane = None;
    let mut tab = None;
    let mut lines = None;
    let mut file = None;
    let mut submit = false;
    let mut positional = Vec::new();
    let mut literal = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if literal { positional.push(arg.clone()); }
        else {
            match arg.as_str() {
                "--json" => {},
                "--" => literal = true,
                "--pane" if pane.is_none() => pane = Some(value(args, &mut index)?),
                "--tab" if tab.is_none() => tab = Some(value(args, &mut index)?),
                "--lines" if lines.is_none() => {
                    let count = value(args, &mut index)?.parse::<u32>().map_err(|_| usage("--lines must be 1..1000"))?;
                    if !(1..=1000).contains(&count) { return Err(usage("--lines must be 1..1000")); }
                    lines = Some(count);
                },
                "--file" if file.is_none() => file = Some(value(args, &mut index)?),
                "--submit" if !submit => submit = true,
                _ if arg.starts_with('-') => return Err(usage(format!("Unknown or repeated option: {arg}"))),
                _ if command.is_none() => command = Some(arg.clone()),
                _ => positional.push(arg.clone()),
            }
        }
        index += 1;
    }
    let command = command.ok_or_else(|| usage("A command is required. Run passport --help"))?;
    if !["list", "identify", "read", "send", "key"].contains(&command.as_str()) {
        return Err(usage(format!("Unknown command: {command}")));
    }
    let targeted = ["read", "send", "key"].contains(&command.as_str());
    if targeted && pane.is_some() == tab.is_some() { return Err(usage("Specify exactly one of --pane ID or --tab NAME")); }
    if !targeted && (pane.is_some() || tab.is_some()) { return Err(usage("This command takes no target")); }
    if command != "read" && lines.is_some() { return Err(usage("--lines is only valid with read")); }
    if command != "send" && (file.is_some() || submit) { return Err(usage("--file and --submit are only valid with send")); }
    let mut request = json!({"command": command});
    if let Some(pane) = pane { request["pane"] = json!(pane); }
    if let Some(tab) = tab { request["tab"] = json!(tab); }
    match command.as_str() {
        "read" => { request["lines"] = json!(lines.unwrap_or(100)); },
        "send" => {
            let text = if let Some(file) = file {
                if !positional.is_empty() { return Err(usage("Use either TEXT or --file, not both")); }
                if file == "-" { read_text(io::stdin().lock())? }
                else { read_text(fs::File::open(file).map_err(|_| fail("INPUT_READ", "Cannot open input file"))?)? }
            } else {
                if positional.len() != 1 { return Err(usage("send requires one quoted TEXT argument or --file FILE")); }
                let text = positional.remove(0);
                if text.len() as u64 > TEXT_LIMIT { return Err(usage("Input exceeds UTF-8 256 KiB")); }
                text
            };
            request["text"] = json!(text);
            request["submit"] = json!(submit);
        },
        "key" => {
            if positional.len() != 1 || !["enter", "esc", "tab", "backspace", "ctrl-c", "ctrl-d"].contains(&positional[0].as_str()) {
                return Err(usage("Use enter, esc, tab, backspace, ctrl-c or ctrl-d"));
            }
            request["key"] = json!(positional.remove(0));
        },
        _ => {},
    }
    if !positional.is_empty() { return Err(usage("Unexpected positional arguments")); }
    Ok(request)
}

fn parse_share(args: &[String]) -> Result<Value, Failure> {
    let command = args.first().ok_or_else(|| usage("share requires friends, send, inbox, approve, read, status or cancel"))?;
    let command = if command == "friends" { "peers" } else { command.as_str() };
    if !["peers", "send", "status", "cancel", "inbox", "approve", "read"].contains(&command) { return Err(usage("Unknown share command; see passport --help")); }
    let mut index = 1;
    let mut to = None;
    let mut content: Option<(&str, String)> = None;
    let mut attachment = None;
    let mut id = None;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => {},
            "--to" if command == "send" && to.is_none() => to = Some(value(args, &mut index)?),
            "--file" if command == "send" && attachment.is_none() => attachment = Some(value(args, &mut index)?),
            flag @ ("--text" | "--markdown-file") if command == "send" && content.is_none() => {
                let input = value(args, &mut index)?;
                let kind = if flag == "--markdown-file" { "markdownFile" } else { "text" };
                content = Some((kind, input));
            },
            token if ["status", "cancel", "approve", "read"].contains(&command) && !token.starts_with('-') && id.is_none() => id = Some(token.to_owned()),
            _ => return Err(usage("Invalid or repeated share option")),
        }
        index += 1;
    }
    let mut request = json!({"command": format!("share.{command}")});
    if command == "send" {
        let to = to.ok_or_else(|| usage("Specify --to with an exact registered alias or device ID"))?;
        let (mut kind, mut data) = content.ok_or_else(|| usage("Choose --text or --markdown-file; --file attaches a file to the message"))?;
        if kind == "markdownFile" && data == "-" { kind = "text"; data = read_text(io::stdin().lock())?; }
        if kind == "text" && data.len() as u64 > TEXT_LIMIT { return Err(usage("Markdown exceeds UTF-8 256 KiB")); }
        if kind == "text" && data.trim().is_empty() { return Err(usage("A message is required")); }
        if kind != "text" {
            if data == "-" { return Err(usage("Binary file input requires a file path")); }
            let file = std::path::PathBuf::from(&data);
            let absolute = if file.is_absolute() { file } else { env::current_dir().map_err(|_| fail("INPUT_READ", "Cannot resolve current directory"))?.join(file) };
            data = absolute.to_str().ok_or_else(|| usage("File path must be UTF-8"))?.to_owned();
        }
        request["input"] = json!({"to":to});
        request["input"][kind] = json!(data);
        if let Some(data) = attachment {
            if data == "-" { return Err(usage("Attachment requires a file path")); }
            let file = std::path::PathBuf::from(&data);
            let absolute = if file.is_absolute() { file } else { env::current_dir().map_err(|_| fail("INPUT_READ", "Cannot resolve current directory"))?.join(file) };
            request["input"]["file"] = json!(absolute.to_str().ok_or_else(|| usage("File path must be UTF-8"))?);
        }
    } else if ["status", "cancel", "approve", "read"].contains(&command) {
        request["id"] = json!(id.ok_or_else(|| usage("A transfer or message ID is required"))?);
    }
    Ok(request)
}

fn exchange(stream: impl Read + Write, body: &str) -> Result<Value, Failure> {
    let mut stream = stream;
    stream.write_all(body.as_bytes()).map_err(|_| fail("DELIVERY_UNKNOWN", "Request write failed; input may have been delivered. Do not retry automatically."))?;
    stream.write_all(b"\n").map_err(|_| fail("DELIVERY_UNKNOWN", "Request write failed; input may have been delivered."))?;
    let mut bytes = Vec::new();
    stream.take(RESPONSE_LIMIT + 1).read_to_end(&mut bytes)
        .map_err(|_| fail("DELIVERY_UNKNOWN", "Response lost; input may have been delivered. Do not retry automatically."))?;
    if bytes.len() as u64 > RESPONSE_LIMIT { return Err(fail("INVALID_RESPONSE", "Response exceeds limit")); }
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| fail("DELIVERY_UNKNOWN", "No complete response; input may have been delivered."))?;
    if response["version"] != 1 || !response["ok"].is_boolean() {
        return Err(fail("INVALID_RESPONSE", "Unsupported CLI protocol response"));
    }
    Ok(response)
}
fn connection_failure(error: io::Error) -> Failure {
    let reason = match error.kind() {
        io::ErrorKind::NotFound => "Passport connection address no longer exists. Reconnect the local terminal and restart its AI process.",
        io::ErrorKind::ConnectionRefused => "Passport is not accepting connections. Check that the app is running, then reconnect the local terminal.",
        io::ErrorKind::PermissionDenied => "The OS denied access to Passport. Check the calling process permissions or sandbox and compare with direct execution in the same local terminal.",
        _ => "Cannot connect to Passport. Check that the app is running and reconnect the local terminal.",
    };
    let mut failure = fail("UNAVAILABLE", reason);
    failure.os_code = error.raw_os_error();
    failure
}
fn failure_response(error: &Failure) -> Value {
    let mut response = json!({"version": 1, "ok": false, "error": {"code": error.code, "message": error.message}});
    if let Some(code) = error.os_code { response["error"]["osCode"] = json!(code); }
    response
}
fn connect(endpoint: &str, body: &str) -> Result<Value, Failure> {
    #[cfg(unix)] {
        use std::os::unix::net::UnixStream;
        let stream = UnixStream::connect(endpoint).map_err(connection_failure)?;
        stream.set_read_timeout(Some(Duration::from_secs(6))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(6))).ok();
        exchange(stream, body)
    }
    #[cfg(windows)] {
        if !endpoint.starts_with(r"\\.\pipe\passport-") { return Err(fail("UNAVAILABLE", "Invalid local Passport endpoint")); }
        let stream = fs::OpenOptions::new().read(true).write(true).open(endpoint)
            .map_err(connection_failure)?;
        exchange(stream, body)
    }
}
fn run(request: Value) -> Result<Value, Failure> {
    let sharing = request["command"].as_str().is_some_and(|command| command.starts_with("share."));
    let get = |name| env::var(name).ok().filter(|value| !value.is_empty()).ok_or_else(|| fail("UNAUTHORIZED", if sharing {
        "Enable Notes (쪽지) in Passport Settings, then run this command in a new local terminal. Restart the AI process there so it inherits the new connection."
    } else {
        "Enable CLI access in Passport Settings > Local terminal, then run this command in a new local terminal. Restart the AI process there so it inherits the new connection."
    }));
    let endpoint = get("PASSPORT_CONTROL_ENDPOINT")?;
    let body = json!({ "version": 1, "token": get("PASSPORT_CONTROL_TOKEN")?,
        "source": { "paneId": get("PASSPORT_PANE_ID")?, "sessionId": get("PASSPORT_SESSION_ID")? }, "request": request }).to_string();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || { let _ = tx.send(connect(&endpoint, &body)); });
    rx.recv_timeout(Duration::from_secs(6)).map_err(|_| fail("DELIVERY_UNKNOWN", "Request timed out; input may have been delivered. Do not retry automatically."))?
}
fn safe(value: &Value) -> String {
    value.as_str().unwrap_or("-").chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}
fn has_flag(args: &[String], flag: &str) -> bool {
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" { break; }
        if arg == flag { return true; }
        if ["--pane", "--tab", "--lines", "--file", "--to", "--text", "--markdown-file"].contains(&arg) { index += 1; }
        index += 1;
    }
    false
}
fn display(response: &Value, command: &str, as_json: bool) -> i32 {
    let ok = response["ok"] == true;
    if as_json { println!("{response}"); }
    else if !ok {
        eprintln!("{}: {}", safe(&response["error"]["code"]), safe(&response["error"]["message"]));
    } else {
        let value = &response["value"];
        match command {
            "list" => {
                println!("PANE ID\tTAB\tSTATE\tSHELL\tSTART FOLDER\tCONFIGURED AGENT");
                if let Some(panels) = value.as_array() {
                    for p in panels {
                        println!("{}\t{}\t{}\t{}\t{}\t{}", safe(&p["paneId"]), safe(&p["workspaceName"]), safe(&p["status"]), safe(&p["shell"]), safe(&p["launchCwd"]), safe(&p["configuredAgent"]));
                    }
                }
            },
            "identify" => println!("{}\t{}", safe(&value["paneId"]), safe(&value["workspaceName"])),
            "share.peers" => {
                println!("DEVICE ID\tALIAS");
                if let Some(peers) = value.as_array() { for peer in peers { println!("{}\t{}", safe(&peer["id"]), safe(&peer["name"])); } }
            },
            "share.send" | "share.status" | "share.cancel" | "share.approve" => println!("{}\t{}", safe(&value["id"]), safe(&value["state"])),
            "share.inbox" => {
                println!("ID\tSTATE\tFROM\tTITLE / FILE");
                if let Some(items) = value["pending"].as_array() { for item in items { println!("{}\t{}\t{}\t{}", safe(&item["id"]), safe(&item["state"]), safe(&item["peerName"]), safe(&item["name"])); } }
                if let Some(items) = value["messages"].as_array() { for item in items { println!("{}\tdelivered\t{}\t{}", safe(&item["id"]), safe(&item["peerName"]), safe(&item["title"])); } }
            },
            "share.read" => {
                println!("{}", value["markdown"].as_str().unwrap_or("").chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t')).collect::<String>());
                if value["attachment"].is_object() { println!("Attachment: {}\t{}", safe(&value["attachment"]["name"]), safe(&value["attachment"]["path"])); }
            },
            "read" => {
                print!("{}", value["text"].as_str().unwrap_or(""));
                if value["truncated"] == true { eprintln!("[Passport: earlier output omitted]"); }
            },
            _ => println!("Accepted: {}", safe(&value["paneId"])),
        }
    }
    if ok { 0 } else { 1 }
}
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // Global switches are interpreted only before the literal-text delimiter.
    if has_flag(&args, "--help") { println!("{HELP}"); return; }
    if has_flag(&args, "--version") {
        println!("Passport {} (CLI protocol 1)", option_env!("PASSPORT_APP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))); return;
    }
    let as_json = has_flag(&args, "--json");
    let result = parse(&args).and_then(|request| {
        let command = request["command"].as_str().unwrap_or("").to_owned();
        run(request).map(|response| (response, command))
    });
    let code = match result {
        Ok((response, command)) => display(&response, &command, as_json),
        Err(error) => {
            let response = failure_response(&error);
            display(&response, "", as_json);
            error.exit
        },
    };
    process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(parts: &[&str]) -> Vec<String> { parts.iter().map(|s| s.to_string()).collect() }
    #[test]
    fn literal_text_and_target_are_explicit() {
        let request = parse(&args(&["send", "--pane", "id", "--submit", "--", "--한글\n끝\n"])).unwrap();
        assert_eq!(request["text"], "--한글\n끝\n");
        assert_eq!(request["submit"], true);
        assert!(parse(&args(&["send", "hi"])).is_err());
        assert!(parse(&args(&["read", "--pane", "id", "--tab", "name"])).is_err());
        assert!(parse(&args(&["list", "--pane", "id"])).is_err());
    }
    #[test]
    fn validates_command_options_and_input_bytes() {
        assert!(!has_flag(&args(&["send", "--file", "--help"]), "--help"));
        assert!(!has_flag(&args(&["send", "--", "--json"]), "--json"));
        assert!(parse(&args(&["read", "--pane", "id", "--lines", "1001"])).is_err());
        assert!(parse(&args(&["key", "--pane", "id", "delete"])).is_err());
        assert!(parse(&args(&["list", "--submit"])).is_err());
        assert!(read_text(&b"\xff"[..]).is_err());
        assert!(read_text(vec![b'x'; TEXT_LIMIT as usize + 1].as_slice()).is_err());
        assert_eq!(read_text("한글\r\n\n".as_bytes()).unwrap(), "한글\r\n\n");
    }
    #[test]
    fn sharing_requires_explicit_commands_and_ids_and_never_offers_execution() {
        assert_eq!(parse(&args(&["share", "friends", "--json"])).unwrap(), parse(&args(&["share", "peers", "--json"])).unwrap());
        assert!(parse(&args(&["share", "friends", "--to", "승민"])).is_err());
        let request = parse(&args(&["share", "send", "--to", "승민", "--text", "# 결과\n\n본문", "--json"])).unwrap();
        assert_eq!(request["command"], "share.send");
        assert_eq!(request["input"]["text"], "# 결과\n\n본문");
        assert!(!has_flag(&args(&["share", "send", "--to", "--help", "--text", "--json"]), "--help"));
        assert!(!has_flag(&args(&["share", "send", "--to", "승민", "--text", "--json"]), "--json"));
        assert_eq!(parse(&args(&["share", "approve", "id"])).unwrap(), json!({"command":"share.approve", "id":"id"}));
        assert_eq!(parse(&args(&["share", "read", "id"])).unwrap(), json!({"command":"share.read", "id":"id"}));
        assert_eq!(parse(&args(&["share", "inbox", "--json"])).unwrap(), json!({"command":"share.inbox"}));
        for parts in [&["share", "approve"][..], &["share", "read"], &["share", "inbox", "id"], &["share", "approve", "id", "id"], &["share", "execute", "id"]] {
            assert!(parse(&args(parts)).is_err());
        }
        assert!(parse(&args(&["share", "send", "--to", "승민", "--text", "body", "--submit"])).is_err());
        assert!(parse(&args(&["share", "send", "--text", "body"])).is_err());
        let attached = parse(&args(&["share", "send", "--to", "승민", "--text", "body", "--file", "x"])).unwrap();
        assert_eq!(attached["input"]["text"], "body");
        assert!(std::path::Path::new(attached["input"]["file"].as_str().unwrap()).is_absolute());
        assert!(parse(&args(&["share", "send", "--to", "승민", "--file", "x"])).is_err());
        assert!(parse(&args(&["share", "send", "--to", "승민", "--text", "  ", "--file", "x"])).is_err());
    }
    #[test]
    fn connection_errors_explain_os_failures_without_exposing_endpoint_or_token() {
        for (kind, expected) in [(io::ErrorKind::NotFound, "address no longer exists"), (io::ErrorKind::ConnectionRefused, "not accepting"), (io::ErrorKind::PermissionDenied, "OS denied")] {
            let failure = connection_failure(io::Error::new(kind, "secret-token /private/socket"));
            let response = failure_response(&failure);
            assert_eq!(response["error"]["code"], "UNAVAILABLE");
            assert!(failure.message.contains(expected));
            assert!(!response.to_string().contains("secret-token"));
            assert!(!response.to_string().contains("/private/socket"));
        }
        let failure = connection_failure(io::Error::from_raw_os_error(2));
        assert_eq!(failure_response(&failure)["error"]["osCode"], 2);
        assert!(failure_response(&fail("DELIVERY_UNKNOWN", "Do not retry"))["error"].get("osCode").is_none());
    }
}
