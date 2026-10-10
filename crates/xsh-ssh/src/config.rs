use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// A concrete host alias from the user's OpenSSH configuration.
///
/// Secrets are intentionally not part of this type: OpenSSH config does not
/// define password storage, and XSH must never import passwords from shell
/// files or environment variables.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigEntry {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub identity_file: Option<PathBuf>,
    /// OpenSSH accepts more than one IdentityFile and tries them in order.
    /// XSH imports the first one as the session default but exposes every
    /// resolved path so the user can choose a different identity later.
    pub identity_files: Vec<PathBuf>,
    pub proxy_jump: Option<String>,
    pub source_path: PathBuf,
}

#[derive(Debug, Clone, Default)]
struct HostOptions {
    hostname: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    identity_files: Vec<PathBuf>,
    proxy_jump: Option<String>,
}

#[derive(Debug, Clone)]
struct HostBlock {
    patterns: Vec<String>,
    options: HostOptions,
}

struct UserConfigCache {
    signature: Option<(SystemTime, u64)>,
    entries: Vec<SshConfigEntry>,
}

fn user_config_cache() -> &'static Mutex<Option<UserConfigCache>> {
    static CACHE: OnceLock<Mutex<Option<UserConfigCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn user_config_signature(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

impl SshConfigEntry {
    /// Reads the user's `~/.ssh/config`.
    ///
    /// The parse walks `Include` directives (including directory globs), so it
    /// performs blocking filesystem work; results are cached keyed on the main
    /// config file's (mtime, len) so repeated calls only stat the file. Edits
    /// to `Include`d files without touching the main config need a restart to
    /// be picked up. Async callers should prefer [`Self::read_user_config_async`].
    pub fn read_user_config() -> Result<Vec<Self>> {
        let home = user_home_directory()
            .ok_or_else(|| anyhow!("could not determine the user home directory"))?;
        let path = home.join(".ssh").join("config");
        let signature = user_config_signature(&path);
        let cached_entries = match user_config_cache().lock() {
            Ok(guard) => match guard.as_ref() {
                Some(cache) if cache.signature == signature => Some(cache.entries.clone()),
                _ => None,
            },
            Err(_) => None,
        };
        if let Some(entries) = cached_entries {
            return Ok(entries);
        }
        let entries = Self::read_from(&path)?;
        if let Ok(mut cache) = user_config_cache().lock() {
            *cache = Some(UserConfigCache {
                signature,
                entries: entries.clone(),
            });
        }
        Ok(entries)
    }

    /// Blocking-safe variant of [`Self::read_user_config`] for async callers.
    pub async fn read_user_config_async() -> Result<Vec<Self>> {
        tokio::task::spawn_blocking(Self::read_user_config)
            .await
            .context("SSH config parsing task failed")?
    }

    pub fn read_from(path: impl AsRef<Path>) -> Result<Vec<Self>> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let text = read_config_with_includes(&path, &mut HashSet::new())?;
        let blocks = parse_blocks(&text)?;
        resolve_entries(&blocks, &path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyJumpTarget {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
}

/// Resolve the first OpenSSH `ProxyJump` target.
///
/// XSH intentionally starts with one jump host. Comma-separated multi-hop
/// chains are rejected instead of silently using only part of the route.
pub fn resolve_proxy_jump(value: &str) -> Result<Option<ProxyJumpTarget>> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    if value.contains(',') {
        return Err(anyhow!("multi-hop ProxyJump is not supported yet"));
    }

    let (configured_user, address) = value
        .rsplit_once('@')
        .map(|(user, address)| (Some(user.trim()), address.trim()))
        .unwrap_or((None, value));
    if address.is_empty() {
        return Err(anyhow!("ProxyJump host is empty"));
    }

    if let Ok(entries) = SshConfigEntry::read_user_config()
        && let Some(entry) = entries.iter().find(|entry| {
            entry.alias.eq_ignore_ascii_case(address)
                || (entry.hostname.eq_ignore_ascii_case(address) && entry.port == 22)
        })
    {
        return Ok(Some(ProxyJumpTarget {
            host: entry.hostname.clone(),
            port: entry.port,
            username: configured_user
                .filter(|user| !user.is_empty())
                .map(str::to_owned)
                .or_else(|| (!entry.username.is_empty()).then(|| entry.username.clone())),
        }));
    }

    let (host, port) = parse_jump_address(address)?;
    Ok(Some(ProxyJumpTarget {
        host,
        port,
        username: configured_user
            .filter(|user| !user.is_empty())
            .map(str::to_owned),
    }))
}

/// Blocking-safe variant of [`resolve_proxy_jump`] for async callers: the
/// first call after a config edit walks `Include` globs on the filesystem.
pub async fn resolve_proxy_jump_async(value: &str) -> Result<Option<ProxyJumpTarget>> {
    let value = value.to_owned();
    tokio::task::spawn_blocking(move || resolve_proxy_jump(&value))
        .await
        .context("SSH ProxyJump resolution task failed")?
}

fn parse_jump_address(value: &str) -> Result<(String, u16)> {
    if let Some(rest) = value.strip_prefix('[') {
        let Some((host, port)) = rest.split_once(']') else {
            return Err(anyhow!("invalid bracketed ProxyJump address"));
        };
        let port = port
            .strip_prefix(':')
            .map(str::parse::<u16>)
            .transpose()
            .context("invalid ProxyJump port")?
            .unwrap_or(22);
        if host.is_empty() {
            return Err(anyhow!("ProxyJump host is empty"));
        }
        return Ok((host.to_owned(), port));
    }

    if value.matches(':').count() == 1 {
        let (host, port) = value.rsplit_once(':').expect("one colon implies a split");
        if let Ok(port) = port.parse::<u16>() {
            if host.is_empty() {
                return Err(anyhow!("ProxyJump host is empty"));
            }
            return Ok((host.to_owned(), port));
        }
        return Err(anyhow!("invalid ProxyJump port"));
    }
    Ok((value.to_owned(), 22))
}

/// The one true home-directory probe; the Tauri layer and every xsh-ssh
/// module use this so USERPROFILE/HOME fallbacks cannot drift apart.
pub fn user_home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    { env::var_os("HOME").map(PathBuf::from) }.or_else(|| env::var_os("HOME").map(PathBuf::from))
}

fn parse_blocks(text: &str) -> Result<Vec<HostBlock>> {
    let mut blocks = Vec::new();
    let mut current: Option<HostBlock> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = split_directive(line) else {
            continue;
        };
        if key.eq_ignore_ascii_case("host") {
            if let Some(block) = current.take()
                && !block.patterns.is_empty()
            {
                blocks.push(block);
            }
            let patterns = tokenize(value);
            current = Some(HostBlock {
                patterns,
                options: HostOptions::default(),
            });
            continue;
        }

        let Some(block) = current.as_mut() else {
            // OpenSSH permits global directives before the first Host block.
            // Treat them as Host * so concrete aliases inherit them.
            current = Some(HostBlock {
                patterns: vec!["*".into()],
                options: HostOptions::default(),
            });
            let Some(block) = current.as_mut() else {
                unreachable!()
            };
            apply_option(&mut block.options, key, value)?;
            continue;
        };
        apply_option(&mut block.options, key, value)?;
    }
    if let Some(block) = current
        && !block.patterns.is_empty()
    {
        blocks.push(block);
    }
    Ok(blocks)
}

