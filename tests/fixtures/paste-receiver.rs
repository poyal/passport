// Windows console receiver for the real PTY paste test. Node/libuv's console
// reader processes this Unicode payload slowly enough to obscure PTY delivery.
// ReadConsoleW through Rust stdin preserves Unicode and reads available batches.
use std::{fs::File, io::{self, Write}};

unsafe extern "system" {
    fn GetStdHandle(kind: u32) -> *mut std::ffi::c_void;
    fn SetConsoleMode(handle: *mut std::ffi::c_void, mode: u32) -> i32;
}

fn main() -> io::Result<()> {
    let destination = std::env::args_os().nth(1).expect("output path required");
    // Raw input plus ENABLE_VIRTUAL_TERMINAL_INPUT preserves bracketed-paste
    // delimiters; cooked console input would consume those escape sequences.
    if unsafe { SetConsoleMode(GetStdHandle(-10_i32 as u32), 0x200) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut output = File::create(destination)?;
    print!("\x1b[?2004hPASTE_READY\r\n");
    io::stdout().flush()?;
    io::copy(&mut io::stdin().lock(), &mut output)?;
    Ok(())
}
