import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const DEFAULT_INPUT_DIR = path.join(ROOT, "images");
const DEFAULT_PREPROCESSED_DIR = path.join(ROOT, "data", "preprocessed");
const PENDING_FILE = path.join(ROOT, "data", "pending", "pending.json");
const RECOGNIZED_DIR = path.join(ROOT, "data", "recognized");

const SUPPORTED_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
]);

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT_DIR,
    preprocessedInput: DEFAULT_PREPROCESSED_DIR,
    model: "",
    overwrite: false,
    limit: 0,
    preprocess: true,
    preprocessForce: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input" && argv[i + 1]) {
      args.input = path.resolve(ROOT, argv[++i]);
      continue;
    }
    if (token === "--model" && argv[i + 1]) {
      args.model = argv[++i];
      continue;
    }
    if (token === "--preprocessed-input" && argv[i + 1]) {
      args.preprocessedInput = path.resolve(ROOT, argv[++i]);
      continue;
    }
    if (token === "--overwrite") {
      args.overwrite = true;
      continue;
    }
    if (token === "--no-preprocess") {
      args.preprocess = false;
      continue;
    }
    if (token === "--preprocess-force") {
      args.preprocessForce = true;
      continue;
    }
    if (token === "--limit" && argv[i + 1]) {
      args.limit = Number(argv[++i]) || 0;
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
  node gemini/recognize-images.mjs [--input images] [--model gemini-3.1-flash-lite] [--overwrite] [--limit 10]
  node gemini/recognize-images.mjs [--no-preprocess]
  node gemini/recognize-images.mjs [--preprocess-force]

Description:
  讀取圖片資料夾，先做預處理後呼叫 Gemini 辨識，輸出到 data/recognized 與 data/pending/pending.json
`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readEnvFile(envPath) {
  const env = {};
  let raw = "";
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch {
    return env;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function listImages(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listImages(full);
      out.push(...nested);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (SUPPORTED_EXTS.has(ext)) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function extToMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  return "application/octet-stream";
}

async function readJsonSafe(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function extractJsonText(responseJson) {
  const parts = responseJson?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => part?.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) return "";
  if (text.startsWith("{") && text.endsWith("}")) return text;

  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

function normalizeIds(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const item of ids) {
    const cleaned = String(item ?? "")
      .replace(/[^\d]/g, "")
      .trim();
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function splitStudentIds(ids) {
  const normalized = normalizeIds(ids);
  const valid = [];
  const invalid = [];
  for (const id of normalized) {
    if (/^\d{9}$/.test(id)) {
      valid.push(id);
    } else {
      invalid.push(id);
    }
  }
  return { valid, invalid };
}

function normalizeClassGroup(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "A" || value === "B") return value;
  if (value === "MIXED" || value === "A/B" || value === "AB") return "MIXED";
  if (value.includes("A")) return "A";
  if (value.includes("B")) return "B";
  return "UNKNOWN";
}

function normalizeDate(raw, fallbackYear = new Date().getFullYear()) {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  const iso = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = String(Math.max(1, Math.min(12, Number(iso[2])))).padStart(2, "0");
    const d = String(Math.max(1, Math.min(31, Number(iso[3])))).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const md = value.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (md) {
    const m = String(Math.max(1, Math.min(12, Number(md[1])))).padStart(2, "0");
    const d = String(Math.max(1, Math.min(31, Number(md[2])))).padStart(2, "0");
    return `${fallbackYear}-${m}-${d}`;
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeModelName(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "gemini-3.1-flash-lite";

  const k = value.toLowerCase().replace(/\s+/g, "");
  const aliases = new Map([
    ["gemini3.1flash-lite", "gemini-3.1-flash-lite"],
    ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
    ["gemini3.1flashlite", "gemini-3.1-flash-lite"],
  ]);
  return aliases.get(k) || value;
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`));
    });
  });
}

async function runPreprocess({ inputDir, outputDir, force }) {
  const script = path.join(ROOT, "gemini", "preprocess-images.ps1");
  try {
    await fs.access(script);
  } catch {
    return { skipped: true, reason: "preprocess script missing" };
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-InputDir",
    inputDir,
    "-OutputDir",
    outputDir,
  ];
  if (force) args.push("-Force");
  const result = await runProcess("powershell", args, ROOT);
  return { skipped: false, ...result };
}

