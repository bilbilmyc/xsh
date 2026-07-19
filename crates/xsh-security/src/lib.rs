use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::Argon2;
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, params};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use uuid::Uuid;
use zeroize::Zeroizing;

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const BACKUP_SALT_BYTES: usize = 16;
const BACKUP_MAGIC: &[u8] = b"XSHBACK1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialKind {
    Password,
    PrivateKeyPassphrase,
    KeyboardInteractive,
}

impl CredentialKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKeyPassphrase => "key-passphrase",
            Self::KeyboardInteractive => "keyboard-interactive",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("credential database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("credential file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("credential encryption error: {0}")]
    Crypto(String),
    #[error("credential store lock was poisoned")]
    Poisoned,
    #[error("credential not found: {0}")]
    NotFound(String),
    #[error("credential encryption key must be exactly 32 bytes")]
    InvalidKey,
    #[error("invalid XSH credential backup format")]
    InvalidBackupFormat,
    #[error("credential backup password is incorrect or backup is corrupted")]
    InvalidBackupPassword,
}

pub type Result<T> = std::result::Result<T, CredentialError>;

pub trait CredentialStore: Send + Sync {
    fn create(&self, kind: CredentialKind, secret: &str) -> Result<String>;
    fn set(&self, credential_ref: &str, secret: &str) -> Result<()>;
    fn get(&self, credential_ref: &str) -> Result<Zeroizing<String>>;
    fn delete(&self, credential_ref: &str) -> Result<()>;
}

/// XSH-owned credential vault.
///
/// Secrets are stored in XSH's SQLite database as AES-256-GCM ciphertext. The
/// encryption key is generated once and stored in a separate XSH data file,
/// never in the operating system credential manager. This keeps the app silent
/// on reconnect while avoiding plaintext passwords in the database.
#[derive(Debug)]
pub struct LocalCredentialStore {
    connection: Mutex<Connection>,
    encryption_key: Zeroizing<[u8; KEY_BYTES]>,
    key_path: PathBuf,
    database_path: PathBuf,
}

impl LocalCredentialStore {
    pub fn open(database_path: impl AsRef<Path>, key_path: impl AsRef<Path>) -> Result<Self> {
        let key_path = key_path.as_ref().to_owned();
        let database_path = database_path.as_ref().to_owned();
        let encryption_key = load_or_create_key(&key_path)?;
        let connection = Connection::open(&database_path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS xsh_credentials (
                 credential_ref TEXT PRIMARY KEY NOT NULL,
                 kind TEXT NOT NULL,
                 nonce BLOB NOT NULL,
                 ciphertext BLOB NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_xsh_credentials_kind
                 ON xsh_credentials(kind);",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
            encryption_key,
            key_path,
            database_path,
        })
    }

    pub fn key_path(&self) -> &Path {
        &self.key_path
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Export all XSH credentials into a password-protected backup. The backup
    /// contains decrypted secrets only inside the authenticated ciphertext and
    /// never writes the vault key or plaintext SQLite database to disk.
    pub fn export_backup(&self, password: &str) -> Result<Vec<u8>> {
        if password.trim().is_empty() {
            return Err(CredentialError::InvalidBackupPassword);
        }
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT credential_ref, kind, nonce, ciphertext FROM xsh_credentials ORDER BY credential_ref",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })?;
        let mut credentials = Vec::new();
        for row in rows {
            let (credential_ref, kind, nonce, ciphertext) = row?;
            let secret = self.decrypt(&credential_ref, &nonce, &ciphertext)?;
            credentials.push(BackupCredential {
                credential_ref,
                kind,
                secret: secret.to_string(),
            });
        }
        drop(statement);
        drop(connection);
        let payload = serde_json::to_vec(&BackupPayload {
            format: "xsh-credential-backup".into(),
            schema_version: 1,
            created_at: chrono::Utc::now().to_rfc3339(),
            credentials,
        })
        .map_err(|error| CredentialError::Crypto(format!("无法编码凭据备份：{error}")))?;
        encrypt_backup_payload(password, &payload)
    }

    /// Merge credentials from a password-protected backup into the current
    /// XSH vault. Existing references are updated in place, preserving saved
    /// sessions without exposing secrets to the UI.
    pub fn import_backup(&self, backup: &[u8], password: &str) -> Result<usize> {
        let payload = decrypt_backup_payload(password, backup)?;
        if payload.format != "xsh-credential-backup" || payload.schema_version != 1 {
            return Err(CredentialError::InvalidBackupFormat);
        }
        let mut imported = 0;
        for credential in payload.credentials {
            if credential.secret.is_empty() || credential.credential_ref.trim().is_empty() {
                continue;
            }
            let (nonce, ciphertext) = self.encrypt(&credential.secret)?;
            let now = chrono::Utc::now().to_rfc3339();
            let connection = self.connection()?;
            connection.execute(
                "INSERT INTO xsh_credentials
                 (credential_ref, kind, nonce, ciphertext, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(credential_ref) DO UPDATE SET
                   kind = excluded.kind, nonce = excluded.nonce,
                   ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
                params![
                    credential.credential_ref,
                    credential.kind,
                    nonce.as_slice(),
                    ciphertext,
                    now
                ],
            )?;
            imported += 1;
        }
        Ok(imported)
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| CredentialError::Poisoned)
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(self.encryption_key.as_ref()))
    }

