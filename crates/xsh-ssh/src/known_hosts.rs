//! Minimal, conservative reader for the user's OpenSSH `known_hosts` file.
//!
//! XSH keeps its own Host Key database, but users who already use the system
//! `ssh` client (or iTerm2) should not have to confirm the same host again.
//! This module deliberately supports exact, unhashed host entries only. It
//! never treats a hashed entry as a match by guessing or comparing plaintext.

use anyhow::{Context, Result};
use chrono::Utc;
use russh::keys::{HashAlg, parse_public_key_base64};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use xsh_domain::KnownHost;

/// Read the first exact matching host key from the user's OpenSSH file.
///
/// This is intentionally best-effort at the call site: a missing or malformed
/// `known_hosts` file should not prevent XSH from connecting. The returned
/// error still includes the path so callers can decide how to present it.
pub fn read_user_known_host(host: &str, port: u16) -> Result<Option<KnownHost>> {
    let Some(home) = home_directory() else {
        return Ok(None);
    };
    read_from(home.join(".ssh").join("known_hosts"), host, port)
}

/// Read a host key from an explicit OpenSSH `known_hosts` file.
///
/// Supported entries:
/// - `host ssh-ed25519 BASE64`
/// - `[host]:port ssh-ed25519 BASE64`
/// - comma-separated exact host names
///
/// Hashed hosts (`|1|...`) and wildcard/pattern entries are skipped because
/// XSH does not have the salt/hash verification path here yet.
pub fn read_from(path: impl AsRef<Path>, host: &str, port: u16) -> Result<Option<KnownHost>> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(path)
        .with_context(|| format!("failed to read OpenSSH known_hosts {}", path.display()))?;
    Ok(parse_contents(&contents, host, port))
}

fn parse_contents(contents: &str, host: &str, port: u16) -> Option<KnownHost> {
    let requested_host = host.trim();
    let bracketed_host = format!("[{requested_host}]:{port}");

    for raw_line in contents.lines() {
        let line = raw_line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
            continue;
        }

        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let host_patterns = fields[0];
        if host_patterns.starts_with('|') {
            continue;
        }
        let Some(matched_host) = host_patterns.split(',').find(|candidate| {
            is_exact_host_match(candidate, requested_host, &bracketed_host, port)
        }) else {
            continue;
        };

        // Do not match a pattern accidentally. The function currently only
        // accepts exact host forms, but keeping this guard makes that policy
        // explicit if matching is extended later.
        if matched_host.contains('*') || matched_host.contains('?') || matched_host.starts_with('!')
        {
            continue;
        }

        let key_type = fields[1];
        let key_base64 = fields[2];
        let Ok(public_key) = parse_public_key_base64(key_base64) else {
            continue;
        };
        let Ok(public_key_openssh) = public_key.to_openssh() else {
            continue;
        };

        let now = Utc::now();
        return Some(KnownHost {
            host: requested_host.to_owned(),
            port,
            key_type: key_type.to_owned(),
            fingerprint: public_key.fingerprint(HashAlg::Sha256).to_string(),
            public_key: public_key_openssh,
            first_seen: now,
            last_seen: now,
        });
    }

    None
}

fn is_exact_host_match(candidate: &str, host: &str, bracketed_host: &str, port: u16) -> bool {
    if candidate == host {
        // A bare host in known_hosts means the default SSH port. For a custom
        // port OpenSSH writes the bracketed form, so never reuse a bare entry
        // for the wrong port.
        return port == 22;
    }
    candidate == bracketed_host
}

fn home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    { env::var_os("HOME").map(PathBuf::from) }.or_else(|| env::var_os("HOME").map(PathBuf::from))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ED25519_KEY: &str =
        "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";

    #[test]
    fn reads_default_port_exact_host() {
        let contents = format!("example.com ssh-ed25519 {ED25519_KEY} comment\n");
        let host = parse_contents(&contents, "example.com", 22).expect("host key");
        assert_eq!(host.host, "example.com");
        assert_eq!(host.port, 22);
        assert_eq!(host.key_type, "ssh-ed25519");
        assert!(host.fingerprint.starts_with("SHA256:"));
        assert!(host.public_key.starts_with("ssh-ed25519 "));
    }

    #[test]
    fn reads_custom_port_only_from_bracketed_form() {
        let contents = format!(
            "example.com ssh-ed25519 {ED25519_KEY}\n[example.com]:50001 ssh-ed25519 {ED25519_KEY}\n"
        );
        assert!(parse_contents(&contents, "example.com", 22).is_some());
        assert!(parse_contents(&contents, "example.com", 50001).is_some());
        assert!(parse_contents(&contents, "example.com", 50002).is_none());

        let default_only = format!("example.com ssh-ed25519 {ED25519_KEY}\n");
        assert!(parse_contents(&default_only, "example.com", 50001).is_none());
    }

    #[test]
    fn supports_comma_separated_exact_hosts() {
        let contents = format!("alias.example.com,real.example.com ssh-ed25519 {ED25519_KEY}\n");
        assert!(parse_contents(&contents, "real.example.com", 22).is_some());
    }

    #[test]
    fn skips_hashed_and_wildcard_entries() {
        let contents = format!(
            "|1|salt|hash ssh-ed25519 {ED25519_KEY}\n*.example.com ssh-ed25519 {ED25519_KEY}\n"
        );
        assert!(parse_contents(&contents, "server.example.com", 22).is_none());
    }

    #[test]
    fn reads_explicit_file() {
        let directory = std::env::temp_dir().join(format!(
            "xsh-known-hosts-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("known_hosts");
        fs::write(
            &path,
            format!("[127.0.0.1]:50001 ssh-ed25519 {ED25519_KEY}\n"),
        )
        .unwrap();
        assert!(read_from(&path, "127.0.0.1", 50001).unwrap().is_some());
        fs::remove_dir_all(directory).unwrap();
    }
}
