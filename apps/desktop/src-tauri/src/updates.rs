use reqwest::{Client, StatusCode, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::CommandResult;

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/bilbilmyc/xsh/releases/latest";
const MAX_INSTALLER_SIZE: u64 = 512 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct UpdateState {
    operation: Mutex<()>,
    checked: Mutex<Option<CheckedUpdate>>,
}

#[derive(Clone)]
struct CheckedUpdate {
    asset: ReleaseAsset,
    downloaded: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    current_version: String,
    latest_version: Option<String>,
    available: bool,
    release_notes: String,
    published_at: Option<String>,
    download_name: Option<String>,
    download_size: Option<u64>,
    download_unavailable_reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

fn client() -> CommandResult<Client> {
    Client::builder()
        .user_agent(concat!("XSH/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .https_only(true)
        .build()
        .map_err(|error| format!("无法创建更新连接：{error}"))
}

fn parse_version(value: &str) -> CommandResult<Version> {
    let value = value.trim().trim_start_matches('v');
    let normalized = if value.split('.').count() == 2 && !value.contains(['-', '+']) {
        format!("{value}.0")
    } else {
        value.to_owned()
    };
    Version::parse(&normalized).map_err(|_| format!("无法识别版本号：{value}"))
}

fn asset_rank(name: &str, version: &Version, os: &str, arch: &str) -> Option<u8> {
    let prefix = format!("XSH_{version}_");
    let suffix = name.strip_prefix(&prefix)?;
    match (os, arch) {
        ("windows", arch) => {
            let arch = match arch {
                "x86_64" => "x64",
                "x86" => "x86",
                "aarch64" => "arm64",
                _ => return None,
            };
            if suffix == format!("{arch}-setup.exe") {
                Some(0)
            } else if suffix.starts_with(&format!("{arch}_")) && suffix.ends_with(".msi") {
                Some(1)
            } else {
                None
            }
        }
        ("macos", "aarch64" | "x86_64") => {
            if suffix == format!("{arch}.dmg") {
                Some(0)
            } else if suffix == "universal.dmg" {
                Some(1)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn expected_digest(asset: &ReleaseAsset) -> CommandResult<String> {
    let digest = asset
        .digest
        .as_deref()
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("发布的安装包缺少有效的 SHA-256 校验信息，请等待维护者重新发布。")?;
    Ok(digest.to_ascii_lowercase())
}

fn validate_asset(asset: &ReleaseAsset, tag: &str) -> CommandResult<()> {
    if asset.name.is_empty()
        || !asset
            .name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || asset.size == 0
        || asset.size > MAX_INSTALLER_SIZE
    {
        return Err("发布的安装包名称或大小无效。".into());
    }
    let url = Url::parse(&asset.browser_download_url).map_err(|_| "安装包下载地址无效。")?;
    let expected_path = format!("/bilbilmyc/xsh/releases/download/{tag}/{}", asset.name);
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != expected_path
    {
        return Err("安装包不是来自 XSH 官方 GitHub Release。".into());
    }
    expected_digest(asset)?;
    Ok(())
}

fn release_info(
    current: &Version,
    release: Option<Release>,
    os: &str,
    arch: &str,
) -> CommandResult<(UpdateInfo, Option<CheckedUpdate>)> {
    let mut info = UpdateInfo {
        current_version: current.to_string(),
        latest_version: None,
        available: false,
        release_notes: String::new(),
        published_at: None,
        download_name: None,
        download_size: None,
        download_unavailable_reason: None,
    };
    let Some(release) = release else {
        return Ok((info, None));
    };
    let latest = parse_version(&release.tag_name)?;
    if release.draft || release.prerelease || !latest.pre.is_empty() {
        return Err("更新服务未返回正式发布版本，请稍后重试。".into());
    }
    info.latest_version = Some(latest.to_string());
    info.available = latest.cmp_precedence(current).is_gt();
    info.release_notes = release
        .body
        .unwrap_or_default()
        .chars()
        .take(32_768)
        .collect();
    info.published_at = release.published_at;
    if !info.available {
        return Ok((info, None));
    }
    let asset = release
        .assets
        .into_iter()
        .filter_map(|asset| asset_rank(&asset.name, &latest, os, arch).map(|rank| (rank, asset)))
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, asset)| asset);
    let Some(asset) = asset else {
        info.download_unavailable_reason =
            Some(format!("此版本暂未提供适用于 {os} / {arch} 的安装包。"));
        return Ok((info, None));
    };
    if let Err(error) = validate_asset(&asset, &release.tag_name) {
        info.download_unavailable_reason = Some(error);
        return Ok((info, None));
    }
    info.download_name = Some(asset.name.clone());
    info.download_size = Some(asset.size);
    Ok((
        info,
        Some(CheckedUpdate {
            asset,
            downloaded: None,
        }),
    ))
}

#[tauri::command]
pub(crate) async fn check_for_updates(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> CommandResult<UpdateInfo> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "正在处理更新，请稍后再试。")?;
    let response = client()?
        .get(LATEST_RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| format!("无法连接更新服务，请检查网络后重试：{error}"))?;
    let release = match response.status() {
        StatusCode::NOT_FOUND => None,
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            return Err("GitHub 请求次数受限，请稍后再试。".into());
        }
        status if status.is_success() => Some(
            response
                .json::<Release>()
                .await
                .map_err(|error| format!("无法读取更新信息：{error}"))?,
        ),
        status => return Err(format!("更新服务暂时不可用（HTTP {status}），请稍后再试。")),
    };
    let (info, checked) = release_info(
        &app.package_info().version,
        release,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )?;
    *state.checked.lock().await = checked;
    Ok(info)
}

async fn save_download(
    mut response: reqwest::Response,
    asset: &ReleaseAsset,
    path: &Path,
    on_progress: impl Fn(DownloadProgress),
) -> CommandResult<()> {
    let expected = expected_digest(asset)?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|error| format!("无法创建安装包文件：{error}"))?;
    let mut hash = Sha256::new();
    let mut downloaded = 0;
    let mut last_progress = Instant::now();
    on_progress(DownloadProgress {
        downloaded,
        total: asset.size,
    });
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("安装包下载中断，请重试：{error}"))?
    {
        downloaded += chunk.len() as u64;
        if downloaded > asset.size {
            return Err("安装包大小与发布信息不符，请重新检查更新。".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("无法保存安装包，请检查磁盘空间：{error}"))?;
        hash.update(&chunk);
        if last_progress.elapsed() >= Duration::from_millis(100) || downloaded == asset.size {
            on_progress(DownloadProgress {
                downloaded,
                total: asset.size,
            });
            last_progress = Instant::now();
        }
    }
    if downloaded != asset.size || format!("{:x}", hash.finalize()) != expected {
        return Err("安装包完整性校验失败，请重新下载。".into());
    }
    file.sync_all()
        .await
        .map_err(|error| format!("无法保存安装包：{error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn download_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
    on_progress: Channel<DownloadProgress>,
) -> CommandResult<()> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "正在处理更新，请稍后再试。")?;
    let checked = state
        .checked
        .lock()
        .await
        .clone()
        .ok_or("请先检查更新并确认有适用的安装包。")?;
    if checked.downloaded.is_some() {
        return Ok(());
    }
    let response = client()?
        .get(&checked.asset.browser_download_url)
        .timeout(Duration::from_secs(15 * 60))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("无法下载安装包，请检查网络后重试：{error}"))?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法找到更新缓存目录：{error}"))?
        .join("updates")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("无法创建更新缓存目录：{error}"))?;
    let partial = directory.join("download.part");
    let target = directory.join(&checked.asset.name);
    let result = async {
        save_download(response, &checked.asset, &partial, |progress| {
            let _ = on_progress.send(progress);
        })
        .await?;
        tokio::fs::rename(&partial, &target)
            .await
            .map_err(|error| format!("无法保存已校验的安装包：{error}"))?;
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&partial).await;
        let _ = tokio::fs::remove_dir(&directory).await;
        return Err(error);
    }
    *state.checked.lock().await = Some(CheckedUpdate {
        downloaded: Some(target),
        ..checked
    });
    Ok(())
}

