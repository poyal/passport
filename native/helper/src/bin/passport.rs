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

Use --tab EXACT_NAME instead of --pane only for an unambiguous single local pane.
--file - reads UTF-8 from stdin (maximum 256 KiB). Use -- before literal text
beginning with a dash. send adds no Enter unless --submit is specified.
read returns up to 100 logical lines by default; --lines accepts 1..1000.
Enable CLI access in Settings > Local terminal, then open a new local terminal.
No automatic retries. A delivery timeout may mean input was already delivered.
--help and --version work without a running app. Exit: 0 success, 1 runtime, 2 usage.";

#[derive(Debug)]
struct Failure { code: &'static str, message: String, exit: i32 }
fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure { code, message: message.into(), exit: 1 }
}
fn usage(message: impl Into<String>) -> Failure {
    Failure { code: "USAGE", message: message.into(), exit: 2 }
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
fn connect(endpoint: &str, body: &str) -> Result<Value, Failure> {
    #[cfg(unix)] {
        use std::os::unix::net::UnixStream;
        let stream = UnixStream::connect(endpoint).map_err(|_| fail("UNAVAILABLE", "Cannot connect to Passport. Open a new local terminal."))?;
        stream.set_read_timeout(Some(Duration::from_secs(6))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(6))).ok();
        exchange(stream, body)
    }
    #[cfg(windows)] {
        if !endpoint.starts_with(r"\\.\pipe\passport-") { return Err(fail("UNAVAILABLE", "Invalid local Passport endpoint")); }
        let stream = fs::OpenOptions::new().read(true).write(true).open(endpoint)
            .map_err(|_| fail("UNAVAILABLE", "Cannot connect to Passport. Open a new local terminal."))?;
        exchange(stream, body)
    }
}
fn run(request: Value) -> Result<Value, Failure> {
    let get = |name| env::var(name).map_err(|_| fail("UNAUTHORIZED", "Enable CLI access in Passport Settings > Local terminal, then run this command in a new local terminal."));
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
        if ["--pane", "--tab", "--lines", "--file"].contains(&arg) { index += 1; }
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
            let response = json!({"version": 1, "ok": false, "error": {"code": error.code, "message": error.message}});
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
}
