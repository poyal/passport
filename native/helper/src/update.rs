//! Update primitives shared by the standalone updater and its isolated tests.
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read, Write},
    path::{Component, Path},
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub fn manifest(
    bytes: &[u8],
    signature: &[u8],
    key: &str,
    current: &str,
    expected: &str,
) -> Result<serde_json::Value> {
    if bytes.len() > 65536 {
        return Err("Manifest too large".into());
    }
    VerifyingKey::from_public_key_pem(key)?
        .verify_strict(bytes, &Signature::from_slice(signature)?)?;
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    if value["format"] != "passport-update-v1"
        || value["version"] != expected
        || version(expected)? <= version(current)?
    {
        return Err("Invalid update version".into());
    }
    Ok(value)
}
fn version(text: &str) -> Result<[u32; 3]> {
    let parts: Vec<_> = text.split('.').collect();
    if parts.len() != 3 {
        return Err("Invalid version".into());
    }
    let mut result = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty()
            || part.len() > 9
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|c| c.is_ascii_digit())
        {
            return Err("Invalid version".into());
        }
        result[i] = part.parse()?;
    }
    Ok(result)
}
pub fn package(file: &Path, size: u64, expected: &str) -> Result<()> {
    if size == 0 || size > 2 * 1024 * 1024 * 1024 || fs::metadata(file)?.len() != size {
        return Err("Invalid package size".into());
    }
    let mut hash = Sha256::new();
    let mut input = fs::File::open(file)?;
    let mut buffer = [0_u8; 65536];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("Invalid package hash".into());
    }
    Ok(())
}
/// Extract into a newly created directory. Links are delayed until all regular
/// files are written, so no archive entry can redirect a subsequent write.
pub fn extract(file: &Path, stage: &Path) -> Result<()> {
    fs::create_dir(stage)?;
    let mut archive = zip::ZipArchive::new(fs::File::open(file)?)?;
    if archive.len() > 100_000 {
        return Err("Too many archive entries".into());
    }
    let mut names = HashSet::new();
    let mut links = Vec::new();
    let mut total = 0_u64;
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        let name = entry.name().to_owned();
        let relative = Path::new(&name);
        if name.contains('\\')
            || name.contains(':')
            || relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || !names.insert(name.trim_end_matches('/').to_lowercase())
        {
            return Err("Unsafe archive path".into());
        }
        total = total.checked_add(entry.size()).ok_or("Archive too large")?;
        if total > 8 * 1024 * 1024 * 1024 {
            return Err("Archive too large".into());
        }
        let dest = stage.join(relative);
        let mode = entry.unix_mode().unwrap_or(0o644);
        if mode & 0o170000 == 0o120000 {
            let mut target = String::new();
            entry.take(4097).read_to_string(&mut target)?;
            if target.len() > 4096
                || target.contains('\\')
                || target.contains(':')
                || Path::new(&target).is_absolute()
                || Path::new(&target)
                    .components()
                    .any(|c| matches!(c, Component::ParentDir))
            {
                return Err("Unsafe archive link".into());
            }
            let mut depth = relative
                .parent()
                .map(|p| p.components().count())
                .unwrap_or(0);
            for component in Path::new(&target).components() {
                match component {
                    Component::Normal(_) => depth += 1,
                    Component::CurDir => (),
                    Component::ParentDir if depth > 0 => depth -= 1,
                    _ => return Err("Escaping archive link".into()),
                }
            }
            links.push((dest, target));
        } else if entry.is_dir() {
            fs::create_dir_all(dest)?;
        } else {
            if mode & 0o170000 != 0 && mode & 0o170000 != 0o100000 {
                return Err("Unsupported archive entry".into());
            }
            fs::create_dir_all(dest.parent().ok_or("Missing parent")?)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)?;
            let expected = entry.size();
            let copied = io::copy(&mut entry.take(expected + 1), &mut output)?;
            if copied != expected {
                return Err("Archive entry size mismatch".into());
            }
            output.flush()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&dest, fs::Permissions::from_mode(mode & 0o777))?;
            }
        }
    }
    for (dest, target) in links {
        #[cfg(unix)]
        {
            fs::create_dir_all(dest.parent().ok_or("Missing parent")?)?;
            std::os::unix::fs::symlink(target, dest)?;
        }
        #[cfg(windows)]
        {
            let _ = (dest, target);
            return Err("Windows update archives cannot contain links".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::{ZipWriter, write::SimpleFileOptions};
    #[test]
    fn rejects_traversal_and_does_not_overwrite_existing_stage() {
        let root = std::env::temp_dir().join(format!("passport-updater-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("package.zip");
        let mut zip = ZipWriter::new(fs::File::create(&file).unwrap());
        zip.start_file("../escape", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();
        let stage = root.join("stage");
        assert!(extract(&file, &stage).is_err());
        assert!(!root.join("escape").exists());
        fs::write(stage.join("keep"), b"keep").unwrap();
        assert!(extract(&file, &stage).is_err());
        assert_eq!(fs::read(stage.join("keep")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stable_versions_only() {
        for v in ["1.2", "1.2.3-dev", "01.2.3", "1.2.-1"] {
            assert!(version(v).is_err());
        }
        assert!(version("1.10.0").unwrap() > version("1.9.9").unwrap());
    }
}
