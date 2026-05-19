import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function parseArgs(argv) {
  const args = {
    courseId: "3389",
    months: ["2026-03", "2026-04"],
    targetNote: "指導作頁",
    commit: false,
    verbose: false,
    output: path.join(ROOT, "data", "submit", "fix-notes-result.json"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--course-id" && argv[i + 1]) args.courseId = argv[++i];
    else if (t === "--months" && argv[i + 1]) {
      args.months = argv[++i].split(",").map((x) => x.trim()).filter(Boolean);
    } else if (t === "--target-note" && argv[i + 1]) args.targetNote = argv[++i];
    else if (t === "--commit") args.commit = true;
    else if (t === "--verbose") args.verbose = true;
    else if (t === "--output" && argv[i + 1]) args.output = path.resolve(ROOT, argv[++i]);
    else if (t === "--help" || t === "-h") {
      console.log(`Usage:
  node crawler/fix-notes.mjs [--course-id 3389] [--months 2026-03,2026-04] [--target-note 指導作頁] [--commit]
`);
      process.exit(0);
    }
  }
  return args;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
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

function norm(v) {
  return decodeHtmlEntities(stripTags(v)).replace(/\s+/g, "");
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
    return { res, text: await res.text() };
  }
  async postForm(urlOrPath, formObj) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(formObj)) {
      if (Array.isArray(v)) for (const item of v) body.append(k, String(item ?? ""));
      else body.append(k, String(v ?? ""));
    }
    const res = await this.request(urlOrPath, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "follow",
    });
    return { res, text: await res.text() };
  }
}

async function login(session, env) {
  await session.getText(env.LOGIN_WEBSITE);
  await session.postForm("check_login.php", { do: "login", rt_01: env.ACCOUNT, rt_02: env.PASSWORD });
  const home = await session.getText("index.php");
  if (!/logout\.php|登出|登入資訊/i.test(home.text)) throw new Error("login failed");
}

function extractRowCandidates(monthHtml, targetNote) {
  const rows = [];
  const rowRe = /<tr class='dg_tr'[\s\S]*?<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(monthHtml)) !== null) {
    const row = m[0];
    const rid = (row.match(/mem__doPostBack\('edit','(\d+)'/i) || [])[1];
    if (!rid) continue;
    const dateTime = (row.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}~\d{2}:\d{2})/) || [])[1] || "";
    if (!dateTime) continue;

    const dateEsc = dateTime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const noteMatch = row.match(
      new RegExp(`${dateEsc}[\\s\\S]*?<\\/td>\\s*<td[^>]*>\\s*<label[^>]*>([\\s\\S]*?)<\\/label>`, "i"),
    );
    const note = noteMatch ? decodeHtmlEntities(stripTags(noteMatch[1])) : "";

    if (norm(note) === norm(targetNote)) continue;
    rows.push({ rid, date_time: dateTime, old_note: note });
  }
  return rows;
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
  const re = new RegExp(`<input[^>]*name=['"]${name}['"][^>]*value=['"]([^'"]*)['"]`, "i");
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1]) : "";
}

function extractTextareaValue(html, name) {
  const re = new RegExp(`<textarea[^>]*name=['"]${name}['"][^>]*>([\\s\\S]*?)<\\/textarea>`, "i");
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1]) : "";
}

function extractSelectedValue(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reSelect = new RegExp(
    `<select[^>]*(?:name=['"]${escaped}['"]|id=['"]${escaped}['"])[^>]*>([\\s\\S]*?)<\\/select>`,
    "i",
  );
  const sm = html.match(reSelect);
  if (!sm) return "";
  const selected =
    sm[1].match(/<option[^>]*selected[^>]*value=['"]([^'"]*)['"]/i) ||
    sm[1].match(/<option[^>]*value=['"]([^'"]*)['"]/i);
  return selected ? decodeHtmlEntities(selected[1]) : "";
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await readEnvFile(path.join(ROOT, ".env"));
  if (!env.ACCOUNT || !env.PASSWORD || !env.LOGIN_WEBSITE) {
    throw new Error(".env missing ACCOUNT/PASSWORD/LOGIN_WEBSITE");
  }
  const siteRoot = (() => {
    const u = new URL(env.LOGIN_WEBSITE);
    return `${u.protocol}//${u.host}`;
  })();
  const session = new HttpSession(siteRoot);
  await login(session, env);

  const report = {
    run_at: nowIso(),
    commit: args.commit,
    course_id: args.courseId,
    months: args.months,
    target_note: args.targetNote,
    results: [],
  };

  for (const month of args.months) {
    const listUrl = `pages/course006.php?cc=&tareplyid=${encodeURIComponent(args.courseId)}&tareplymonth=${encodeURIComponent(month)}`;
    const listPage = await session.getText(listUrl);
    const rows = extractRowCandidates(listPage.text, args.targetNote);

    for (const row of rows) {
      const rec = {
        month,
        rid: row.rid,
        date_time: row.date_time,
        old_note: row.old_note,
        new_note: args.targetNote,
        status: "planned",
      };

      const editUrl =
        `pages/course006.php?mem_mode=edit&mem_rid=${encodeURIComponent(row.rid)}` +
        `&mem_page_size=20&mem_p=1&tareplymonth=${encodeURIComponent(month)}&tareplyid=${encodeURIComponent(args.courseId)}`;
      const editPage = await session.getText(editUrl);

      const hidden = extractHiddenInputs(editPage.text);
      const payload = {
        ...hidden,
        ryyTaCourseName: extractSelectedValue(editPage.text, "ryyTaCourseName") || args.courseId,
        ryycouse_010: extractInputValue(editPage.text, "ryycouse_010") || "12:00",
        ryycouse_011: extractInputValue(editPage.text, "ryycouse_011") || "13:00",
        ryyTaCourseNotes: args.targetNote,
        syycouse_001: hidden.syycouse_001 || "",
        syycouse_002:
          hidden.syycouse_002 && hidden.syycouse_002 !== "0"
            ? hidden.syycouse_002
            : String((hidden.syycouse_001 || "").split("##").filter(Boolean).length),
      };

      if (!args.commit) {
        rec.status = "dry-run";
        report.results.push(rec);
        continue;
      }

      await session.postForm(editUrl, payload);

      const verify = await session.getText(listUrl);
      const foundRow = verify.text.includes(`mem__doPostBack('edit','${row.rid}'`);
      const noteOk = verify.text.includes(args.targetNote);
      if (foundRow && noteOk) {
        rec.status = "updated";
      } else {
        rec.status = "update-uncertain";
      }
      report.results.push(rec);
    }
  }

  await ensureDir(path.dirname(args.output));
  await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const summary = report.results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`Mode: ${args.commit ? "commit" : "dry-run"}`);
  console.log(`Target note: ${args.targetNote}`);
  console.log(`Rows found: ${report.results.length}`);
  for (const [k, v] of Object.entries(summary)) console.log(`- ${k}: ${v}`);
  console.log(`Report: ${path.relative(ROOT, args.output)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
