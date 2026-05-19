import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PENDING_FILE = path.join(ROOT, "data", "pending", "pending.json");
const APPROVED_FILE = path.join(ROOT, "data", "approved", "approved.json");
const TO_SUBMIT_FILE = path.join(ROOT, "data", "approved", "to-submit.json");

function parseArgs(argv) {
  const args = {
    ids: [],
    all: false,
    list: false,
    queueAllApproved: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--ids" && argv[i + 1]) {
      args.ids = argv[++i]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      continue;
    }
    if (token === "--all") {
      args.all = true;
      continue;
    }
    if (token === "--list") {
      args.list = true;
      continue;
    }
    if (token === "--queue-all-approved") {
      args.queueAllApproved = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  bun gemini/approve-records.mjs --list
  bun gemini/approve-records.mjs --ids <id1,id2>
  bun gemini/approve-records.mjs --all
  bun gemini/approve-records.mjs --all --queue-all-approved

Description:
  - 將 pending 記錄核准進 approved 歷史
  - 產生 to-submit 佇列（預設只含本次新核准）
`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJsonSafe(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writePrettyJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function toTime(v) {
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function earliestSessionDate(rec) {
  const dates = [];
  if (rec.session_date) dates.push(rec.session_date);
  if (Array.isArray(rec.sessions)) {
    for (const s of rec.sessions) {
      if (s?.session_date) dates.push(String(s.session_date));
    }
  }
  if (dates.length === 0) return "";
  dates.sort((a, b) => toTime(a) - toTime(b) || String(a).localeCompare(String(b)));
  return dates[0];
}

function normalizeQueueRecord(r) {
  return {
    id: r.id,
    source_image: r.source_image,
    session_date: r.session_date,
    session_count: r.session_count ?? (Array.isArray(r.sessions) ? r.sessions.length : 0),
    sessions: Array.isArray(r.sessions)
      ? [...r.sessions].sort((a, b) => {
          const at = toTime(a?.session_date);
          const bt = toTime(b?.session_date);
          return at - bt || String(a?.session_date || "").localeCompare(String(b?.session_date || ""));
        })
      : [],
    class_group: r.class_group,
    course_name: r.course_name,
    student_ids: r.student_ids,
    student_count: r.student_count,
    invalid_student_ids: r.invalid_student_ids || [],
    notes: r.raw_notes || "",
    approved_at: r.approved_at || "",
  };
}

function printPending(records) {
  if (!records.length) {
    console.log("No pending records.");
    return;
  }
  for (const item of records) {
    console.log(
      [
        `id=${item.id}`,
        `date=${item.session_date || "-"}`,
        `class=${item.class_group || "-"}`,
        `count=${item.student_count ?? 0}`,
        `status=${item.status || "pending_review"}`,
        `image=${item.source_image || "-"}`,
      ].join(" | "),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pending = await readJsonSafe(PENDING_FILE, { records: [] });
  const approved = await readJsonSafe(APPROVED_FILE, { approved_at: "", records: [] });

  const pendingRecords = Array.isArray(pending.records) ? pending.records : [];
  const approvedRecords = Array.isArray(approved.records) ? approved.records : [];

  if (args.list) {
    printPending(pendingRecords);
    return;
  }

  if (!args.all && args.ids.length === 0) {
    throw new Error("請提供 --ids 或 --all，或先用 --list 查看");
  }

  const selected = args.all
    ? pendingRecords.filter((r) => r.status !== "approved")
    : pendingRecords.filter((r) => args.ids.includes(r.id));

  const shouldRefreshOnly = selected.length === 0 && args.all;
  if (selected.length === 0 && !shouldRefreshOnly) {
    console.log("沒有可核准的記錄。");
    return;
  }

  const approvedIdSet = new Set(approvedRecords.map((r) => r.id));
  if (!shouldRefreshOnly) {
    for (const item of selected) {
      item.status = "approved";
      item.approved_at = nowIso();
      if (!approvedIdSet.has(item.id)) {
        approvedRecords.push(item);
        approvedIdSet.add(item.id);
      }
    }
  }

  const queueSource = args.queueAllApproved
    ? approvedRecords.filter((r) => r.status === "approved")
    : shouldRefreshOnly
      ? []
      : selected.filter((r) => r.status === "approved");

  const toSubmit = queueSource
    .map(normalizeQueueRecord)
    .sort((a, b) => {
      const at = toTime(earliestSessionDate(a));
      const bt = toTime(earliestSessionDate(b));
      if (at !== bt) return at - bt;
      return String(a.source_image || "").localeCompare(String(b.source_image || ""));
    });

  pending.generated_at = nowIso();
  pending.records = pendingRecords;
  approved.approved_at = nowIso();
  approved.records = approvedRecords;

  await writePrettyJson(PENDING_FILE, pending);
  await writePrettyJson(APPROVED_FILE, approved);
  await writePrettyJson(TO_SUBMIT_FILE, {
    generated_at: nowIso(),
    count: toSubmit.length,
    records: toSubmit,
  });

  console.log(`Approved now: ${shouldRefreshOnly ? 0 : selected.length}`);
  console.log(`Total approved: ${approvedRecords.length}`);
  console.log(`Queue mode: ${args.queueAllApproved ? "all-approved" : "newly-approved-only"}`);
  console.log(`Queue file: data/approved/to-submit.json`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});