fn split_directive(line: &str) -> Option<(&str, &str)> {
    let separator = line.find(|character: char| character.is_whitespace() || character == '=')?;
    let key = line[..separator].trim();
    let value = line[separator + 1..]
        .trim_start_matches(|character: char| character.is_whitespace() || character == '=')
        .trim();
    (!key.is_empty() && !value.is_empty()).then_some((key, value))
}

fn apply_option(options: &mut HostOptions, key: &str, raw_value: &str) -> Result<()> {
    let value = tokenize(raw_value).into_iter().next().unwrap_or_default();
    if value.is_empty() {
        return Ok(());
    }
    match key.to_ascii_lowercase().as_str() {
        "hostname" => {
            options.hostname.get_or_insert(value);
        }
        "user" => {
            options.username.get_or_insert(value);
        }
        "identityfile" => {
            let path = expand_path(&value);
            if !options.identity_files.contains(&path) {
                options.identity_files.push(path);
            }
        }
        "proxyjump" => {
            options.proxy_jump.get_or_insert(value);
        }
        "port" if options.port.is_none() => {
            if let Ok(port) = value.parse::<u16>() {
                options.port = Some(port);
            }
        }
        _ => {}
    }
    Ok(())
}

fn resolve_entries(blocks: &[HostBlock], source_path: &Path) -> Result<Vec<SshConfigEntry>> {
    let mut aliases = Vec::new();
    let mut seen = HashSet::new();
    for block in blocks {
        for pattern in &block.patterns {
            if pattern.starts_with('!')
                || has_pattern_syntax(pattern)
                || !seen.insert(pattern.clone())
            {
                continue;
            }
            aliases.push(pattern.clone());
        }
    }

    let mut entries = Vec::new();
    for alias in aliases {
        let mut options = HostOptions::default();
        for block in blocks {
            if block_matches(block, &alias) {
                merge_options(&mut options, &block.options);
            }
        }
        let hostname = options.hostname.clone().unwrap_or_else(|| alias.clone());
        let username = options
            .username
            .clone()
            .or_else(current_username)
            .unwrap_or_default();
        let port = options.port.unwrap_or(22);
        entries.push(SshConfigEntry {
            alias,
            hostname,
            port,
            username,
            identity_file: options.identity_files.first().cloned(),
            identity_files: options.identity_files,
            proxy_jump: options.proxy_jump,
            source_path: source_path.to_path_buf(),
        });
    }
    Ok(entries)
}

