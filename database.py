"""
SQLite Database manager for AI Chatbot.
Handles session management, message persistence, and history retrieval.
"""

import sqlite3
import os
import uuid
from datetime import datetime
from typing import List, Dict, Optional, Any

DB_PATH = os.environ.get("DATABASE_PATH", "chatbot.db")


def get_db_connection() -> sqlite3.Connection:
    """Creates a database connection with row factory enabled."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db():
    """Initializes SQLite schema and indexes."""
    with get_db_connection() as conn:
        conn.execute("PRAGMA journal_mode = WAL;")
        cursor = conn.cursor()

        # Sessions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        # Messages table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
        """)

        # Indexes for fast lookup
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_messages_session 
            ON messages(session_id, created_at);
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_sessions_updated 
            ON sessions(updated_at DESC);
        """)
        conn.commit()


def create_session(title: Optional[str] = None) -> Dict[str, Any]:
    """Creates a new chat session."""
    session_id = str(uuid.uuid4())
    default_title = title if title and title.strip() else "New Conversation"
    now = datetime.utcnow().isoformat()

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (session_id, default_title, now, now)
        )
        conn.commit()

    return {
        "id": session_id,
        "title": default_title,
        "created_at": now,
        "updated_at": now,
        "message_count": 0,
        "last_message": None
    }


def list_sessions() -> List[Dict[str, Any]]:
    """Returns all chat sessions ordered by last update with message preview and count."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                s.id, 
                s.title, 
                s.created_at, 
                s.updated_at,
                COUNT(m.id) as message_count,
                (
                    SELECT content FROM messages 
                    WHERE session_id = s.id 
                    ORDER BY id DESC LIMIT 1
                ) as last_message
            FROM sessions s
            LEFT JOIN messages m ON s.id = m.session_id
            GROUP BY s.id
            ORDER BY s.updated_at DESC;
        """)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    """Retrieves a single session by its ID."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?", (session_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def update_session_title(session_id: str, title: str) -> bool:
    """Updates session title and updated_at timestamp."""
    now = datetime.utcnow().isoformat()
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
            (title.strip(), now, session_id)
        )
        conn.commit()
        return cursor.rowcount > 0


def delete_session(session_id: str) -> bool:
    """Deletes a session and cascades deletion to all its messages."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        conn.commit()
        return cursor.rowcount > 0


def clear_session_messages(session_id: str) -> bool:
    """Clears all messages within a specific session."""
    now = datetime.utcnow().isoformat()
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        cursor.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, session_id))
        conn.commit()
        return True


def add_message(session_id: str, role: str, content: str) -> Dict[str, Any]:
    """Adds a message to a session and touches updated_at timestamp."""
    now = datetime.utcnow().isoformat()
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Ensure session exists or create it
        cursor.execute("SELECT id FROM sessions WHERE id = ?", (session_id,))
        if not cursor.fetchone():
            cursor.execute(
                "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (session_id, "New Conversation", now, now)
            )

        cursor.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, role, content, now)
        )
        message_id = cursor.lastrowid

        # Update session updated_at
        cursor.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            (now, session_id)
        )
        conn.commit()

    return {
        "id": message_id,
        "session_id": session_id,
        "role": role,
        "content": content,
        "created_at": now
    }


def get_messages(session_id: str) -> List[Dict[str, Any]]:
    """Retrieves all messages for a session in chronological order."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
            (session_id,)
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]


def get_db_stats() -> Dict[str, int]:
    """Returns total sessions and message counts from SQLite."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM sessions")
        session_count = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM messages")
        message_count = cursor.fetchone()[0]
        return {
            "total_sessions": session_count,
            "total_messages": message_count
        }
