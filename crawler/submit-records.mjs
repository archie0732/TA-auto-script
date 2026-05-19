import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function parseArgs(argv) {
  const args = {
    input: path.join(ROOT, "data", "approved", "to-submit.json"),
    commit: false,
    courseId: "",
    signIn: "12:00",
    signOut: "13:00",
    notes: "指導作頁",
    limit: 0,
    verbose: false,
    output: path.join(ROOT, "data", "submit", "submit-result.json"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input" && argv[i + 1]) args.input = path.resolve(ROOT, argv[++i]);
    else if (token === "--output" && argv[i + 1]) args.output = path.resolve(ROOT, argv[++i]);
    else if (token === "--course-id" && argv[i + 1]) args.courseId = argv[++i];
    else if (token === "--sign-in" && argv[i + 1]) args.signIn = argv[++i];
    else if (token === "--sign-out" && argv[i + 1]) args.signOut = argv[++i];
    else if (token === "--notes" && argv[i + 1]) args.notes = argv[++i];
    else if (token === "--limit" && argv[i + 1]) args.limit = Number(argv[++i]) || 0;
    else if (token === "--commit") args.commit = true;
    else if (token === "--verbose") args.verbose = true;
    else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node crawler/submit-records.mjs [--input data/approved/to-submit.json] [--commit]

Options:
  --commit                 實際送出 (預設 dry-run)
  --course-id 3389         指定課程 ID，不走名稱比對
  --sign-in 12:00          簽到時間
  --sign-out 13:00         簽退時間
  --notes 指導作頁         課輔內容
  --limit 5                只處理前 N 筆 session
  --verbose                顯示更多除錯資訊
`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

async function readEnvFile(envPath) {
  const env = {};
  const raw = await fs.readFile(envPath, "utf8");
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

function stripTags(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normText(v) {
  return decodeHtmlEntities(stripTags(v)).replace(/\s+/g, "").toLowerCase();
}

function isValidTime(v) {
  return /^\d{2}:\d{2}$/.test(String(v ?? "").trim());
}

function isValidDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
}

function joinIdsForSubmit(ids) {
  const unique = [];
  const seen = new Set();
  for (const id of ids || []) {
    const cleaned = String(id ?? "").replace(/[^\d]/g, "");
    if (!/^\d{9}$/.test(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    unique.push(cleaned);
  }
  return unique;
}

function extractOptions(html, selectNameOrId) {
  const escaped = selectNameOrId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reSelect = new RegExp(
    `<select[^>]*(?:name=['"]${escaped}['"]|id=['"]${escaped}['"])[^>]*>([\\s\\S]*?)<\\/select>`,
    "i",
  );
  const match = html.match(reSelect);
  if (!match) return [];

  const options = [];
  const optionRe = /<option[^>]*value=['"]([^'"]*)['"][^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optionRe.exec(match[1])) !== null) {
    options.push({
      value: decodeHtmlEntities(m[1]).trim(),
      label: decodeHtmlEntities(stripTags(m[2])).trim(),
    });
  }
  return options;
}

function extractHiddenInputs(html) {
  const out = {};
  const re = /<input[^>]*type=['"]hidden['"][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const name = (tag.match(/\bname=['"]([^'"]+)['"]/i) || [])[1];
    const value = (tag.match(/\bvalue=['"]([^'"]*)['"]/i) || [])[1] ?? "";
    if (name) out[name] = decodeHtmlEntities(value);
  }
  return out;
}

function extractInputValue(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<input[^>]*name=['"]${escaped}['"][^>]*value=['"]([^'"]*)['"]`,
    "i",
  );
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1]) : "";
}

function extractSelectedValue(html, selectNameOrId) {
  const options = extractOptions(html, selectNameOrId);
  if (options.length === 0) return "";
  const escaped = selectNameOrId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reSelect = new RegExp(
    `<select[^>]*(?:name=['"]${escaped}['"]|id=['"]${escaped}['"])[^>]*>([\\s\\S]*?)<\\/select>`,
    "i",
  );
  const sm = html.match(reSelect);
  if (!sm) return options[0].value;
  const selected =
    sm[1].match(/<option[^>]*selected[^>]*value=['"]([^'"]*)['"]/i) ||
    sm[1].match(/<option[^>]*value=['"]([^'"]*)['"]/i);
  return selected ? decodeHtmlEntities(selected[1]) : options[0].value;
}

class HttpSession {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cookies = new Map();
  }

  buildUrl(input) {
    if (/^https?:\/\//i.test(input)) return input;
    return `${this.baseUrl}/${String(input).replace(/^\/+/, "")}`;
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  storeSetCookie(setCookie) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of list) {
      const first = String(raw).split(";")[0];
      const idx = first.indexOf("=");
      if (idx <= 0) continue;
      const key = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (!key) continue;
      this.cookies.set(key, value);
    }
  }

  async request(urlOrPath, options = {}) {
    const url = this.buildUrl(urlOrPath);
    const headers = new Headers(options.headers || {});
    const cookie = this.cookieHeader();
    if (cookie) headers.set("cookie", cookie);

    const res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
      redirect: options.redirect || "follow",
    });
    this.storeSetCookie(res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get("set-cookie"));
    return res;
  }

  async getText(urlOrPath) {
    const res = await this.request(urlOrPath, { method: "GET" });
    const text = await res.text();
    return { res, text };
  }

  async postForm(urlOrPath, formObj) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(formObj)) {
      if (Array.isArray(v)) {
        for (const item of v) body.append(k, String(item ?? ""));
      } else {
        body.append(k, String(v ?? ""));
      }
    }
    const res = await this.request(urlOrPath, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "follow",
    });
    const text = await res.text();
    return { res, text };
  }
}

