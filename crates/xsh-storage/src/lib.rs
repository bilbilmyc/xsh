use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use uuid::Uuid;
use xsh_domain::{
    AuthenticationMethod, GroupId, KnownHost, SavedSession, SessionBundle, SessionDraft,
    SessionGroup, SessionGroupDraft, SessionId, TerminalProfile,
};

const INITIAL_MIGRATION: &str = include_str!("../migrations/0001_initial.sql");

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("invalid UUID in database: {0}")]
    InvalidUuid(#[from] uuid::Error),
    #[error("invalid timestamp in database: {0}")]
    InvalidTimestamp(#[from] chrono::ParseError),
    #[error("storage lock was poisoned")]
    Poisoned,
    #[error("session not found: {0}")]
    SessionNotFound(SessionId),
    #[error("session group not found: {0}")]
    GroupNotFound(GroupId),
}

pub type Result<T> = std::result::Result<T, StorageError>;

pub struct SessionRepository {
    connection: Mutex<Connection>,
}

impl SessionRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self> {
        connection.execute_batch(INITIAL_MIGRATION)?;
        ensure_proxy_jump_columns(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| StorageError::Poisoned)
    }

    pub fn list_groups(&self) -> Result<Vec<SessionGroup>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, parent_id, name, color, sort_order, created_at, updated_at
             FROM session_groups ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
        )?;
        statement
            .query_map([], map_group)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn create_group(&self, draft: SessionGroupDraft) -> Result<SessionGroup> {
        let now = Utc::now();
        let group = SessionGroup {
            id: Uuid::new_v4(),
            parent_id: draft.parent_id,
            name: draft.name.trim().to_owned(),
            color: draft.color,
            sort_order: draft.sort_order,
            created_at: now,
            updated_at: now,
        };
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO session_groups
             (id, parent_id, name, color, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                group.id.to_string(),
                group.parent_id.map(|id| id.to_string()),
                group.name,
                group.color,
                group.sort_order,
                group.created_at.to_rfc3339(),
                group.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(group)
    }

    pub fn update_group(&self, id: GroupId, draft: SessionGroupDraft) -> Result<SessionGroup> {
        let updated_at = Utc::now();
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE session_groups SET parent_id = ?2, name = ?3, color = ?4,
             sort_order = ?5, updated_at = ?6 WHERE id = ?1",
            params![
                id.to_string(),
                draft.parent_id.map(|value| value.to_string()),
                draft.name.trim(),
                draft.color,
                draft.sort_order,
                updated_at.to_rfc3339(),
            ],
        )?;
        if changed == 0 {
            return Err(StorageError::GroupNotFound(id));
        }
        drop(connection);
        self.get_group(id)?.ok_or(StorageError::GroupNotFound(id))
    }

    pub fn delete_group(&self, id: GroupId) -> Result<Vec<SavedSession>> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let group_id = id.to_string();
        let mut sessions = {
            let mut statement = transaction.prepare(
                "WITH RECURSIVE descendants(id) AS (
                   SELECT ?1
                   UNION ALL
                   SELECT session_groups.id
                   FROM session_groups
                   JOIN descendants ON session_groups.parent_id = descendants.id
                 )
                 SELECT id, group_id, name, host, port, username, proxy_jump, proxy_jump_username,
                 proxy_jump_authentication_json, authentication_json, terminal_json, initial_directory, startup_command,
                 keepalive_seconds, auto_reconnect,
                 environment, color, notes, favorite, created_at, updated_at
                 FROM sessions
                 WHERE group_id IN (SELECT id FROM descendants)
                 ORDER BY favorite DESC, name COLLATE NOCASE ASC",
            )?;
            statement
                .query_map(params![group_id], map_session_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };

        for session in &mut sessions {
            *session = self.attach_tags_with_connection(&transaction, session.clone())?;
        }

        transaction.execute(
            "WITH RECURSIVE descendants(id) AS (
               SELECT ?1
               UNION ALL
               SELECT session_groups.id
               FROM session_groups
               JOIN descendants ON session_groups.parent_id = descendants.id
             )
             DELETE FROM sessions WHERE group_id IN (SELECT id FROM descendants)",
            params![group_id],
        )?;
        let changed = transaction.execute(
            "DELETE FROM session_groups WHERE id = ?1",
            params![group_id],
        )?;
        if changed == 0 {
            return Err(StorageError::GroupNotFound(id));
        }
        transaction.commit()?;
        Ok(sessions)
    }

    pub fn get_group(&self, id: GroupId) -> Result<Option<SessionGroup>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, parent_id, name, color, sort_order, created_at, updated_at
                 FROM session_groups WHERE id = ?1",
                params![id.to_string()],
                map_group,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn list_sessions(&self) -> Result<Vec<SavedSession>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, group_id, name, host, port, username, proxy_jump, proxy_jump_username,
             proxy_jump_authentication_json, authentication_json, terminal_json, initial_directory, startup_command,
             keepalive_seconds, auto_reconnect,
             environment, color, notes, favorite, created_at, updated_at
             FROM sessions ORDER BY favorite DESC, name COLLATE NOCASE ASC",
        )?;
        let raw = statement
            .query_map([], map_session_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        raw.into_iter()
            .map(|row| self.attach_tags_with_connection(&connection, row))
            .collect()
    }

    pub fn get_session(&self, id: SessionId) -> Result<Option<SavedSession>> {
        let connection = self.connection()?;
        let raw = connection
            .query_row(
                "SELECT id, group_id, name, host, port, username, proxy_jump, proxy_jump_username,
                 proxy_jump_authentication_json, authentication_json, terminal_json, initial_directory, startup_command,
                 keepalive_seconds, auto_reconnect,
                 environment, color, notes, favorite, created_at, updated_at
                 FROM sessions WHERE id = ?1",
                params![id.to_string()],
                map_session_row,
            )
            .optional()?;
        raw.map(|row| self.attach_tags_with_connection(&connection, row))
            .transpose()
    }

    pub fn create_session(&self, draft: SessionDraft) -> Result<SavedSession> {
        let now = Utc::now();
        let session = SavedSession {
            id: Uuid::new_v4(),
            group_id: draft.group_id,
            name: draft.name.trim().to_owned(),
            host: draft.host.trim().to_owned(),
            port: draft.port,
            username: draft.username.trim().to_owned(),
            proxy_jump: draft.proxy_jump,
            proxy_jump_username: draft.proxy_jump_username,
            proxy_jump_authentication: draft.proxy_jump_authentication,
            authentication: draft.authentication,
            terminal: draft.terminal,
            initial_directory: draft.initial_directory,
            startup_command: draft.startup_command,
            keepalive_seconds: draft.keepalive_seconds,
            auto_reconnect: draft.auto_reconnect,
            environment: draft.environment,
            color: draft.color,
            notes: draft.notes,
            tags: normalize_tags(draft.tags),
            favorite: draft.favorite,
            created_at: now,
            updated_at: now,
        };
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        insert_session(&transaction, &session)?;
        replace_tags(&transaction, session.id, &session.tags)?;
        transaction.commit()?;
        Ok(session)
    }

    pub fn update_session(&self, id: SessionId, draft: SessionDraft) -> Result<SavedSession> {
        let existing = self
            .get_session(id)?
            .ok_or(StorageError::SessionNotFound(id))?;
        let session = SavedSession {
            id,
            group_id: draft.group_id,
            name: draft.name.trim().to_owned(),
            host: draft.host.trim().to_owned(),
            port: draft.port,
            username: draft.username.trim().to_owned(),
            proxy_jump: draft.proxy_jump,
            proxy_jump_username: draft.proxy_jump_username,
            proxy_jump_authentication: draft.proxy_jump_authentication,
            authentication: draft.authentication,
            terminal: draft.terminal,
            initial_directory: draft.initial_directory,
            startup_command: draft.startup_command,
            keepalive_seconds: draft.keepalive_seconds,
            auto_reconnect: draft.auto_reconnect,
            environment: draft.environment,
            color: draft.color,
            notes: draft.notes,
            tags: normalize_tags(draft.tags),
            favorite: draft.favorite,
            created_at: existing.created_at,
            updated_at: Utc::now(),
        };
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE sessions SET group_id = ?2, name = ?3, host = ?4, port = ?5,
             username = ?6, proxy_jump = ?7, proxy_jump_username = ?8,
             proxy_jump_authentication_json = ?9, authentication_json = ?10, terminal_json = ?11,
             initial_directory = ?12, startup_command = ?13, keepalive_seconds = ?14, auto_reconnect = ?15,
             environment = ?16, color = ?17, notes = ?18, favorite = ?19,
             updated_at = ?20 WHERE id = ?1",
            session_params(&session),
        )?;
        if changed == 0 {
            return Err(StorageError::SessionNotFound(id));
        }
        replace_tags(&transaction, id, &session.tags)?;
        transaction.commit()?;
        Ok(session)
    }

    pub fn delete_session(&self, id: SessionId) -> Result<()> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "DELETE FROM sessions WHERE id = ?1",
            params![id.to_string()],
        )?;
        if changed == 0 {
            return Err(StorageError::SessionNotFound(id));
        }
        Ok(())
    }

    pub fn find_known_host(&self, host: &str, port: u16) -> Result<Option<KnownHost>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT host, port, key_type, fingerprint, public_key, first_seen, last_seen
                 FROM known_hosts WHERE host = ?1 AND port = ?2",
                params![host, port],
                |row| {
                    Ok(KnownHost {
                        host: row.get(0)?,
                        port: row.get(1)?,
                        key_type: row.get(2)?,
                        fingerprint: row.get(3)?,
                        public_key: row.get(4)?,
                        first_seen: parse_datetime(row.get::<_, String>(5)?)?,
                        last_seen: parse_datetime(row.get::<_, String>(6)?)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn delete_known_host(&self, host: &str, port: u16) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "DELETE FROM known_hosts WHERE host = ?1 AND port = ?2",
            params![host, port],
        )?;
        Ok(())
    }

    pub fn save_known_host(&self, host: KnownHost) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO known_hosts
             (host, port, key_type, fingerprint, public_key, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(host, port) DO UPDATE SET
               key_type = excluded.key_type,
               fingerprint = excluded.fingerprint,
               public_key = excluded.public_key,
               last_seen = excluded.last_seen",
            params![
                host.host,
                host.port,
                host.key_type,
                host.fingerprint,
                host.public_key,
                host.first_seen.to_rfc3339(),
                host.last_seen.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn export_bundle(&self, include_known_hosts: bool) -> Result<SessionBundle> {
        let mut bundle = SessionBundle::new(self.list_groups()?, self.list_sessions()?);
        if include_known_hosts {
            bundle.known_hosts = self.list_known_hosts()?;
        }
        Ok(bundle)
    }

    pub fn list_known_hosts(&self) -> Result<Vec<KnownHost>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT host, port, key_type, fingerprint, public_key, first_seen, last_seen
             FROM known_hosts ORDER BY host COLLATE NOCASE ASC, port ASC",
        )?;
        statement
            .query_map([], |row| {
                Ok(KnownHost {
                    host: row.get(0)?,
                    port: row.get(1)?,
                    key_type: row.get(2)?,
                    fingerprint: row.get(3)?,
                    public_key: row.get(4)?,
                    first_seen: parse_datetime(row.get::<_, String>(5)?)?,
                    last_seen: parse_datetime(row.get::<_, String>(6)?)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    fn attach_tags_with_connection(
        &self,
        connection: &Connection,
        mut session: SavedSession,
    ) -> Result<SavedSession> {
        let mut statement = connection.prepare(
            "SELECT tag FROM session_tags WHERE session_id = ?1 ORDER BY tag COLLATE NOCASE ASC",
        )?;
        session.tags = statement
            .query_map(params![session.id.to_string()], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(session)
    }
}

fn map_group(row: &Row<'_>) -> rusqlite::Result<SessionGroup> {
    Ok(SessionGroup {
        id: parse_uuid(row.get::<_, String>(0)?)?,
        parent_id: row
            .get::<_, Option<String>>(1)?
            .map(parse_uuid)
            .transpose()?,
        name: row.get(2)?,
        color: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: parse_datetime(row.get::<_, String>(5)?)?,
        updated_at: parse_datetime(row.get::<_, String>(6)?)?,
    })
}

fn map_session_row(row: &Row<'_>) -> rusqlite::Result<SavedSession> {
    let authentication_json: String = row.get(9)?;
    let terminal_json: String = row.get(10)?;
    Ok(SavedSession {
        id: parse_uuid(row.get::<_, String>(0)?)?,
        group_id: row
            .get::<_, Option<String>>(1)?
            .map(parse_uuid)
            .transpose()?,
        name: row.get(2)?,
        host: row.get(3)?,
        port: row.get(4)?,
        username: row.get(5)?,
        proxy_jump: row.get(6)?,
        proxy_jump_username: row.get(7)?,
        proxy_jump_authentication: row
            .get::<_, Option<String>>(8)?
            .map(|value| serde_json::from_str::<AuthenticationMethod>(&value).map_err(to_sql_error))
            .transpose()?,
        authentication: serde_json::from_str::<AuthenticationMethod>(&authentication_json)
            .map_err(to_sql_error)?,
        terminal: serde_json::from_str::<TerminalProfile>(&terminal_json).map_err(to_sql_error)?,
        initial_directory: row.get(11)?,
        startup_command: row.get(12)?,
        keepalive_seconds: row.get::<_, i64>(13)? as u64,
        auto_reconnect: row.get(14)?,
        environment: row.get(15)?,
        color: row.get(16)?,
        notes: row.get(17)?,
        favorite: row.get(18)?,
        tags: Vec::new(),
        created_at: parse_datetime(row.get::<_, String>(19)?)?,
        updated_at: parse_datetime(row.get::<_, String>(20)?)?,
    })
}

fn insert_session(connection: &Connection, session: &SavedSession) -> Result<()> {
    connection.execute(
        "INSERT INTO sessions
         (id, group_id, name, host, port, username, proxy_jump, proxy_jump_username,
          proxy_jump_authentication_json, authentication_json, terminal_json, initial_directory, startup_command,
          keepalive_seconds, auto_reconnect, environment, color, notes, favorite, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            session.id.to_string(),
            session.group_id.map(|id| id.to_string()),
            session.name,
            session.host,
            session.port,
            session.username,
            session.proxy_jump,
            session.proxy_jump_username,
            session
                .proxy_jump_authentication
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            serde_json::to_string(&session.authentication)?,
            serde_json::to_string(&session.terminal)?,
            session.initial_directory,
            session.startup_command,
            session.keepalive_seconds as i64,
            session.auto_reconnect,
            session.environment,
            session.color,
            session.notes,
            session.favorite,
            session.created_at.to_rfc3339(),
            session.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn session_params(session: &SavedSession) -> [rusqlite::types::Value; 20] {
    use rusqlite::types::Value;
    [
        Value::Text(session.id.to_string()),
        session
            .group_id
            .map(|id| Value::Text(id.to_string()))
            .unwrap_or(Value::Null),
        Value::Text(session.name.clone()),
        Value::Text(session.host.clone()),
        Value::Integer(session.port.into()),
        Value::Text(session.username.clone()),
        session
            .proxy_jump
            .clone()
            .map(Value::Text)
            .unwrap_or(Value::Null),
        session
            .proxy_jump_username
            .clone()
            .map(Value::Text)
            .unwrap_or(Value::Null),
        session
            .proxy_jump_authentication
            .as_ref()
            .map(|auth| Value::Text(serde_json::to_string(auth).expect("serializable proxy auth")))
            .unwrap_or(Value::Null),
        Value::Text(serde_json::to_string(&session.authentication).expect("serializable auth")),
        Value::Text(serde_json::to_string(&session.terminal).expect("serializable terminal")),
        session
            .initial_directory
            .clone()
            .map(Value::Text)
            .unwrap_or(Value::Null),
        session
            .startup_command
            .clone()
            .map(Value::Text)
            .unwrap_or(Value::Null),
        Value::Integer(session.keepalive_seconds as i64),
        Value::Integer(i64::from(session.auto_reconnect)),
        session
            .environment
            .clone()
            .map(Value::Text)
            .unwrap_or(Value::Null),
        session
            .color
            .clone()
            .map(Value::Text)
            .unwrap_or(Value::Null),
        session
            .notes
            .clone()
            .map(Value::Text)
            .unwrap_or(Value::Null),
        Value::Integer(i64::from(session.favorite)),
        Value::Text(session.updated_at.to_rfc3339()),
    ]
}

fn ensure_proxy_jump_columns(connection: &Connection) -> Result<()> {
    let columns = connection
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (name, definition) in [
        (
            "proxy_jump",
            "ALTER TABLE sessions ADD COLUMN proxy_jump TEXT",
        ),
        (
            "proxy_jump_username",
            "ALTER TABLE sessions ADD COLUMN proxy_jump_username TEXT",
        ),
        (
            "proxy_jump_authentication_json",
            "ALTER TABLE sessions ADD COLUMN proxy_jump_authentication_json TEXT",
        ),
        (
            "startup_command",
            "ALTER TABLE sessions ADD COLUMN startup_command TEXT",
        ),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(definition, [])?;
        }
    }
    Ok(())
}

fn replace_tags(connection: &Connection, session_id: SessionId, tags: &[String]) -> Result<()> {
    connection.execute(
        "DELETE FROM session_tags WHERE session_id = ?1",
        params![session_id.to_string()],
    )?;
    for tag in tags {
        connection.execute(
            "INSERT INTO session_tags (session_id, tag) VALUES (?1, ?2)",
            params![session_id.to_string(), tag],
        )?;
    }
    Ok(())
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut tags = tags
        .into_iter()
        .map(|tag| tag.trim().to_owned())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    tags.sort_by_key(|tag| tag.to_lowercase());
    tags.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    tags
}

fn parse_uuid(value: String) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(to_sql_error)
}

fn parse_datetime(value: String) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(to_sql_error)
}

fn to_sql_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(group_id: Option<GroupId>) -> SessionDraft {
        SessionDraft {
            group_id,
            name: "Production API".into(),
            host: "10.0.0.10".into(),
            port: 22,
            username: "deploy".into(),
            proxy_jump: None,
            proxy_jump_username: None,
            proxy_jump_authentication: None,
            authentication: AuthenticationMethod::Password {
                credential_ref: Some("session/test".into()),
            },
            terminal: TerminalProfile::default(),
            initial_directory: Some("/srv/app".into()),
            startup_command: Some("uname -a".into()),
            keepalive_seconds: 30,
            auto_reconnect: true,
            environment: Some("production".into()),
            color: Some("#ef4444".into()),
            notes: None,
            tags: vec!["api".into(), "Linux".into(), "API".into()],
            favorite: true,
        }
    }

    #[test]
    fn session_crud_preserves_auth_and_normalizes_tags() {
        let repository = SessionRepository::in_memory().unwrap();
        let group = repository
            .create_group(SessionGroupDraft {
                parent_id: None,
                name: "Production".into(),
                color: Some("#ef4444".into()),
                sort_order: 0,
            })
            .unwrap();

        let mut session_draft = draft(Some(group.id));
        session_draft.proxy_jump = Some("bastion".into());
        session_draft.proxy_jump_username = Some("jump-user".into());
        session_draft.proxy_jump_authentication = Some(AuthenticationMethod::Password {
            credential_ref: Some("proxy/test".into()),
        });
        let created = repository.create_session(session_draft).unwrap();
        assert_eq!(created.tags, vec!["api", "Linux"]);
        assert_eq!(created.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(created.proxy_jump_username.as_deref(), Some("jump-user"));
        assert_eq!(
            created.proxy_jump_authentication,
            Some(AuthenticationMethod::Password {
                credential_ref: Some("proxy/test".into()),
            })
        );

        let loaded = repository.get_session(created.id).unwrap().unwrap();
        assert_eq!(loaded.authentication, created.authentication);
        assert_eq!(loaded.terminal, created.terminal);
        assert_eq!(loaded.startup_command, Some("uname -a".into()));
        assert_eq!(loaded.proxy_jump, created.proxy_jump);
        assert_eq!(loaded.proxy_jump_username, created.proxy_jump_username);
        assert_eq!(
            loaded.proxy_jump_authentication,
            created.proxy_jump_authentication
        );
        assert_eq!(loaded.tags, vec!["api", "Linux"]);

        repository.delete_session(created.id).unwrap();
        assert!(repository.get_session(created.id).unwrap().is_none());
    }

    #[test]
    fn deleting_group_cascades_children_and_deletes_sessions() {
        let repository = SessionRepository::in_memory().unwrap();
        let parent = repository
            .create_group(SessionGroupDraft {
                parent_id: None,
                name: "Production".into(),
                color: None,
                sort_order: 0,
            })
            .unwrap();
        let child = repository
            .create_group(SessionGroupDraft {
                parent_id: Some(parent.id),
                name: "Web".into(),
                color: None,
                sort_order: 0,
            })
            .unwrap();
        let session = repository.create_session(draft(Some(parent.id))).unwrap();
        let child_session = repository.create_session(draft(Some(child.id))).unwrap();

        let deleted = repository.delete_group(parent.id).unwrap();

        assert!(repository.list_groups().unwrap().is_empty());
        assert_eq!(deleted.len(), 2);
        assert!(deleted.iter().any(|deleted| deleted.id == session.id));
        assert!(deleted.iter().any(|deleted| deleted.id == child_session.id));
        assert!(repository.get_session(session.id).unwrap().is_none());
        assert!(repository.get_session(child_session.id).unwrap().is_none());
    }

    #[test]
    fn deleting_known_host_is_idempotent_and_preserves_other_hosts() {
        let repository = SessionRepository::in_memory().unwrap();
        let now = Utc::now();
        for (host, port) in [("alpha.example.com", 22), ("beta.example.com", 2222)] {
            repository
                .save_known_host(KnownHost {
                    host: host.into(),
                    port,
                    key_type: "ssh-ed25519".into(),
                    fingerprint: format!("SHA256:{host}"),
                    public_key: format!("public-key-{host}"),
                    first_seen: now,
                    last_seen: now,
                })
                .unwrap();
        }

        repository
            .delete_known_host("alpha.example.com", 22)
            .unwrap();
        repository
            .delete_known_host("alpha.example.com", 22)
            .unwrap();

        assert!(
            repository
                .find_known_host("alpha.example.com", 22)
                .unwrap()
                .is_none()
        );
        assert_eq!(repository.list_known_hosts().unwrap().len(), 1);
        assert_eq!(
            repository.list_known_hosts().unwrap()[0].host,
            "beta.example.com"
        );
    }

    #[test]
    fn known_host_upsert_replaces_rotated_key_explicitly() {
        let repository = SessionRepository::in_memory().unwrap();
        let now = Utc::now();
        repository
            .save_known_host(KnownHost {
                host: "example.com".into(),
                port: 22,
                key_type: "ssh-ed25519".into(),
                fingerprint: "SHA256:first".into(),
                public_key: "ssh-ed25519 AAAAfirst".into(),
                first_seen: now,
                last_seen: now,
            })
            .unwrap();
        repository
            .save_known_host(KnownHost {
                host: "example.com".into(),
                port: 22,
                key_type: "ssh-ed25519".into(),
                fingerprint: "SHA256:second".into(),
                public_key: "ssh-ed25519 AAAAsecond".into(),
                first_seen: now,
                last_seen: now,
            })
            .unwrap();

        let known = repository
            .find_known_host("example.com", 22)
            .unwrap()
            .unwrap();
        assert_eq!(known.fingerprint, "SHA256:second");
    }

    #[test]
    fn export_bundle_excludes_secret_values_by_design() {
        let repository = SessionRepository::in_memory().unwrap();
        repository.create_session(draft(None)).unwrap();
        let bundle = repository.export_bundle(false).unwrap();
        let json = serde_json::to_string(&bundle).unwrap();
        assert!(json.contains("session/test"));
        assert!(!json.contains("passwordValue"));
        bundle.validate().unwrap();
    }
}