    fn encrypt(&self, secret: &str) -> Result<([u8; NONCE_BYTES], Vec<u8>)> {
        let mut nonce = [0_u8; NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = self
            .cipher()
            .encrypt(Nonce::from_slice(&nonce), secret.as_bytes())
            .map_err(|_| CredentialError::Crypto("无法加密凭据".to_owned()))?;
        Ok((nonce, ciphertext))
    }

    fn decrypt(
        &self,
        credential_ref: &str,
        nonce: &[u8],
        ciphertext: &[u8],
    ) -> Result<Zeroizing<String>> {
        if nonce.len() != NONCE_BYTES {
            return Err(CredentialError::Crypto(format!(
                "凭据“{credential_ref}”的随机数长度无效"
            )));
        }
        let plaintext = self
            .cipher()
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|_| CredentialError::Crypto(format!("无法解密凭据“{credential_ref}”")))?;
        let value = String::from_utf8(plaintext)
            .map_err(|error| CredentialError::Crypto(format!("凭据不是有效文本：{error}")))?;
        if value.is_empty() {
            return Err(CredentialError::NotFound(credential_ref.to_owned()));
        }
        Ok(Zeroizing::new(value))
    }
}

impl CredentialStore for LocalCredentialStore {
    fn create(&self, kind: CredentialKind, secret: &str) -> Result<String> {
        let credential_ref = format!("xsh-local/{}/{}", kind.as_str(), Uuid::new_v4());
        self.set(&credential_ref, secret)?;
        Ok(credential_ref)
    }