fn merge_options(target: &mut HostOptions, source: &HostOptions) {
    if target.hostname.is_none() {
        target.hostname = source.hostname.clone();
    }
    if target.port.is_none() {
        target.port = source.port;
    }
    if target.username.is_none() {
        target.username = source.username.clone();
    }
    for identity_file in &source.identity_files {
        if !target.identity_files.contains(identity_file) {
            target.identity_files.push(identity_file.clone());
        }
    }
    if target.proxy_jump.is_none() {
        target.proxy_jump = source.proxy_jump.clone();
    }
}

fn current_username() -> Option<String> {
    #[cfg(windows)]
    {
        env::var("USERNAME").ok()
    }
    #[cfg(not(windows))]
    {
        env::var("USER").ok()
    }
}

fn expand_path(value: &str) -> PathBuf {
    if value == "~" {
        return user_home_directory().unwrap_or_else(|| PathBuf::from(value));
    }
    let rest = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"));
    if let Some(rest) = rest
        && let Some(home) = user_home_directory()
    {
        return home.join(rest);
    }
    PathBuf::from(value)
}

fn tokenize(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            if ch.is_whitespace() || ch == '\\' || ch == '\'' || ch == '"' {
                current.push(ch);
            } else {
                current.push('\\');
                current.push(ch);
            }
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn read_config_with_includes(path: &Path, active_paths: &mut HashSet<PathBuf>) -> Result<String> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !active_paths.insert(canonical.clone()) {
        return Err(anyhow!(
            "SSH config Include contains a cycle at {}",
            path.display()
        ));
    }
    let text = fs::read_to_string(path)
        .with_context(|| format!("failed to read SSH config {}", path.display()))?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut expanded = String::new();
    for raw_line in text.lines() {
        let line = raw_line.trim_start_matches('\u{feff}').trim();
        if let Some((key, value)) = split_directive(line)
            && key.eq_ignore_ascii_case("include")
        {
            for include in resolve_include_paths(value, parent)? {
                expanded.push_str(&read_config_with_includes(&include, active_paths)?);
                if !expanded.ends_with('\n') {
                    expanded.push('\n');
                }
            }
        } else {
            expanded.push_str(raw_line);
            expanded.push('\n');
        }
    }
    active_paths.remove(&canonical);
    Ok(expanded)
}

fn resolve_include_paths(value: &str, base_directory: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for raw_pattern in tokenize(value) {
        let path = expand_path(&raw_pattern);
        let pattern = if path.is_absolute() {
            path
        } else {
            base_directory.join(path)
        };
        let parent = pattern.parent().unwrap_or_else(|| Path::new("."));
        let file_pattern = pattern
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !has_pattern_syntax(file_pattern) {
            if pattern.is_file() {
                paths.push(pattern);
            }
            continue;
        }
        let mut matches = fs::read_dir(parent)
            .with_context(|| {
                format!(
                    "failed to read SSH config include directory {}",
                    parent.display()
                )
            })?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|candidate| candidate.is_file())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| wildcard_match(file_pattern, name))
            })
            .collect::<Vec<_>>();
        matches.sort();
        paths.extend(matches);
    }
    Ok(paths)
}

fn has_pattern_syntax(value: &str) -> bool {
    value.contains('*') || value.contains('?') || value.contains('!')
}

fn host_pattern_matches(pattern: &str, alias: &str) -> bool {
    let pattern = pattern.strip_prefix('!').unwrap_or(pattern);
    if pattern == "*" {
        return true;
    }
    if has_pattern_syntax(pattern) {
        wildcard_match(pattern, alias)
    } else {
        pattern.eq_ignore_ascii_case(alias)
    }
}

