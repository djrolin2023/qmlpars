const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const fs = require('fs')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'vehicles.db')

// 确保 data 目录存在
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

// node:sqlite（Node 内置 SQLite 模块，需 Node >= 22.5）使用同步 API
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

// 初始化表结构
db.exec(`
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plateNo TEXT NOT NULL UNIQUE,
  plateKey TEXT NOT NULL,
  owner TEXT NOT NULL,
  phone TEXT,
  department TEXT,
  remark TEXT,
  photo TEXT,
  validUntil TEXT,
  createdAt TEXT DEFAULT (datetime('now','localtime')),
  updatedAt TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  createdAt TEXT DEFAULT (datetime('now','localtime')),
  expireAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recognition_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plateNo TEXT,
  source TEXT,
  channel TEXT DEFAULT 'mini',
  confidence REAL,
  result TEXT,
  image TEXT,
  userId TEXT,
  userName TEXT,
  username TEXT,
  flag TEXT DEFAULT 'normal',
  createdAt TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_recog_plate_channel_time ON recognition_logs(plateNo, channel, createdAt);

-- 黑白名单：type='white' 白名单(放行/已知)  type='black' 黑名单(告警)
CREATE TABLE IF NOT EXISTS vehicle_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plateNo TEXT NOT NULL,
  plateKey TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'black',
  reason TEXT,
  createdAt TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(plateKey, type)
);
CREATE INDEX IF NOT EXISTS idx_vl_plate ON vehicle_lists(plateKey);

CREATE TABLE IF NOT EXISTS sys_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  operator TEXT,
  ip TEXT,
  createdAt TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  createdAt TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  builtin INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT DEFAULT (datetime('now','localtime'))
);

-- 初始化内置部门（仅首次，已存在则忽略）
INSERT OR IGNORE INTO departments (name, builtin) VALUES
  ('学校领导', 1), ('物业公司', 1), ('饭堂', 1), ('第三方', 1);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  userId INTEGER NOT NULL,
  username TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  createdAt TEXT DEFAULT (datetime('now','localtime')),
  expireAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  name TEXT,
  phone TEXT,
  remark TEXT,
  createdAt TEXT DEFAULT (datetime('now','localtime')),
  updatedAt TEXT DEFAULT (datetime('now','localtime'))
);
`)

// 兼容旧表：若不存在 validUntil 列则补加
try {
  const cols = db.prepare('PRAGMA table_info(vehicles)').all().map(c => c.name)
  if (!cols.includes('validUntil')) {
    db.exec('ALTER TABLE vehicles ADD COLUMN validUntil TEXT')
  }
} catch (e) {
  // 忽略（极少数情况下表尚未就绪）
}

// 兼容旧表：recognition_logs 若缺少 channel 列（旧版本建的表）则补加，否则日志写入会一直失败
try {
  const cols = db.prepare('PRAGMA table_info(recognition_logs)').all().map(c => c.name)
  if (!cols.includes('channel')) {
    db.exec("ALTER TABLE recognition_logs ADD COLUMN channel TEXT DEFAULT 'mini'")
  }
  // 兼容旧表：补加 image 列（存储识别成功抓拍图地址）
  if (!cols.includes('image')) {
    db.exec('ALTER TABLE recognition_logs ADD COLUMN image TEXT')
  }
  // 兼容旧表：补加 userId / userName 列（记录操作人）
  if (!cols.includes('userId')) {
    db.exec('ALTER TABLE recognition_logs ADD COLUMN userId INTEGER')
  }
  if (!cols.includes('userName')) {
    db.exec('ALTER TABLE recognition_logs ADD COLUMN userName TEXT')
  }
  // 兼容旧表：补加 username 列（记录操作人账号，展示为 账号/姓名）
  if (!cols.includes('username')) {
    db.exec('ALTER TABLE recognition_logs ADD COLUMN username TEXT')
  }
  // 兼容旧表：补加 flag 列（normal/white/black，标识黑白名单命中）
  if (!cols.includes('flag')) {
    db.exec("ALTER TABLE recognition_logs ADD COLUMN flag TEXT DEFAULT 'normal'")
  }
} catch (e) {
  // 忽略
}

// 兼容旧表：users 表补加 name / phone 列
try {
  const ucols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
  if (!ucols.includes('name')) db.exec('ALTER TABLE users ADD COLUMN name TEXT')
  if (!ucols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT')
} catch (e) {
  // 忽略
}

// 兼容旧表：user_sessions 补加 ip / ua 列（记录登录来源 IP 与设备信息）
try {
  const scols = db.prepare('PRAGMA table_info(user_sessions)').all().map(c => c.name)
  if (!scols.includes('ip')) db.exec('ALTER TABLE user_sessions ADD COLUMN ip TEXT')
  if (!scols.includes('ua')) db.exec('ALTER TABLE user_sessions ADD COLUMN ua TEXT')
} catch (e) {
  // 忽略
}

// 用户 ID 从 10001 开始自增：将 users 表的自增序列推进到 10000（下次插入为 10001）
try {
  const seq = db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='users'),0) AS s").get().s
  if (seq < 10000) {
    db.prepare("UPDATE sqlite_sequence SET seq = 10000 WHERE name = 'users'").run()
    if (db.prepare("SELECT changes() AS c").get().c === 0) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('users', 10000)").run()
    }
  }
} catch (e) {
  // 忽略
}

// 高频查询列索引（表结构稳定后追加，提升识别/查询性能）
db.exec(`
CREATE INDEX IF NOT EXISTS idx_vehicles_plateKey ON vehicles(plateKey);
CREATE INDEX IF NOT EXISTS idx_vehicles_plateNo ON vehicles(plateNo);
CREATE INDEX IF NOT EXISTS idx_recognition_logs_plateNo ON recognition_logs(plateNo);
CREATE INDEX IF NOT EXISTS idx_recognition_logs_createdAt ON recognition_logs(createdAt);
CREATE INDEX IF NOT EXISTS idx_user_sessions_userId ON user_sessions(userId);
CREATE INDEX IF NOT EXISTS idx_login_attempts_username ON login_attempts(username);
CREATE INDEX IF NOT EXISTS idx_sys_logs_createdAt ON sys_logs(createdAt);
`)

module.exports = db
