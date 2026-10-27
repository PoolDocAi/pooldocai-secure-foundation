import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, hash) {
  const [salt, key] = hash.split(":");
  const actual = scryptSync(password, salt, 64);
  return (
    key?.length === 128 && timingSafeEqual(actual, Buffer.from(key, "hex"))
  );
}
export function openStore(path) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(
    readFileSync(new URL("../migrations/001-cms.sql", import.meta.url), "utf8"),
  );
  db.exec(
    readFileSync(new URL("../migrations/002-knowledge.sql", import.meta.url), "utf8"),
  );
  return db;
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function audit(db, actor, action, id, detail = {}) {
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(
    uid(),
    actor,
    action,
    id,
    JSON.stringify(detail),
    now(),
  );
}
export const categories = [
  "Articles & Insights",
  "How-To Guides",
  "Troubleshooting Tips",
  "Checklists & Downloads",
  "For Pool Professionals",
];
export const tags = [
  "Pumps & Motors",
  "Filters & Valves",
  "Heaters & Heat Pumps",
  "Salt & Chlorination",
  "Water Chemistry & Algae",
  "Automation & Controls",
  "Pool Cleaners",
  "Leaks & Circulation",
  "Seasonal Pool Care",
  "Service Business Workflows",
];
export function seedTaxonomy(db) {
  for (const [kind, values] of [
    ["category", categories],
    ["tag", tags],
  ])
    values.forEach((name, i) =>
      db
        .prepare("INSERT OR IGNORE INTO taxonomy VALUES(?,?,?,?,0)")
        .run(`${kind}-${i + 1}`, kind, name, i),
    );
  db.prepare("INSERT OR IGNORE INTO settings VALUES(1,?)").run(
    JSON.stringify({
      defaultAudience: "homeowners",
      requireSources: true,
      publicationTimezone: "America/New_York",
      integrationIssuer: "",
      indexNowEnabled: false,
    }),
  );
}
export function revision(db, row, actor, reason) {
  db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?)").run(
    uid(),
    row.id,
    row.version,
    row.data,
    actor,
    reason,
    now(),
  );
}
