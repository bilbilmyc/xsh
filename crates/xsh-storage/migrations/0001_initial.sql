PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS session_groups (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES session_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    group_id TEXT REFERENCES session_groups(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    proxy_jump TEXT,
    proxy_jump_username TEXT,
    proxy_jump_authentication_json TEXT,
    authentication_json TEXT NOT NULL,
    terminal_json TEXT NOT NULL,
    initial_directory TEXT,
    startup_command TEXT,
    keepalive_seconds INTEGER NOT NULL DEFAULT 30,
    auto_reconnect INTEGER NOT NULL DEFAULT 0,
    environment TEXT,
    color TEXT,
    notes TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_tags (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY(session_id, tag)
);

CREATE TABLE IF NOT EXISTS known_hosts (
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    key_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    public_key TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY(host, port)
);

CREATE INDEX IF NOT EXISTS idx_session_groups_parent ON session_groups(parent_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id, name);
CREATE INDEX IF NOT EXISTS idx_sessions_favorite ON sessions(favorite, name);