async fn verify_installer(path: &Path, asset: &ReleaseAsset) -> CommandResult<()> {
    let expected = expected_digest(asset)?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("无法读取安装包，请重新下载：{error}"))?;
    if file
        .metadata()
        .await
        .map_err(|error| error.to_string())?
        .len()
        != asset.size
    {
        return Err("安装包已发生变化，请重新检查更新并下载。".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65_536];
    loop {
        let size = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("无法校验安装包：{error}"))?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("安装包校验失败，请重新检查更新并下载。".into());
    }
    Ok(())
}

fn launch_installer(path: &Path) -> CommandResult<()> {
    #[cfg(target_os = "windows")]
    {
        let mut command = if path.extension().is_some_and(|extension| extension == "msi") {
            let mut command = Command::new("msiexec.exe");
            command.arg("/i").arg(path);
            command
        } else {
            Command::new(path)
        };
        command
            .spawn()
            .map_err(|error| format!("无法启动安装程序：{error}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open")
            .arg(path)
            .status()
            .map_err(|error| format!("无法打开安装包：{error}"))?;
        if !status.success() {
            return Err("无法打开安装包，请重新下载后重试。".into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
        Err("当前平台尚不支持应用内安装更新。".into())
    }
}

#[tauri::command]
pub(crate) async fn install_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> CommandResult<()> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "正在处理更新，请稍后再试。")?;
    let checked = state
        .checked
        .lock()
        .await
        .clone()
        .ok_or("请先检查更新并下载安装包。")?;
    let path = checked.downloaded.ok_or("请先完成安装包下载。")?;
    verify_installer(&path, &checked.asset).await?;
    tauri::async_runtime::spawn_blocking(move || launch_installer(&path))
        .await
        .map_err(|error| format!("启动安装程序失败：{error}"))??;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.into(),
            size: 100,
            browser_download_url: format!(
                "https://github.com/bilbilmyc/xsh/releases/download/v0.3.0/{name}"
            ),
            digest: Some(format!("sha256:{}", "ab".repeat(32))),
        }
    }

    fn release() -> Release {
        Release {
            tag_name: "v0.3.0".into(),
            body: Some("更新说明".into()),
            published_at: Some("2026-10-26T00:00:00Z".into()),
            draft: false,
            prerelease: false,
            assets: vec![
                asset("XSH_0.3.0_aarch64.dmg"),
                asset("XSH_0.3.0_x64_en-US.msi"),
                asset("XSH_0.3.0_x64-setup.exe"),
            ],
        }
    }

    #[test]
    fn versions_use_semantic_precedence_including_two_part_tags() {
        assert_eq!(parse_version("v0.2").unwrap(), Version::new(0, 2, 0));
        assert!(parse_version("v0.10.0").unwrap() > parse_version("0.9.9").unwrap());
        assert!(parse_version("0.3.0").unwrap() > parse_version("0.3.0-beta.1").unwrap());
        assert!(parse_version("latest").is_err());
        let (info, _) = release_info(
            &parse_version("0.3.0+local").unwrap(),
            Some(release()),
            "windows",
            "x86_64",
        )
        .unwrap();
        assert!(
            !info.available,
            "build metadata must not trigger a downgrade"
        );
    }

    #[test]
    fn chooses_matching_architecture_and_prefers_nsis_to_msi() {
        let (info, checked) =
            release_info(&Version::new(0, 2, 0), Some(release()), "windows", "x86_64").unwrap();
        assert!(info.available);
        assert_eq!(checked.unwrap().asset.name, "XSH_0.3.0_x64-setup.exe");
        let (_, checked) =
            release_info(&Version::new(0, 2, 0), Some(release()), "macos", "aarch64").unwrap();
        assert_eq!(checked.unwrap().asset.name, "XSH_0.3.0_aarch64.dmg");
        assert_eq!(
            asset_rank(
                "XSH_0.3.0_x64-setup.exe",
                &Version::new(0, 3, 0),
                "windows",
                "aarch64"
            ),
            None
        );
    }

    #[test]
    fn msi_and_universal_dmg_are_supported_fallbacks() {
        let mut windows = release();
        windows.assets.retain(|asset| asset.name.ends_with(".msi"));
        let (_, checked) =
            release_info(&Version::new(0, 2, 0), Some(windows), "windows", "x86_64").unwrap();
        assert!(checked.unwrap().asset.name.ends_with(".msi"));
        assert_eq!(
            asset_rank(
                "XSH_0.3.0_universal.dmg",
                &Version::new(0, 3, 0),
                "macos",
                "x86_64"
            ),
            Some(1)
        );
    }

    #[test]
    fn equal_or_older_releases_never_offer_an_installer() {
        for current in [Version::new(0, 3, 0), Version::new(0, 4, 0)] {
            let (info, checked) =
                release_info(&current, Some(release()), "windows", "x86_64").unwrap();
            assert!(!info.available);
            assert!(checked.is_none());
        }
        let (info, checked) =
            release_info(&Version::new(0, 2, 0), None, "windows", "x86_64").unwrap();
        assert_eq!(info.latest_version, None);
        assert!(checked.is_none());
    }

    #[test]
    fn missing_architecture_and_missing_digest_explain_unavailable_downloads() {
        let (info, checked) =
            release_info(&Version::new(0, 2, 0), Some(release()), "macos", "x86_64").unwrap();
        assert!(info.available);
        assert!(info.download_unavailable_reason.unwrap().contains("x86_64"));
        assert!(checked.is_none());
        let mut release = release();
        release
            .assets
            .iter_mut()
            .for_each(|asset| asset.digest = None);
        let (info, checked) =
            release_info(&Version::new(0, 2, 0), Some(release), "windows", "x86_64").unwrap();
        assert!(
            info.download_unavailable_reason
                .unwrap()
                .contains("SHA-256")
        );
        assert!(checked.is_none());
    }

    #[test]
    fn rejects_prereleases_and_drafts() {
        for (draft, prerelease, tag) in [
            (true, false, "v0.3.0"),
            (false, true, "v0.3.0"),
            (false, false, "v0.3.0-beta.1"),
        ] {
            let mut release = release();
            release.draft = draft;
            release.prerelease = prerelease;
            release.tag_name = tag.into();
            assert!(
                release_info(&Version::new(0, 2, 0), Some(release), "windows", "x86_64").is_err()
            );
        }
    }

    #[test]
    fn rejects_untrusted_urls_unsafe_names_and_invalid_digests() {
        let original = asset("XSH_0.3.0_x64-setup.exe");
        assert!(validate_asset(&original, "v0.3.0").is_ok());
        for url in [
            "http://github.com/bilbilmyc/xsh/releases/download/v0.3.0/XSH_0.3.0_x64-setup.exe",
            "https://github.com.evil.example/bilbilmyc/xsh/releases/download/v0.3.0/XSH_0.3.0_x64-setup.exe",
            "https://github.com/another/xsh/releases/download/v0.3.0/XSH_0.3.0_x64-setup.exe",
            "https://github.com/bilbilmyc/xsh/releases/download/v0.2.0/XSH_0.3.0_x64-setup.exe",
        ] {
            assert!(
                validate_asset(
                    &ReleaseAsset {
                        browser_download_url: url.into(),
                        ..original.clone()
                    },
                    "v0.3.0"
                )
                .is_err()
            );
        }
        for name in ["../setup.exe", "setup.exe:extra", "setup.exe/extra"] {
            assert!(validate_asset(&asset(name), "v0.3.0").is_err());
        }
        for digest in [
            None,
            Some("sha256:abc".into()),
            Some(format!("sha256:{}", "zz".repeat(32))),
        ] {
            assert!(
                validate_asset(
                    &ReleaseAsset {
                        digest,
                        ..original.clone()
                    },
                    "v0.3.0"
                )
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn verifies_downloaded_file_again_before_installing() {
        let path = std::env::temp_dir().join(format!("xsh-update-test-{}", uuid::Uuid::new_v4()));
        let contents = b"verified installer";
        let mut asset = asset("XSH_0.3.0_x64-setup.exe");
        asset.size = contents.len() as u64;
        asset.digest = Some(format!("sha256:{:x}", Sha256::digest(contents)));
        tokio::fs::write(&path, contents).await.unwrap();
        assert!(verify_installer(&path, &asset).await.is_ok());
        tokio::fs::write(&path, b"modified installer")
            .await
            .unwrap();
        assert!(verify_installer(&path, &asset).await.is_err());
        tokio::fs::write(&path, b"short").await.unwrap();
        assert!(verify_installer(&path, &asset).await.is_err());
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn streamed_download_rejects_corruption_truncation_and_excess_data() {
        let contents = b"verified installer";
        for (size, valid_digest, succeeds) in [
            (contents.len() as u64, true, true),
            (contents.len() as u64, false, false),
            (contents.len() as u64 + 1, true, false),
            (contents.len() as u64 - 1, true, false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                    assert!(request.len() <= 4096);
                }
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            contents.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(contents).await.unwrap();
            });
            let response = Client::new()
                .get(format!("http://{address}/installer"))
                .send()
                .await
                .unwrap();
            let path =
                std::env::temp_dir().join(format!("xsh-download-test-{}", uuid::Uuid::new_v4()));
            let mut asset = asset("XSH_0.3.0_x64-setup.exe");
            asset.size = size;
            if valid_digest {
                asset.digest = Some(format!("sha256:{:x}", Sha256::digest(contents)));
            }
            let result = save_download(response, &asset, &path, |_| {}).await;
            assert_eq!(result.is_ok(), succeeds, "{result:?}");
            tokio::fs::remove_file(path).await.unwrap();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "downloads the current official installer; run explicitly to verify GitHub connectivity"]
    async fn downloads_and_verifies_official_release() {
        let client = client().unwrap();
        let release = client
            .get(LATEST_RELEASE_URL)
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Release>()
            .await
            .unwrap();
        let (info, checked) = release_info(
            &Version::new(0, 0, 0),
            Some(release),
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
        .unwrap();
        let checked =
            checked.expect("official release must include a verified installer for this platform");
        let response = client
            .get(&checked.asset.browser_download_url)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let path =
            std::env::temp_dir().join(format!("xsh-live-update-test-{}", uuid::Uuid::new_v4()));
        let result = save_download(response, &checked.asset, &path, |_| {}).await;
        let verified = if result.is_ok() {
            verify_installer(&path, &checked.asset).await
        } else {
            result
        };
        let _ = tokio::fs::remove_file(path).await;
        verified.unwrap();
        println!(
            "Verified official release v{}: {} ({} bytes)",
            info.latest_version.unwrap(),
            checked.asset.name,
            checked.asset.size
        );
    }
}
