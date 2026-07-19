use std::path::PathBuf;
use xsh_security::{CredentialKind, CredentialStore, LocalCredentialStore};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("xsh.sqlite3"));
    let key = database.with_file_name("xsh-vault.key");
    let store = LocalCredentialStore::open(&database, &key)?;
    let reference = store.create(CredentialKind::Password, "probe")?;
    assert_eq!(store.get(&reference)?.as_str(), "probe");
    store.delete(&reference)?;
    println!("XSH local credential database probe passed");
    Ok(())
}