async function callGemini({ apiKey, model, imagePath, mimeType, imageBase64 }) {
  const prompt = `
You extract TA tutoring sign-in sheets into JSON only.
Return exactly one JSON object, no markdown.

Required output schema:
{
  "class_group": "A|B|MIXED|UNKNOWN",
  "course_name": "string or empty",
  "sessions": [
    {
      "session_date": "YYYY-MM-DD or MM/DD or empty",
      "class_group": "A|B|UNKNOWN",
      "student_ids": ["9-digit id", "9-digit id"],
      "raw_row_hint": "short text"
    }
  ],
  "unmatched_student_ids": ["9-digit id"],
  "raw_notes": "short text",
  "uncertain_items": ["issue 1", "issue 2"]
}

Rules:
1) A sheet may contain 1 to 3 dates. Put each date in sessions[].
2) Keep student_ids digits only.
3) DO NOT guess missing digits. If not 9 digits, keep it in uncertain_items instead.
4) If a student cannot be mapped to a date, put it in unmatched_student_ids.
5) Output valid JSON only.

File: ${path.basename(imagePath)}
`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini API ${res.status}: ${text.slice(0, 500)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Gemini non-JSON response: ${text.slice(0, 500)}`);
  }

  const contentText = extractJsonText(json);
  if (!contentText) {
    throw new Error(`Gemini empty candidate text: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(contentText);
  } catch {
    throw new Error(`Cannot parse model JSON payload: ${contentText.slice(0, 500)}`);
  }
}

function buildRecord(imagePath, parsed, sourceImageRef = "") {
  const relativeImage = sourceImageRef || path.relative(ROOT, imagePath).replace(/\\/g, "/");
  const base = path.basename(imagePath, path.extname(imagePath));
  const id = `${base}-${Date.now()}`;

  const uncertain = Array.isArray(parsed?.uncertain_items)
    ? parsed.uncertain_items.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  const rawNotes = String(parsed?.raw_notes ?? "").trim();
  const courseName = String(parsed?.course_name ?? "").trim();
  const globalClassGroup = normalizeClassGroup(parsed?.class_group);

  const fallbackSessions =
    Array.isArray(parsed?.sessions) && parsed.sessions.length > 0
      ? parsed.sessions
      : [
        {
          session_date: parsed?.session_date ?? "",
          class_group: parsed?.class_group ?? "",
          student_ids: parsed?.student_ids ?? [],
          raw_row_hint: "",
        },
      ];

  const sessions = [];
  const allValidIds = new Set();
  const allInvalidIds = new Set();

  for (const item of fallbackSessions) {
    const date = normalizeDate(item?.session_date ?? "");
    const classGroup = normalizeClassGroup(item?.class_group ?? globalClassGroup);
    const split = splitStudentIds(item?.student_ids ?? []);
    split.valid.forEach((s) => allValidIds.add(s));
    split.invalid.forEach((s) => allInvalidIds.add(s));

    const rowUncertain = [];
    if (!date) rowUncertain.push("missing session_date");
    if (classGroup === "UNKNOWN") rowUncertain.push("unknown class_group");
    if (split.invalid.length > 0) {
      rowUncertain.push(`invalid ids: ${split.invalid.join(", ")}`);
    }

    sessions.push({
      session_date: date,
      class_group: classGroup,
      student_ids: split.valid,
      student_count: split.valid.length,
      invalid_student_ids: split.invalid,
      raw_row_hint: String(item?.raw_row_hint ?? "").trim(),
      uncertain_items: rowUncertain,
    });
  }

  const unmatchedSplit = splitStudentIds(parsed?.unmatched_student_ids ?? []);
  unmatchedSplit.valid.forEach((s) => allValidIds.add(s));
  unmatchedSplit.invalid.forEach((s) => allInvalidIds.add(s));

  if (unmatchedSplit.invalid.length > 0) {
    uncertain.push(`invalid unmatched ids: ${unmatchedSplit.invalid.join(", ")}`);
  }
  if (allInvalidIds.size > 0) {
    uncertain.push(`detected non-9-digit ids: ${Array.from(allInvalidIds).join(", ")}`);
  }

  const primarySessionDate = sessions.find((s) => s.session_date)?.session_date ?? "";
  const allStudentIds = Array.from(allValidIds);
  const invalidStudentIds = Array.from(allInvalidIds);
  const needsReview =
    sessions.length === 0 ||
    sessions.some((s) => !s.session_date || s.class_group === "UNKNOWN") ||
    allStudentIds.length === 0 ||
    invalidStudentIds.length > 0 ||
    uncertain.length > 0;

  return {
    id,
    source_image: relativeImage,
    class_group: globalClassGroup,
    course_name: courseName,
    session_count: sessions.length,
    sessions,
    session_date: primarySessionDate,
    student_ids: allStudentIds,
    student_count: allStudentIds.length,
    invalid_student_ids: invalidStudentIds,
    unmatched_student_ids: unmatchedSplit.valid,
    raw_notes: rawNotes,
    uncertain_items: uncertain,
    status: "pending_review",
    needs_human_review: needsReview,
    recognized_at: nowIso(),
  };
}