function flattenTasks(records, fallbackNotes) {
  const tasks = [];
  for (const rec of records || []) {
    const recordNotes = String(fallbackNotes ?? "").trim();
    if (Array.isArray(rec.sessions) && rec.sessions.length > 0) {
      for (const sess of rec.sessions) {
        tasks.push({
          record_id: rec.id || "",
          source_image: rec.source_image || "",
          session_date: String(sess.session_date ?? "").trim(),
          class_group: String(sess.class_group ?? rec.class_group ?? "").trim(),
          course_name: String(rec.course_name ?? "").trim(),
          student_ids: sess.student_ids || [],
          notes: recordNotes,
        });
      }
      continue;
    }
    tasks.push({
      record_id: rec.id || "",
      source_image: rec.source_image || "",
      session_date: String(rec.session_date ?? "").trim(),
      class_group: String(rec.class_group ?? "").trim(),
      course_name: String(rec.course_name ?? "").trim(),
      student_ids: rec.student_ids || [],
      notes: recordNotes,
    });
  }
  return tasks;
}

function pickCourseId(courseOptions, targetName, fallbackCourseId) {
  if (fallbackCourseId) return fallbackCourseId;
  if (courseOptions.length === 1 && courseOptions[0].value) return courseOptions[0].value;
  const targetNorm = normText(targetName);
  if (!targetNorm) return "";

  for (const opt of courseOptions) {
    if (normText(opt.label) === targetNorm) return opt.value;
  }
  for (const opt of courseOptions) {
    if (normText(opt.label).includes(targetNorm)) return opt.value;
  }
  for (const opt of courseOptions) {
    if (targetNorm.includes(normText(opt.label))) return opt.value;
  }
  return "";
}

function pickCourseNum(courseNumOptions, sessionDate) {
  const prefix = `${sessionDate} `;
  const first = courseNumOptions.find((opt) => opt.value.startsWith(prefix));
  if (first) return first.value;
  const second = courseNumOptions.find((opt) => opt.label.startsWith(prefix));
  if (second) return second.value || second.label;
  return "";
}

function extractMonthRows(monthHtml) {
  const rows = [];
  const rowRe = /<tr class='dg_tr'[\s\S]*?<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(monthHtml)) !== null) {
    const row = m[0];
    const rid = (row.match(/mem__doPostBack\('edit','(\d+)'/i) || [])[1];
    if (!rid) continue;
    const dateTime = (row.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}~\d{2}:\d{2})/) || [])[1] || "";
    if (!dateTime) continue;
    const courseName = "";
    const note = "";
    rows.push({ rid, course_name: courseName, date_time: dateTime, note });
  }
  return rows;
}

function findExistingRidByCourseNum(monthHtml, courseNumValue) {
  const rows = extractMonthRows(monthHtml);
  const target = normText(courseNumValue);
  for (const r of rows) {
    if (normText(r.date_time) === target) return r.rid;
  }
  return "";
}