fn block_matches(block: &HostBlock, alias: &str) -> bool {
    let positive = block
        .patterns
        .iter()
        .filter(|pattern| !pattern.starts_with('!'))
        .any(|pattern| host_pattern_matches(pattern, alias));
    let excluded = block
        .patterns
        .iter()
        .filter(|pattern| pattern.starts_with('!'))
        .any(|pattern| host_pattern_matches(pattern, alias));
    positive && !excluded
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let (p, v): (Vec<char>, Vec<char>) = (pattern.chars().collect(), value.chars().collect());
    let mut dp = vec![vec![false; v.len() + 1]; p.len() + 1];
    dp[0][0] = true;
    for i in 1..=p.len() {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=p.len() {
        for j in 1..=v.len() {
            dp[i][j] = match p[i - 1] {
                '*' => dp[i - 1][j] || dp[i][j - 1],
                '?' => dp[i - 1][j - 1],
                ch => dp[i - 1][j - 1] && ch.eq_ignore_ascii_case(&v[j - 1]),
            };
        }
    }
    dp[p.len()][v.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_aliases_and_inherits_wildcard_defaults() {
        let path = temp_config_path();
        fs::write(
            &path,
            r#"
            Host *
              Port 2222
              IdentityFile ~/.ssh/id_ed25519
            Host app prod
              HostName 10.0.0.8
              User deploy
              Port 2200
              ProxyJump bastion
            Host ignored*
              HostName no.example
        "#,
        )
        .unwrap();
        let entries = SshConfigEntry::read_from(&path).unwrap();
        let app = entries.iter().find(|entry| entry.alias == "app").unwrap();
        assert_eq!(app.hostname, "10.0.0.8");
        assert_eq!(app.username, "deploy");
        assert_eq!(
            app.port, 2222,
            "first OpenSSH value wins across matching blocks"
        );
        assert!(app.identity_file.is_some());
        assert_eq!(app.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.alias == "ignored*")
                .count(),
            0
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn supports_bom_equals_syntax_and_negative_patterns() {
        let path = temp_config_path();
        fs::write(
            &path,
            "\u{feff}Host *\n User=demo\nHost !blocked *\n Port=50001\nHost allowed\n HostName=203.0.113.40\nHost blocked\n HostName=blocked.example\n",
        )
        .unwrap();
        let entries = SshConfigEntry::read_from(&path).unwrap();
        let allowed = entries
            .iter()
            .find(|entry| entry.alias == "allowed")
            .unwrap();
        assert_eq!(allowed.port, 50001);
        assert_eq!(allowed.hostname, "203.0.113.40");
        let blocked = entries
            .iter()
            .find(|entry| entry.alias == "blocked")
            .unwrap();
        assert_eq!(blocked.port, 22);
        assert_eq!(blocked.hostname, "blocked.example");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ignores_password_like_directives_and_handles_quotes() {
        let path = temp_config_path();
        fs::write(
            &path,
            "Host test\n HostName \"host.example\"\n User demo\n SetEnv PASSWORD=secret\n",
        )
        .unwrap();
        let entries = SshConfigEntry::read_from(&path).unwrap();
        assert_eq!(entries[0].hostname, "host.example");
        assert_eq!(entries[0].alias, "test");
        assert!(!entries[0].hostname.contains("secret"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn resolves_relative_include_wildcards_and_multiple_identity_files() {
        let directory = temp_config_directory();
        let includes = directory.join("conf.d");
        fs::create_dir_all(&includes).unwrap();
        let config = directory.join("config");
        fs::write(
            &config,
            "Include conf.d/*.conf\nHost app\n HostName app.example\n IdentityFile ~/.ssh/id_app\n",
        )
        .unwrap();
        fs::write(
            includes.join("00-defaults.conf"),
            "Host *\n User deploy\n IdentityFile ~/.ssh/id_default\n",
        )
        .unwrap();

        let entries = SshConfigEntry::read_from(&config).unwrap();
        let app = entries.iter().find(|entry| entry.alias == "app").unwrap();
        assert_eq!(app.hostname, "app.example");
        assert_eq!(app.username, "deploy");
        assert_eq!(app.identity_files.len(), 2);
        assert_eq!(app.identity_file.as_ref(), app.identity_files.first());
        let _ = fs::remove_dir_all(directory);
    }

    fn temp_config_path() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "xsh-ssh-config-{}-{timestamp}-{counter}",
            std::process::id()
        ))
    }

    fn temp_config_directory() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(10_000);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "xsh-ssh-config-directory-{}-{timestamp}-{counter}",
            std::process::id()
        ))
    }
    #[test]
    fn parses_proxy_jump_addresses() {
        assert_eq!(
            resolve_proxy_jump("ops@bastion:2200").unwrap(),
            Some(ProxyJumpTarget {
                host: "bastion".into(),
                port: 2200,
                username: Some("ops".into()),
            })
        );
        assert_eq!(
            resolve_proxy_jump("[2001:db8::1]:2222").unwrap(),
            Some(ProxyJumpTarget {
                host: "2001:db8::1".into(),
                port: 2222,
                username: None,
            })
        );
        assert!(resolve_proxy_jump("a,b").is_err());
        assert!(resolve_proxy_jump("none").unwrap().is_none());
    }
}