function upsertByImage(records, record) {
  const targetBase = path.basename(record.source_image || "");
  const idx = records.findIndex((r) => {
    const src = String(r?.source_image ?? "");
    return src === record.source_image || path.basename(src) === targetBase;
  });
  if (idx >= 0) {
    records[idx] = { ...records[idx], ...record };
  } else {
    records.push(record);
  }
}

function dedupeRecords(records) {
  const bucket = new Map();
  for (const rec of records) {
    const key = path.basename(String(rec?.source_image ?? ""));
    if (!key) continue;
    const prev = bucket.get(key);
    if (!prev) {
      bucket.set(key, rec);
      continue;
    }
    const prevTs = Date.parse(prev?.recognized_at ?? "") || 0;
    const currTs = Date.parse(rec?.recognized_at ?? "") || 0;
    bucket.set(key, currTs >= prevTs ? rec : prev);
  }
  return Array.from(bucket.values());
}

async function writePrettyJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = await readEnvFile(path.join(ROOT, ".env"));
  await ensureDir(args.input);
  await ensureDir(args.preprocessedInput);

  let effectiveInputDir = args.input;
  if (args.preprocess) {
    const pre = await runPreprocess({
      inputDir: args.input,
      outputDir: args.preprocessedInput,
      force: args.preprocessForce || args.overwrite,
    });
    if (!pre.skipped) {
      if (pre.stdout.trim()) console.log(pre.stdout.trim());
      effectiveInputDir = args.preprocessedInput;
    } else {
      console.warn(`[warn] preprocessing skipped: ${pre.reason}`);
    }
  }

  const imageFiles = await listImages(effectiveInputDir);
  if (imageFiles.length === 0) {
    console.log(`No images found in: ${effectiveInputDir}`);
    return;
  }

  const geminiApi =
    envFile.GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    envFile.GEMINI_API ||
    process.env.GEMINI_API ||
    "";
  const model = normalizeModelName(
    args.model || envFile.GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
  );

  if (!geminiApi) {
    throw new Error(
      "找不到 Gemini API Key。請在 .env 設定 GEMINI_API_KEY=<your_key> (或 GEMINI_API)",
    );
  }

  await ensureDir(RECOGNIZED_DIR);
  await ensureDir(path.dirname(PENDING_FILE));

  const pending = await readJsonSafe(PENDING_FILE, { generated_at: "", records: [] });
  const records = Array.isArray(pending.records) ? pending.records : [];
  let processedCount = 0;
  let successCount = 0;

  for (const imagePath of imageFiles) {
    if (args.limit > 0 && processedCount >= args.limit) break;
    processedCount += 1;

    const relativeImage = path.relative(ROOT, imagePath).replace(/\\/g, "/");
    let sourceImageRef = relativeImage;
    if (effectiveInputDir !== args.input) {
      const relFromEffective = path.relative(effectiveInputDir, imagePath).replace(/\\/g, "/");
      sourceImageRef = path
        .join(path.relative(ROOT, args.input), relFromEffective)
        .replace(/\\/g, "/");
    }
    const recognizedPath = path.join(
      RECOGNIZED_DIR,
      `${path.basename(imagePath, path.extname(imagePath))}.json`,
    );

    if (!args.overwrite) {
      try {
        await fs.access(recognizedPath);
        console.log(`[skip] ${relativeImage} (already recognized)`);
        continue;
      } catch {
        // continue
      }
    }

    try {
      const bytes = await fs.readFile(imagePath);
      const mimeType = extToMime(imagePath);
      const imageBase64 = bytes.toString("base64");
      const parsed = await callGemini({ apiKey: geminiApi, model, imagePath, mimeType, imageBase64 });
      const record = buildRecord(imagePath, parsed, sourceImageRef);

      await writePrettyJson(recognizedPath, record);
      upsertByImage(records, record);
      successCount += 1;
      console.log(`[ok] ${relativeImage} -> ${record.id} (${record.student_count} students)`);
    } catch (err) {
      console.error(`[error] ${relativeImage}: ${err.message}`);
    }
  }

  const dedupedRecords = dedupeRecords(records);
  const finalPayload = {
    generated_at: nowIso(),
    source_input_dir: path.relative(ROOT, args.input).replace(/\\/g, "/"),
    effective_input_dir: path.relative(ROOT, effectiveInputDir).replace(/\\/g, "/"),
    model,
    records: dedupedRecords,
  };
  await writePrettyJson(PENDING_FILE, finalPayload);

  console.log("");
  console.log(`Processed: ${processedCount}`);
  console.log(`Success:   ${successCount}`);
  console.log(`Pending:   ${dedupedRecords.length}`);
  console.log(`Output:    ${path.relative(ROOT, PENDING_FILE)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
