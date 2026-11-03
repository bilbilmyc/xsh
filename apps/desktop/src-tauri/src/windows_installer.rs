use std::path::Path;
use std::process::Command;

pub(crate) fn command(path: &Path) -> Command {
    if path.extension().is_some_and(|extension| extension == "msi") {
        let mut command = Command::new("msiexec.exe");
        command.arg("/i").arg(path).arg("/norestart");
        command
    } else {
        let mut command = Command::new(path);
        // 保留可见进度，跳过旧 NSIS 卸载，仅在成功后重新打开应用。
        // 安装路径由 NSIS 从原安装注册表恢复，避免 /D 的特殊引号规则。
        command.args(["/UPDATE", "/P", "/R"]);
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn nsis_upgrade_is_in_place_visible_and_restarts_only_on_success() {
        let installer = Path::new(r"C:\更新缓存\XSH_0.2.4_x64-setup.exe");
        let command = command(installer);
        assert_eq!(command.get_program(), installer.as_os_str());
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["/UPDATE", "/P", "/R"]);
        assert!(
            !args.contains(&std::ffi::OsStr::new("/S")),
            "progress must remain visible"
        );
    }

    #[test]
    fn msi_fallback_keeps_completion_ui_without_forcing_a_machine_reboot() {
        let installer = Path::new(r"C:\更新缓存\XSH_0.2.4_x64_en-US.msi");
        let command = command(installer);
        assert_eq!(command.get_program(), "msiexec.exe");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsString::from("/i"),
                installer.as_os_str().to_owned(),
                OsString::from("/norestart"),
            ]
        );
    }
}