    fn set(&self, credential_ref: &str, secret: &str) -> Result<()> {
        if secret.is_empty() {
            return Err(CredentialError::Crypto(
                "credential must not be empty".to_owned(),
            ));
        }
        let (nonce, ciphertext) = self.encrypt(secret)?;
        let now = chrono::Utc::now().to_rfc3339();
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO xsh_credentials
             (credential_ref, kind, nonce, ciphertext, created_at, updated_at)
             VALUES (?1, COALESCE((SELECT kind FROM xsh_credentials WHERE credential_ref = ?1), 'unknown'), ?2, ?3, ?4, ?4)
             ON CONFLICT(credential_ref) DO UPDATE SET
               nonce = excluded.nonce,
               ciphertext = excluded.ciphertext,
               updated_at = excluded.updated_at",
            params![credential_ref, nonce.as_slice(), ciphertext, now],
        )?;
        Ok(())
    }

    fn get(&self, credential_ref: &str) -> Result<Zeroizing<String>> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT nonce, ciphertext FROM xsh_credentials WHERE credential_ref = ?1",
                params![credential_ref],
                |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()?;
        let Some((nonce, ciphertext)) = row else {
            return Err(CredentialError::NotFound(credential_ref.to_owned()));
        };
        drop(connection);
        self.decrypt(credential_ref, &nonce, &ciphertext)
    }

    fn delete(&self, credential_ref: &str) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "DELETE FROM xsh_credentials WHERE credential_ref = ?1",
            params![credential_ref],
        )?;
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct MemoryCredentialStore {
    secrets: Arc<Mutex<std::collections::HashMap<String, String>>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn create(&self, kind: CredentialKind, secret: &str) -> Result<String> {
        let credential_ref = format!("xsh-memory/{}/{}", kind.as_str(), Uuid::new_v4());
        self.set(&credential_ref, secret)?;
        Ok(credential_ref)
    }

    fn set(&self, credential_ref: &str, secret: &str) -> Result<()> {
        self.secrets
            .lock()
            .map_err(|_| CredentialError::Poisoned)?
            .insert(credential_ref.to_owned(), secret.to_owned());
        Ok(())
    }

    fn get(&self, credential_ref: &str) -> Result<Zeroizing<String>> {
        self.secrets
            .lock()
            .map_err(|_| CredentialError::Poisoned)?
            .get(credential_ref)
            .cloned()
            .map(Zeroizing::new)
            .ok_or_else(|| CredentialError::NotFound(credential_ref.to_owned()))
    }

    fn delete(&self, credential_ref: &str) -> Result<()> {
        self.secrets
            .lock()
            .map_err(|_| CredentialError::Poisoned)?
            .remove(credential_ref)
            .map(|_| ())
            .ok_or_else(|| CredentialError::NotFound(credential_ref.to_owned()))
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct BackupPayload {
    format: String,
    schema_version: u32,
    created_at: String,
    credentials: Vec<BackupCredential>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct BackupCredential {
    credential_ref: String,
    kind: String,
    secret: String,
}

fn derive_backup_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_BYTES]> {
    let mut key = [0_u8; KEY_BYTES];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| CredentialError::Crypto(format!("无法派生备份密钥：{error}")))?;
    Ok(key)
}

fn encrypt_backup_payload(password: &str, payload: &[u8]) -> Result<Vec<u8>> {
    let mut salt = [0_u8; BACKUP_SALT_BYTES];
    let mut nonce = [0_u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = derive_backup_key(password, &salt)?;
    let ciphertext = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
        .encrypt(Nonce::from_slice(&nonce), payload)
        .map_err(|_| CredentialError::Crypto("无法加密凭据备份".into()))?;
    let mut output = Vec::with_capacity(
        BACKUP_MAGIC.len() + 1 + BACKUP_SALT_BYTES + NONCE_BYTES + ciphertext.len(),
    );
    output.extend_from_slice(BACKUP_MAGIC);
    output.push(1);
    output.extend_from_slice(&salt);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

fn decrypt_backup_payload(password: &str, backup: &[u8]) -> Result<BackupPayload> {
    let header_len = BACKUP_MAGIC.len() + 1 + BACKUP_SALT_BYTES + NONCE_BYTES;
    if backup.len() <= header_len
        || &backup[..BACKUP_MAGIC.len()] != BACKUP_MAGIC
        || backup[BACKUP_MAGIC.len()] != 1
    {
        return Err(CredentialError::InvalidBackupFormat);
    }
    let salt_start = BACKUP_MAGIC.len() + 1;
    let nonce_start = salt_start + BACKUP_SALT_BYTES;
    let key = derive_backup_key(password, &backup[salt_start..nonce_start])?;
    let plaintext = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
        .decrypt(
            Nonce::from_slice(&backup[nonce_start..header_len]),
            &backup[header_len..],
        )
        .map_err(|_| CredentialError::InvalidBackupPassword)?;
    serde_json::from_slice(&plaintext).map_err(|_| CredentialError::InvalidBackupPassword)
}

fn load_or_create_key(path: &Path) -> Result<Zeroizing<[u8; KEY_BYTES]>> {
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() != KEY_BYTES {
                return Err(CredentialError::InvalidKey);
            }
            let mut key = [0_u8; KEY_BYTES];
            key.copy_from_slice(&bytes);
            return Ok(Zeroizing::new(key));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let mut key = [0_u8; KEY_BYTES];
    OsRng.fill_bytes(&mut key);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(&key)?;
            file.sync_all()?;
            Ok(Zeroizing::new(key))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => load_or_create_key(path),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(label: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("xsh-security-{label}-{}", Uuid::new_v4()));
        (root.join("credentials.sqlite3"), root.join("vault.key"))
    }

    #[test]
    fn local_store_round_trips_encrypted_secret() {
        let (database, key) = temp_paths("round-trip");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let store = LocalCredentialStore::open(&database, &key).unwrap();
        let reference = store
            .create(CredentialKind::Password, "correct horse battery staple")
            .unwrap();
        assert!(reference.starts_with("xsh-local/password/"));
        assert_eq!(
            store.get(&reference).unwrap().as_str(),
            "correct horse battery staple"
        );
        let raw = fs::read(&database).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("correct horse battery staple"));
        drop(store);
        fs::remove_dir_all(database.parent().unwrap()).unwrap();
    }

    #[test]
    fn local_store_survives_reopen_and_deletes() {
        let (database, key) = temp_paths("reopen");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let reference = {
            let store = LocalCredentialStore::open(&database, &key).unwrap();
            store
                .create(CredentialKind::PrivateKeyPassphrase, "secret")
                .unwrap()
        };
        let store = LocalCredentialStore::open(&database, &key).unwrap();
        assert_eq!(store.get(&reference).unwrap().as_str(), "secret");
        store.delete(&reference).unwrap();
        assert!(matches!(
            store.get(&reference),
            Err(CredentialError::NotFound(_))
        ));
        drop(store);
        fs::remove_dir_all(database.parent().unwrap()).unwrap();
    }

    #[test]
    fn memory_store_uses_opaque_references() {
        let store = MemoryCredentialStore::default();
        let reference = store
            .create(CredentialKind::Password, "correct horse battery staple")
            .unwrap();
        assert!(reference.starts_with("xsh-memory/password/"));
        assert!(!reference.contains("correct"));
        assert_eq!(
            store.get(&reference).unwrap().as_str(),
            "correct horse battery staple"
        );
    }

    #[test]
    fn backup_round_trips_and_preserves_reference() {
        let (database, key) = temp_paths("backup-round-trip");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let store = LocalCredentialStore::open(&database, &key).unwrap();
        let reference = store
            .create(CredentialKind::Password, "backup-secret")
            .unwrap();
        let backup = store.export_backup("backup-password").unwrap();
        assert!(backup.starts_with(BACKUP_MAGIC));
        assert!(!String::from_utf8_lossy(&backup).contains("backup-secret"));

        store.delete(&reference).unwrap();
        assert!(matches!(
            store.get(&reference),
            Err(CredentialError::NotFound(_))
        ));
        let imported = store.import_backup(&backup, "backup-password").unwrap();
        assert_eq!(imported, 1);
        assert_eq!(store.get(&reference).unwrap().as_str(), "backup-secret");
        drop(store);
        fs::remove_dir_all(database.parent().unwrap()).unwrap();
    }

    #[test]
    fn backup_rejects_wrong_password_and_tampering() {
        let (database, key) = temp_paths("backup-errors");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let store = LocalCredentialStore::open(&database, &key).unwrap();
        store
            .create(CredentialKind::Password, "backup-secret")
            .unwrap();
        let backup = store.export_backup("backup-password").unwrap();
        assert!(matches!(
            store.import_backup(&backup, "wrong-password"),
            Err(CredentialError::InvalidBackupPassword)
        ));
        let mut tampered = backup.clone();
        *tampered.last_mut().unwrap() ^= 0x01;
        assert!(matches!(
            store.import_backup(&tampered, "backup-password"),
            Err(CredentialError::InvalidBackupPassword)
        ));
        drop(store);
        fs::remove_dir_all(database.parent().unwrap()).unwrap();
    }

    #[test]
    fn memory_store_delete_removes_secret() {
        let store = MemoryCredentialStore::default();
        let reference = store.create(CredentialKind::Password, "secret").unwrap();
        store.delete(&reference).unwrap();
        assert!(matches!(
            store.get(&reference),
            Err(CredentialError::NotFound(_))
        ));
    }
}
