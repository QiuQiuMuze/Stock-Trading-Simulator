import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional


class UserAlreadyExists(Exception):
    """Raised when attempting to create a duplicate username."""


class AuthenticationError(Exception):
    """Raised when login credentials are invalid."""


class Storage:
    """Simple SQLite-backed persistence layer for users and portfolios."""

    def __init__(self, db_path: Optional[str] = None) -> None:
        default_path = Path(os.getenv("SIMULATOR_DB_PATH", "data/simulator.db"))
        self.db_path = Path(db_path) if db_path else default_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("PRAGMA foreign_keys = ON;")
            cur.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS accounts (
                    user_id TEXT PRIMARY KEY,
                    cash REAL NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS positions (
                    user_id TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    quantity INTEGER NOT NULL,
                    PRIMARY KEY (user_id, symbol),
                    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    name TEXT NOT NULL,
                    price REAL NOT NULL,
                    quantity INTEGER NOT NULL,
                    side TEXT NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
                """
            )
            self._conn.commit()

    # ------------------------------------------------------------------
    # User management
    # ------------------------------------------------------------------
    def create_user(self, username: str, password: str, initial_cash: float = 100_000.0) -> Dict[str, str]:
        username = username.strip()
        if not username:
            raise ValueError("用户名不能为空")
        if len(username) < 2:
            raise ValueError("用户名至少需要2个字符")
        if not password:
            raise ValueError("密码不能为空")

        user_id = uuid.uuid4().hex
        salt = secrets.token_hex(16)
        password_hash = self._hash_password(password, salt)
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute(
                    "INSERT INTO users (user_id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
                    (user_id, username, password_hash, salt),
                )
            except sqlite3.IntegrityError as exc:
                raise UserAlreadyExists("用户名已存在") from exc
            cur.execute(
                "INSERT INTO accounts (user_id, cash) VALUES (?, ?)",
                (user_id, float(initial_cash)),
            )
            self._conn.commit()
        return {"user_id": user_id, "username": username}

    def authenticate(self, username: str, password: str) -> Dict[str, str]:
        username = username.strip()
        if not username or not password:
            raise AuthenticationError("用户名或密码错误")
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "SELECT user_id, username, password_hash, salt FROM users WHERE username = ?",
                (username,),
            )
            row = cur.fetchone()
        if not row:
            raise AuthenticationError("用户名或密码错误")
        expected = row["password_hash"]
        salt = row["salt"]
        computed = self._hash_password(password, salt)
        if not hmac.compare_digest(expected, computed):
            raise AuthenticationError("用户名或密码错误")
        return {"user_id": row["user_id"], "username": row["username"]}

    def get_user(self, user_id: str) -> Optional[Dict[str, str]]:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "SELECT user_id, username FROM users WHERE user_id = ?",
                (user_id,),
            )
            row = cur.fetchone()
        if not row:
            return None
        return {"user_id": row["user_id"], "username": row["username"]}

    def user_exists(self, user_id: str) -> bool:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("SELECT 1 FROM users WHERE user_id = ?", (user_id,))
            return cur.fetchone() is not None

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------
    def create_session(self, user_id: str) -> str:
        session_id = secrets.token_urlsafe(32)
        timestamp = datetime.utcnow().isoformat()
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            cur.execute(
                "INSERT INTO sessions (session_id, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)",
                (session_id, user_id, timestamp, timestamp),
            )
            self._conn.commit()
        return session_id

    def resolve_session(self, session_id: str) -> Optional[str]:
        if not session_id:
            return None
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "SELECT user_id FROM sessions WHERE session_id = ?",
                (session_id,),
            )
            row = cur.fetchone()
            if not row:
                return None
            cur.execute(
                "UPDATE sessions SET last_seen = ? WHERE session_id = ?",
                (datetime.utcnow().isoformat(), session_id),
            )
            self._conn.commit()
            return row["user_id"]

    def delete_session(self, session_id: str) -> None:
        if not session_id:
            return
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
            self._conn.commit()

    # ------------------------------------------------------------------
    # Portfolio management
    # ------------------------------------------------------------------
    def load_portfolio(self, user_id: str, history_limit: int = 200) -> Optional[Dict[str, object]]:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "SELECT cash FROM accounts WHERE user_id = ?",
                (user_id,),
            )
            account_row = cur.fetchone()
            if not account_row:
                return None
            cash = float(account_row["cash"])
            cur.execute(
                "SELECT symbol, quantity FROM positions WHERE user_id = ?",
                (user_id,),
            )
            positions_rows = cur.fetchall()
            positions: Dict[str, int] = {row["symbol"]: int(row["quantity"]) for row in positions_rows}
            cur.execute(
                "SELECT timestamp, symbol, name, price, quantity, side FROM trades WHERE user_id = ? ORDER BY id ASC",
                (user_id,),
            )
            trades_rows = cur.fetchall()
        trades: List[Dict[str, object]] = [
            {
                "timestamp": row["timestamp"],
                "symbol": row["symbol"],
                "name": row["name"],
                "price": float(row["price"]),
                "quantity": int(row["quantity"]),
                "side": row["side"],
            }
            for row in trades_rows
        ]
        if len(trades) > history_limit:
            trades = trades[-history_limit:]
        return {"cash": cash, "positions": positions, "history": trades}

    def persist_portfolio(self, user_id: str, cash: float, positions: Dict[str, int]) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "UPDATE accounts SET cash = ? WHERE user_id = ?",
                (float(cash), user_id),
            )
            cur.execute("DELETE FROM positions WHERE user_id = ?", (user_id,))
            for symbol, quantity in positions.items():
                cur.execute(
                    "INSERT INTO positions (user_id, symbol, quantity) VALUES (?, ?, ?)",
                    (user_id, symbol, int(quantity)),
                )
            self._conn.commit()

    def record_trade(self, user_id: str, trade: Dict[str, object]) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                INSERT INTO trades (user_id, timestamp, symbol, name, price, quantity, side)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    trade["timestamp"],
                    trade["symbol"],
                    trade["name"],
                    float(trade["price"]),
                    int(trade["quantity"]),
                    trade["side"],
                ),
            )
            self._conn.commit()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _hash_password(password: str, salt: str) -> str:
        return hashlib.sha256((salt + password).encode("utf-8")).hexdigest()