function findExistingRowByDate(monthHtml, sessionDate) {
  const rows = extractMonthRows(monthHtml);
  for (const r of rows) {
    if (String(r.date_time).startsWith(`${sessionDate} `)) return r;
  }
  return null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verifyRowExists(monthHtml, courseNumValue, studentIds) {
  const dateRe = new RegExp(escapeRegExp(courseNumValue));
  if (!dateRe.test(monthHtml)) return false;
  for (const id of studentIds) {
    if (new RegExp(escapeRegExp(id)).test(monthHtml)) return true;
  }
  return false;
}

function extractAlerts(html) {
  const out = [];
  const re = /alert\((['"])([\s\S]*?)\1\)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const msg = decodeHtmlEntities(stripTags(m[2])).trim();
    if (msg) out.push(msg);
  }
  return out;
}

async function login(session, env, verbose = false) {
  await session.getText(env.LOGIN_WEBSITE);
  const loginResp = await session.postForm("check_login.php", {
    do: "login",
    rt_01: env.ACCOUNT,
    rt_02: env.PASSWORD,
  });
  if (verbose) {
    console.log(`[login] status=${loginResp.res.status}`);
  }

  const home = await session.getText("index.php");
  const ok = /logout\.php|登出|登入資訊/i.test(home.text);
  if (!ok) {
    throw new Error("登入失敗：未偵測到登入後頁面特徵");
  }
}

async function fetchCourseOptions(session) {
  const { text } = await session.getText("pages/course006.php?mmmid=149");
  return extractOptions(text, "tareplyid").filter((o) => o.value);
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!isValidTime(args.signIn) || !isValidTime(args.signOut)) {
    throw new Error("簽到/簽退時間格式需為 HH:mm，例如 12:00");
  }

  const env = await readEnvFile(path.join(ROOT, ".env"));
  if (!env.ACCOUNT || !env.PASSWORD || !env.LOGIN_WEBSITE) {
    throw new Error(".env 缺少 ACCOUNT/PASSWORD/LOGIN_WEBSITE");
  }

  const inputJson = await readJson(args.input);
  const inputRecords = Array.isArray(inputJson.records) ? inputJson.records : [];
  const allTasks = flattenTasks(inputRecords, args.notes);
  const tasks = args.limit > 0 ? allTasks.slice(0, args.limit) : allTasks;
  if (tasks.length === 0) {
    console.log("No tasks to submit.");
    return;
  }

  const siteRoot = (() => {
    const u = new URL(env.LOGIN_WEBSITE);
    return `${u.protocol}//${u.host}`;
  })();
  const session = new HttpSession(siteRoot);
  await login(session, env, args.verbose);

  const courseOptions = await fetchCourseOptions(session);
  if (courseOptions.length === 0 && !args.courseId) {
    throw new Error("無法取得可用課程清單，且未指定 --course-id");
  }

  const report = {
    run_at: nowIso(),
    commit: args.commit,
    input: path.relative(ROOT, args.input),
    model_hint: inputJson.model || "",
    total_tasks: tasks.length,
    results: [],
  };

  for (const task of tasks) {
    const result = {
      record_id: task.record_id,
      source_image: task.source_image,
      session_date: task.session_date,
      class_group: task.class_group,
      course_name: task.course_name,
      notes_used: args.notes,
      status: "skipped",
      reason: "",
      submitted: false,
    };

    if (!isValidDate(task.session_date)) {
      result.reason = "invalid session_date format (need YYYY-MM-DD)";
      report.results.push(result);
      continue;
    }

    const validIds = joinIdsForSubmit(task.student_ids);
    if (validIds.length === 0) {
      result.reason = "no valid 9-digit student ids";
      report.results.push(result);
      continue;
    }

    const courseId = pickCourseId(courseOptions, task.course_name, args.courseId);
    if (!courseId) {
      result.reason = "cannot map course_name to course id";
      report.results.push(result);
      continue;
    }

    const month = task.session_date.slice(0, 7);
    const monthUrl = `pages/course006.php?cc=&tareplyid=${encodeURIComponent(
      courseId,
    )}&tareplymonth=${encodeURIComponent(month)}`;
    const monthPageBefore = await session.getText(monthUrl);

    const addUrl =
      `pages/course006.php?mem_mode=add&mem_rid=-1&mem_page_size=20&mem_p=1` +
      `&tareplymonth=${encodeURIComponent(month)}&tareplyid=${encodeURIComponent(courseId)}`;
    const addPage = await session.getText(addUrl);
    const hidden = extractHiddenInputs(addPage.text);
    const courseNumOptions = extractOptions(addPage.text, "ryyTaCourseNum");
    const existingRow = findExistingRowByDate(monthPageBefore.text, task.session_date);
    const fallbackCourseNumValue = pickCourseNum(courseNumOptions, task.session_date);
    const courseNumValue = existingRow?.date_time || fallbackCourseNumValue;
    if (!existingRow && !courseNumValue) {
      result.reason = `cannot find course time slot for ${task.session_date}`;
      report.results.push(result);
      continue;
    }

    const existingRid = existingRow?.rid || findExistingRidByCourseNum(monthPageBefore.text, courseNumValue);
    let submitUrl = addUrl;
    let submitPayload = {
      ...hidden,
      mem__operation_randomize_code: hidden.mem__operation_randomize_code || "",
      mem_mode: hidden.mem_mode || "update",
      mem_rid: hidden.mem_rid || "-1",
      mem_page_size: hidden.mem_page_size || "20",
      mem_p: hidden.mem_p || "1",
      mem_new: hidden.mem_new || "1",
      ryyTaCourseName: courseId,
      ryyTaCourseNum: courseNumValue,
      ryycouse_010: args.signIn,
      ryycouse_011: args.signOut,
      ryyTaCourseNotes: args.notes,
      syycouse_001: validIds.join("##"),
      syycouse_002: String(validIds.length),
    };
    result.existing_rid = existingRid || "";

    if (existingRid) {
      submitUrl =
        `pages/course006.php?mem_mode=edit&mem_rid=${encodeURIComponent(existingRid)}` +
        `&mem_page_size=20&mem_p=1&tareplymonth=${encodeURIComponent(month)}&tareplyid=${encodeURIComponent(courseId)}`;
      const editPage = await session.getText(submitUrl);
      const editHidden = extractHiddenInputs(editPage.text);
      const currentSignIn = extractInputValue(editPage.text, "ryycouse_010") || args.signIn;
      const currentSignOut = extractInputValue(editPage.text, "ryycouse_011") || args.signOut;
      const currentCourseName = extractSelectedValue(editPage.text, "ryyTaCourseName") || courseId;
      submitPayload = {
        ...editHidden,
        ryyTaCourseName: currentCourseName,
        ryycouse_010: currentSignIn,
        ryycouse_011: currentSignOut,
        ryyTaCourseNotes: args.notes,
        syycouse_001: validIds.join("##"),
        syycouse_002: String(validIds.length),
      };
      result.mode = "update-existing";
    } else {
      result.mode = "add-new";
    }

    result.course_id = courseId;
    result.course_num = courseNumValue;
    result.student_count = validIds.length;

    if (!args.commit) {
      result.status = "dry-run-ok";
      result.reason = "validated only";
      report.results.push(result);
      continue;
    }

    const submitResp = await session.postForm(submitUrl, submitPayload);
    if (args.verbose) {
      result.response_preview = decodeHtmlEntities(stripTags(submitResp.text)).slice(0, 300);
      const alerts = extractAlerts(submitResp.text);
      if (alerts.length > 0) result.response_alerts = alerts;
    }

    const verifyUrl = `pages/course006.php?cc=&tareplyid=${encodeURIComponent(
      courseId,
    )}&tareplymonth=${encodeURIComponent(month)}`;
    const verifyPage = await session.getText(verifyUrl);
    const persisted = verifyRowExists(verifyPage.text, courseNumValue, validIds);

    if (persisted) {
      result.status = "submitted";
      result.submitted = true;
      result.reason = "submitted+verified";
    } else {
      result.status = "submit-not-persisted";
      result.reason = "post returned but record not found on month page";
    }
    report.results.push(result);
  }

  await ensureDir(path.dirname(args.output));
  await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const summary = report.results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    {},
  );

  console.log(`Mode: ${args.commit ? "commit" : "dry-run"}`);
  console.log(`Tasks: ${tasks.length}`);
  for (const [k, v] of Object.entries(summary)) {
    console.log(`- ${k}: ${v}`);
  }
  console.log(`Report: ${path.relative(ROOT, args.output)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
