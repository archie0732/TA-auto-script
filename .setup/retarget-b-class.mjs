import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const targetFile = path.join(ROOT, "data", "approved", "to-submit.json");
const backupFile = path.join(ROOT, "data", "approved", "to-submit.before-b-class-fix.json");

const VALID_B_DATES = [
  "2026-03-05",
  "2026-03-12",
  "2026-03-19",
  "2026-03-26",
  "2026-04-02",
  "2026-04-09",
  "2026-04-16",
  "2026-04-23",
  "2026-04-30",
  "2026-05-07",
  "2026-05-14",
  "2026-05-21",
];

const KNOWN_COURSE_NAME = "物件導向程式設計";

function toMs(dateStr) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  return Number.isFinite(t) ? t : NaN;
}

function nearestBDate(input) {
  const inputMs = toMs(input);
  if (!Number.isFinite(inputMs)) return input;
  let best = VALID_B_DATES[0];
  let bestDiff = Math.abs(toMs(best) - inputMs);
  for (const candidate of VALID_B_DATES.slice(1)) {
    const diff = Math.abs(toMs(candidate) - inputMs);
    if (diff < bestDiff || (diff === bestDiff && toMs(candidate) > toMs(best))) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best;
}

function shouldConvertRecord(record) {
  return String(record?.class_group ?? "").trim().toUpperCase() !== "A";
}

function shouldConvertSession(session) {
  return String(session?.class_group ?? "").trim().toUpperCase() !== "A";
}

const raw = await fs.readFile(targetFile, "utf8");
await fs.writeFile(backupFile, raw, "utf8");
const json = JSON.parse(raw);

for (const record of json.records ?? []) {
  if (!shouldConvertRecord(record)) continue;
  record.class_group = "B";
  record.course_name = KNOWN_COURSE_NAME;
  if (record.session_date) {
    record.session_date = nearestBDate(record.session_date);
  }
  for (const session of record.sessions ?? []) {
    if (!shouldConvertSession(session)) continue;
    session.class_group = "B";
    if (session.session_date) {
      session.session_date = nearestBDate(session.session_date);
    }
  }
}

await fs.writeFile(targetFile, `${JSON.stringify(json, null, 2)}\n`, "utf8");

console.log(`Updated ${path.relative(ROOT, targetFile)}`);
console.log(`Backup  ${path.relative(ROOT, backupFile)}`);
