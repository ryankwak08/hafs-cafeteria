import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import https from "https";
import http from "http";
// Optional (recommended) for Kakao: resize/compress images so Kakao can fetch reliably
let sharp = null;
try {
  const mod = await import("sharp");
  sharp = mod.default || mod;
} catch {
  sharp = null;
}

// Playwright is optional (used to bypass NitroEye blocks when curl/axios gets 302 to nitroeye)
let chromium = null;
async function getChromium() {
  if (chromium) return chromium;
  try {
    const mod = await import("playwright");
    chromium = mod.chromium;
    return chromium;
  } catch {
    return null;
  }
}

// =========================================================
// HAFS Cafeteria Bot (rebuild)
// - Buttons: 아침/점심/저녁/오늘/내일/이번주
// - All menus scraped from HAFS site (NO NEIS)
// - Primary strategy: fetch HTML via HTTP (NitroEye often blocks HTTPS with 302)
// - Image proxy kept (optional, used by photo features if you add later)
// =========================================================

const app = express();
app.set("trust proxy", true);
app.use(express.json());

// --- Minimal request logger (useful when Kakao image fetch seems to not hit /img) ---
// NOTE: Render shows stdout logs under the "Logs" tab (not build logs).
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path || "";

  // Only log key routes to avoid noise
  const shouldLog = path === "/kakao" || path === "/img" || path === "/menu";
  if (!shouldLog) return next();

  const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.ip || req.socket?.remoteAddress || "";
  const ua = (req.headers["user-agent"] || "").toString();

  // Avoid printing huge query strings; keep it small
  const q = req.query && Object.keys(req.query).length ? JSON.stringify(req.query).slice(0, 240) : "";

  console.log("[REQ]", {
    t: new Date().toISOString(),
    method: req.method,
    path,
    ip,
    ua: ua.slice(0, 120),
    q,
  });

  res.on("finish", () => {
    console.log("[RES]", {
      t: new Date().toISOString(),
      method: req.method,
      path,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });

  next();
});

// Agents (IPv4 first helps some networks)
const httpsAgent = new https.Agent({ family: 4 });
const httpAgent = new http.Agent({ family: 4 });

// IMPORTANT: do NOT use www.hafs.hs.kr (TLS SAN mismatch)
const HAFS_HOST = "hafs.hs.kr";
const CAFETERIA_CODE = "171113";

// In some environments DNS fails; allow IP fallback.
// If you ever need it, set: HAFS_IP_FALLBACK=114.31.59.153
const HAFS_IP_FALLBACK = process.env.HAFS_IP_FALLBACK || "";
const httpsAgentHafsIp = new https.Agent({
  family: 4,
  servername: "hafs.hs.kr", // keep SNI for cert
});

const BASE_URL = (process.env.BASE_URL || "").trim();

// ----------------- Kakao UI helpers -----------------
function menuQuickReplies() {
  return [
    { label: "아침", action: "message", messageText: "아침" },
    { label: "점심", action: "message", messageText: "점심" },
    { label: "저녁", action: "message", messageText: "저녁" },
    { label: "오늘", action: "message", messageText: "오늘" },
    { label: "내일", action: "message", messageText: "내일" },
    { label: "이번주", action: "message", messageText: "이번주" },
  ];
}

function photoQuickReply(ymd, mealKey) {
  return [{ label: "식단 사진 보기", action: "message", messageText: `사진|${ymd}|${mealKey}` }];
}

function kakaoText(text, quickReplies = menuQuickReplies()) {
  const tpl = {
    outputs: [{ simpleText: { text } }],
  };
  if (Array.isArray(quickReplies) && quickReplies.length > 0) {
    tpl.quickReplies = quickReplies;
  }
  return { version: "2.0", template: tpl };
}

function kakaoImageCard(titleText, imageUrl, altText, quickReplies = null) {
  const outputs = [
    { simpleText: { text: titleText } },
    { simpleImage: { imageUrl, altText: altText || titleText } },
  ];
  const tpl = { outputs };
  if (Array.isArray(quickReplies) && quickReplies.length > 0) {
    tpl.quickReplies = quickReplies;
  }
  return { version: "2.0", template: tpl };
}


// ----------------- Date utils -----------------
function pad2(n) {
  return String(n).padStart(2, "0");
}

function yyyymmdd(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function prettyYmd(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function ymdToDot(ymd) {
  // YYYYMMDD -> YYYY.MM.DD
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

// ----------------- Network / NitroEye handling -----------------
let HAFS_COOKIE = "";

// -------- Playwright fallback (real browser fetch) --------
let pwBrowserPromise = null;

async function getPwBrowser() {
  const chr = await getChromium();
  if (!chr) return null;

  if (!pwBrowserPromise) {
    pwBrowserPromise = chr.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return pwBrowserPromise;
}

async function fetchHtmlWithPlaywright(targetUrl, timeoutMs = 15000) {
  const browser = await getPwBrowser();
  if (!browser) {
    const err = new Error("PLAYWRIGHT_NOT_INSTALLED");
    err.code = "PLAYWRIGHT_NOT_INSTALLED";
    throw err;
  }

  const headers = buildBrowserHeaders();

  const context = await browser.newContext({
    userAgent: headers["User-Agent"],
    locale: "ko-KR",
    extraHTTPHeaders: {
      Accept: headers.Accept,
      "Accept-Language": headers["Accept-Language"],
      "Accept-Encoding": headers["Accept-Encoding"],
      Connection: headers.Connection,
      "Upgrade-Insecure-Requests": headers["Upgrade-Insecure-Requests"],
      Referer: headers.Referer,
      ...(HAFS_COOKIE ? { Cookie: HAFS_COOKIE } : {}),
    },
    ignoreHTTPSErrors: false,
  });

  const page = await context.newPage();

  // Helper: detect firewall by URL or body
  const isFirewallPage = async () => {
    const u = page.url();
    if (u.includes("nitroeye.co.kr/404_firewall")) return true;
    try {
      const body = await page.content();
      return String(body).includes("nitroeye.co.kr/404_firewall") || String(body).includes("404_firewall");
    } catch {
      return false;
    }
  };

  // Helper: wait until meal keywords appear (site sometimes renders after load)
  const waitForMeals = async () => {
    try {
      await page.waitForFunction(
        () => {
          const t = (document.body && document.body.innerText) ? document.body.innerText : "";
          return t.includes("조식") || t.includes("중식") || t.includes("석식") || t.includes("야식");
        },
        { timeout: Math.min(6000, Math.max(2000, Math.floor(timeoutMs / 2))) }
      );
    } catch {
      // ignore: some days might have no meals rendered; parsing will handle empty
    }
  };

  // Try https first (browser often succeeds where axios/curl is blocked), then http.
  const httpsUrl = String(targetUrl).replace(/^http:\/\//i, "https://");
  const httpUrl = String(targetUrl).replace(/^https:\/\//i, "http://");
  const candidates = [httpsUrl, httpUrl];

  try {
    let lastFirewall = false;

    for (const u of candidates) {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: timeoutMs });

      // If blocked, try the next scheme
      lastFirewall = await isFirewallPage();
      if (lastFirewall) continue;

      // Give time for dynamic content, then wait for meal text if present
      await page.waitForTimeout(250);
      await waitForMeals();

      // If after waiting we suddenly got the firewall page, treat as blocked
      lastFirewall = await isFirewallPage();
      if (lastFirewall) continue;

      const content = await page.content();

      // Update cookie jar from browser context
      try {
        const cookies = await context.cookies();
        const cookieStr = cookies
          .map((c) => `${c.name}=${c.value}`)
          .filter(Boolean)
          .join("; ");
        if (cookieStr) HAFS_COOKIE = cookieStr;
      } catch {}

      return content;
    }

    if (lastFirewall) {
      const err = new Error("HAFS_FIREWALL_BLOCK");
      err.code = "HAFS_FIREWALL";
      throw err;
    }

    // If neither worked, surface a generic error
    throw new Error("HAFS_FETCH_FAILED");
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function buildBrowserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    Referer: `http://${HAFS_HOST}/`,
    ...(HAFS_COOKIE ? { Cookie: HAFS_COOKIE } : {}),
  };
}

function updateCookieFromResponse(resp) {
  const setCookie = resp?.headers?.["set-cookie"];
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie = arr
    .map((c) => String(c).split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (cookie) HAFS_COOKIE = cookie;
}

function isFirewall(resp) {
  const loc = String(resp?.headers?.location || "");
  if (loc.includes("nitroeye.co.kr/404_firewall")) return true;
  try {
    const body = resp?.data ? Buffer.from(resp.data).toString("utf-8") : "";
    return body.includes("nitroeye.co.kr") || body.includes("404_firewall");
  } catch {
    return false;
  }
}

function isRedirect(resp) {
  const s = Number(resp?.status || 0);
  return s >= 300 && s < 400;
}

function resolveRedirectUrl(currentUrl, location) {
  try {
    // Handles relative redirects
    return new URL(location, currentUrl).toString();
  } catch {
    return location;
  }
}

function toIpUrl(originalUrl) {
  if (!HAFS_IP_FALLBACK) return originalUrl;
  try {
    const u = new URL(originalUrl);
    u.hostname = HAFS_IP_FALLBACK;
    return u.toString();
  } catch {
    return originalUrl;
  }
}

async function getHtmlArrayBuffer(url, timeoutMs = 7000) {
  // Fast path: try plain HTTP/HTTPS with axios first (much faster than Playwright).
  // Fallback to Playwright ONLY when NitroEye blocks (302 to nitroeye / firewall body).

  const headers = buildBrowserHeaders();

  // Try both schemes (many environments: HTTPS -> NitroEye 302, HTTP often works)
  const httpsUrl = String(url).replace(/^http:\/\//i, "https://");
  const httpUrl = String(url).replace(/^https:\/\//i, "http://");
  const candidates = [httpUrl, httpsUrl];

  const tryAxios = async (u) => {
    // Some environments have DNS issues; allow IP fallback.
    const ipUrl = toIpUrl(u);
    const useIp = HAFS_IP_FALLBACK && ipUrl !== u;

    const resp = await axios.get(ipUrl, {
      responseType: "arraybuffer",
      timeout: Math.min(Math.max(timeoutMs, 2500), 6000),
      // Important: do NOT auto-follow redirects; we want to detect NitroEye quickly.
      maxRedirects: 0,
      validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      headers: {
        ...headers,
        // When using IP, preserve SNI+Host for TLS cert / virtual host routing.
        ...(useIp ? { Host: HAFS_HOST } : {}),
      },
      // Use agents (IPv4 first)
      httpAgent,
      httpsAgent: useIp ? httpsAgentHafsIp : httpsAgent,
    });

    updateCookieFromResponse(resp);

    // If redirecting to NitroEye, treat as firewall.
    if (isRedirect(resp) && isFirewall(resp)) {
      const err = new Error("HAFS_FIREWALL_BLOCK");
      err.code = "HAFS_FIREWALL";
      throw err;
    }

    // If a redirect happens, follow it once manually (still faster than Playwright).
    if (isRedirect(resp)) {
      const loc = String(resp.headers?.location || "");
      const nextUrl = resolveRedirectUrl(u, loc);
      if (loc.includes("nitroeye.co.kr/404_firewall")) {
        const err = new Error("HAFS_FIREWALL_BLOCK");
        err.code = "HAFS_FIREWALL";
        throw err;
      }
      const resp2 = await axios.get(toIpUrl(nextUrl), {
        responseType: "arraybuffer",
        timeout: Math.min(Math.max(timeoutMs, 2500), 6000),
        maxRedirects: 0,
        validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
        headers: {
          ...headers,
          ...(HAFS_IP_FALLBACK && toIpUrl(nextUrl) !== nextUrl ? { Host: HAFS_HOST } : {}),
        },
        httpAgent,
        httpsAgent: (HAFS_IP_FALLBACK && toIpUrl(nextUrl) !== nextUrl) ? httpsAgentHafsIp : httpsAgent,
      });
      updateCookieFromResponse(resp2);
      if (isRedirect(resp2) && isFirewall(resp2)) {
        const err = new Error("HAFS_FIREWALL_BLOCK");
        err.code = "HAFS_FIREWALL";
        throw err;
      }
      return resp2;
    }

    // Some blocks return 200 with firewall HTML.
    if (isFirewall(resp)) {
      const err = new Error("HAFS_FIREWALL_BLOCK");
      err.code = "HAFS_FIREWALL";
      throw err;
    }

    return resp;
  };

  let lastErr = null;
  for (const u of candidates) {
    try {
      return await tryAxios(u);
    } catch (e) {
      lastErr = e;
      // If it wasn't a firewall error, continue to next scheme.
      continue;
    }
  }

  // Slow fallback: real browser fetch.
  // Keep this timeout tight so Kakao doesn't hang too long.
  try {
    const html = await fetchHtmlWithPlaywright(url, 9000);
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      data: iconv.encode(html, "euc-kr"),
    };
  } catch (e) {
    // Prefer original firewall code if present
    throw lastErr || e;
  }
}

function decodeHafsHtml(arrayBuffer) {
  const buf = Buffer.from(arrayBuffer);
  try {
    return iconv.decode(buf, "euc-kr");
  } catch {
    return buf.toString("utf-8");
  }
}

function hafsMonthUrl(ymd) {
  // HAFS uses month param as YYYY.MM.DD
  return `http://${HAFS_HOST}/?act=lunch.main2&code=${CAFETERIA_CODE}&month=${ymdToDot(ymd)}`;
}

function hafsDayUrl(ymd) {
  // Same endpoint; day view works by passing the specific date
  return `http://${HAFS_HOST}/?act=lunch.main2&code=${CAFETERIA_CODE}&month=${ymdToDot(ymd)}`;
}

// ----------------- Parsing -----------------
function normalizeHtmlToTextKeepingYa(html) {
  const noScript = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const YA_PLACEHOLDER = "__YA_SNACK__";

  let text = noScript
    // Preserve meal labels that appear as images (e.g., <img alt="조식">)
    .replace(/<img[^>]*(?:alt|title)\s*=\s*"([^"]+)"[^>]*>/gi, (m, a1) => {
      const t = String(a1 || "").replace(/\s+/g, " ").trim();
      if (t.includes("조식") || t.includes("중식") || t.includes("석식") || t.includes("야식")) {
        return "\n" + t + "\n";
      }
      return "\n";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;\s*야식\s*&gt;/gi, `\n${YA_PLACEHOLDER}\n`)
    .replace(/<\s*야식\s*>/gi, `\n${YA_PLACEHOLDER}\n`)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(new RegExp(YA_PLACEHOLDER, "g"), "<야식>");

  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  return lines.join("\n");
}

function cleanHafsText(text) {
  if (!text) return "";

  // Lines that are not actual menu items and often appear in HAFS markup
  const dropPhrases = [
    "사진",
    "식단사진",
    "에너지",
    "탄수화물",
    "단백질",
    "지방",
    "칼슘",
    "kcal",
  ];

  const lines = String(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    // remove nutrition labels / non-menu labels
    .filter((l) => !dropPhrases.some((p) => l === p || l.includes(p)))
    // remove very short badges
    .filter((l) => l.length >= 2);

  const uniq = [];
  const seen = new Set();
  for (const l of lines) {
    if (!seen.has(l)) {
      seen.add(l);
      uniq.push(l);
    }
  }
  return uniq.join("\n").trim();
}

function extractMealFromText(joinedText, label) {
  // label: 조식/중식/석식
  const idx = joinedText.lastIndexOf(label);
  if (idx < 0) return null;

  const after = joinedText.slice(idx + label.length);
  const stopKeys = [
    "조식",
    "중식",
    "석식",
    "에너지",
    "탄수화물",
    "단백질",
    "지방",
    "칼슘",
    "kcal",
  ].filter((k) => k !== label);

  let end = after.length;
  for (const k of stopKeys) {
    const j = after.indexOf(k);
    if (j >= 0 && j < end) end = j;
  }

  const block = after.slice(0, end);
  const cleaned = cleanHafsText(block);
  return cleaned || null;
}

function splitDinnerAndLate(dinnerAll) {
  if (!dinnerAll) return { dinner: null, late: null };
  if (!dinnerAll.includes("<야식>")) return { dinner: dinnerAll, late: null };
  const parts = dinnerAll.split("<야식>");
  const dinnerPart = (parts[0] || "").trim();
  const latePart = (parts.slice(1).join("\n") || "").trim();
  return {
    dinner: dinnerPart ? cleanHafsText(dinnerPart) : null,
    late: latePart ? cleanHafsText(latePart) : null,
  };
}

function dayFromCell($, cell) {
  const $cell = $(cell);
  const cls = $cell.find(".day, .date, .cal_day, .num, .dayNum").first().text();
  const tryTexts = [cls, $cell.clone().children().first().text(), $cell.text()];

  for (const t0 of tryTexts) {
    const t = String(t0 || "").replace(/\s+/g, " ").trim();
    const m = t.match(/\b([1-9]|[12]\d|3[01])\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

function parseMonthMeals(html, year, month) {
  const $ = cheerio.load(html);
  const map = new Map();

  const cells = $("td, th").toArray();
  for (const cell of cells) {
    const dayNum = dayFromCell($, cell);
    if (!dayNum) continue;

    const ymd = `${String(year)}${pad2(month)}${pad2(dayNum)}`;

    const cellHtml = $(cell).html() || "";
    const joined = normalizeHtmlToTextKeepingYa(cellHtml);

    if (!(joined.includes("조식") || joined.includes("중식") || joined.includes("석식"))) continue;

    const breakfast = extractMealFromText(joined, "조식");
    const lunch = extractMealFromText(joined, "중식");
    const dinnerAll = extractMealFromText(joined, "석식");
    const { dinner, late } = splitDinnerAndLate(dinnerAll);

    if (breakfast || lunch || dinner) {
      map.set(ymd, { breakfast, lunch, dinner, late });
    }
  }

  return map;
}

function parseDayMealsFromPageHtml(html) {
  // Don’t over-scope: some HAFS pages render meal blocks outside expected wrappers.
  // Use the whole HTML as text source.
  const joined = normalizeHtmlToTextKeepingYa(String(html || ""));

  const breakfast = extractMealFromText(joined, "조식");
  const lunch = extractMealFromText(joined, "중식");
  const dinnerAll = extractMealFromText(joined, "석식");
  const { dinner, late } = splitDinnerAndLate(dinnerAll);

  return { breakfast, lunch, dinner, late };
}

// ----------------- Cache -----------------
const monthHtmlCache = new Map(); // key: YYYYMM -> { html, ts }
const MONTH_TTL_MS = 10 * 60 * 1000;

const dayHtmlCache = new Map(); // key: YYYYMMDD -> { html, ts }
const DAY_TTL_MS = 5 * 60 * 1000;

// 이미지 캐시
const imageBinCache = new Map();
const IMAGE_TTL_MS = 60 * 60 * 1000;

// In-flight de-dupe (prevents multiple concurrent fetches for the same key)
const monthInFlight = new Map(); // key: YYYYMM -> Promise<html>
const dayInFlight = new Map();   // key: YYYYMMDD -> Promise<html>

async function fetchDayInfo(ymd) {
  const cached = dayHtmlCache.get(ymd);
  const now = Date.now();
  if (cached && now - cached.ts < DAY_TTL_MS) return cached.html;

  if (dayInFlight.has(ymd)) return await dayInFlight.get(ymd);

  const p = (async () => {
    const url = hafsDayUrl(ymd);
    const resp = await getHtmlArrayBuffer(url, 6000);
    const html = decodeHafsHtml(resp.data);
    dayHtmlCache.set(ymd, { html, ts: Date.now() });
    return html;
  })();

  dayInFlight.set(ymd, p);
  try {
    return await p;
  } finally {
    dayInFlight.delete(ymd);
  }
}

async function fetchDayMeals(ymd) {
  const html = await fetchDayInfo(ymd);
  const info = parseDayMealsFromPageHtml(html);
  // If everything is empty, treat as "no menu".
  if (!info.breakfast && !info.lunch && !info.dinner) return null;
  return info;
}

async function fetchMonthMapForRange(fromYmd, toYmd) {
  const yFrom = Number(fromYmd.slice(0, 4));
  const mFrom = Number(fromYmd.slice(4, 6));
  const yTo = Number(toYmd.slice(0, 4));
  const mTo = Number(toYmd.slice(4, 6));

  const keys = [{ y: yFrom, m: mFrom }];
  if (!(yFrom === yTo && mFrom === mTo)) keys.push({ y: yTo, m: mTo });

  const maps = [];
  for (const { y, m } of keys) {
    const cacheKey = `${y}${pad2(m)}`;
    const cached = monthHtmlCache.get(cacheKey);
    const now = Date.now();

    let html;
    if (cached && now - cached.ts < MONTH_TTL_MS) {
      html = cached.html;
    } else {
      const anyDay = `${y}${pad2(m)}01`;
      const url = hafsMonthUrl(anyDay);

      if (monthInFlight.has(cacheKey)) {
        html = await monthInFlight.get(cacheKey);
      } else {
        const p = (async () => {
          const resp = await getHtmlArrayBuffer(url, 6000);
          return decodeHafsHtml(resp.data);
        })();
        monthInFlight.set(cacheKey, p);
        try {
          html = await p;
        } finally {
          monthInFlight.delete(cacheKey);
        }
      }

      monthHtmlCache.set(cacheKey, { html, ts: Date.now() });
    }

    maps.push(parseMonthMeals(html, y, m));
  }

  const merged = new Map();
  for (const mp of maps) {
    for (const [k, v] of mp.entries()) merged.set(k, v);
  }

  // filter
  const out = new Map();
  for (const [k, v] of merged.entries()) {
    if (k >= fromYmd && k <= toYmd) out.set(k, v);
  }

  // ✅ Fallback: if month parsing yielded nothing, fetch day pages directly.
  // This happens when the site layout changes and the calendar-cell parsing misses content.
  if (out.size === 0) {
    const days = [];
    // iterate inclusive YYYYMMDD range
    let cur = new Date(Number(fromYmd.slice(0, 4)), Number(fromYmd.slice(4, 6)) - 1, Number(fromYmd.slice(6, 8)));
    const end = new Date(Number(toYmd.slice(0, 4)), Number(toYmd.slice(4, 6)) - 1, Number(toYmd.slice(6, 8)));
    while (cur <= end) {
      days.push(yyyymmdd(cur));
      cur = addDays(cur, 1);
    }

    // fetch in parallel but keep it safe
    const results = await Promise.all(
      days.map(async (d) => {
        try {
          const info = await fetchDayMeals(d);
          return [d, info];
        } catch (e) {
          console.error("[day-fallback-failed]", d, e?.code || "", e?.message || e);
          return [d, null];
        }
      })
    );

    const out2 = new Map();
    for (const [d, info] of results) {
      if (info) out2.set(d, info);
    }
    return out2;
  }

  return out;
}

// ----------------- Request parsing -----------------
function sanitizeUtterance(raw) {
  // Kakao / some clients may prefix quoted replies like `quote>` or include zero-width chars.
  const s0 = String(raw ?? "");
  // Normalize non-breaking spaces and other common invisible separators
  // (Kakao sometimes injects NBSP or thin spaces that don't match typical trims)
  const s1 = s0.replace(/[\u00A0\u202F\u2000-\u200A]/g, " ");
  return s1
    // Kakao/clients sometimes send quoted replies like `quote>`
    .replace(/^\s*quote>\s*/i, "")
    // normalize fullwidth pipe and Korean vertical bar to normal pipe
    .replace(/[｜ㅣ]/g, "|")
    // remove zero-width chars
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // normalize newlines/spaces
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    // normalize spacing around separators for photo command
    .replace(/\s*\|\s*/g, "|");
}

function parseUtter(utterRaw) {
  let utter = sanitizeUtterance(utterRaw);

  // Robustness: photo commands can arrive with different separators (|, /, fullwidth ｜, Korean ㅣ)
  // and meal keys can be English (breakfast/lunch/dinner) or Korean (아침/점심/저녁/조식/중식/석식)
  if (/^사진\s*[\/|｜ㅣ]/.test(utter) || utter.startsWith("사진/")) {
    // normalize separators
    utter = utter.replace(/[\/｜ㅣ]/g, "|");
    // collapse accidental duplicate separators
    utter = utter.replace(/\|{2,}/g, "|");
    // normalize spacing around separators
    utter = utter.replace(/\s*\|\s*/g, "|");
    // normalize prefix
    utter = utter.replace(/^\s*사진\s*\|/g, "사진|");
  }

  // Helper to normalize meal key into (breakfast|lunch|dinner)
  const normalizeMealKey = (mk) => {
    const s = String(mk || "").trim().toLowerCase();
    if (s === "breakfast" || s === "lunch" || s === "dinner") return s;
    if (s === "아침" || s === "조식") return "breakfast";
    if (s === "점심" || s === "중식") return "lunch";
    if (s === "저녁" || s === "석식") return "dinner";
    return null;
  };

  // Photo request: tolerate variations like
  // - "사진|YYYYMMDD|breakfast"
  // - "사진 | YYYYMMDD | breakfast"
  // - "사진|YYYYMMDD|breakfast|" (trailing pipe)
  // - extra trailing text after the command (rare, but can happen)
  {
    // First try a split-based parser (most robust)
    const parts = utter.split("|").map((p) => String(p || "").trim()).filter((p) => p.length > 0);

    // Accept: ["사진", "YYYYMMDD", "meal"] (+ ignore extras)
    if (parts.length >= 3 && parts[0] && parts[0].startsWith("사진")) {
      const ymd = parts[1];
      const mealKey = normalizeMealKey(parts[2]);
      if (/^\d{8}$/.test(ymd) && mealKey) {
        return { utter: `사진|${ymd}|${mealKey}`, when: "photo", meal: "photo", photoYmd: ymd, photoMeal: mealKey };
      }
    }

    // Fallback: regex (allows trailing pipe/whitespace)
    const m = utter.match(/^사진\|(\d{8})\|([^|]+)(?:\|.*)?$/i);
    if (m) {
      const ymd = String(m[1] || "").trim();
      const mealKey = normalizeMealKey(m[2]);
      if (/^\d{8}$/.test(ymd) && mealKey) {
        return { utter: `사진|${ymd}|${mealKey}`, when: "photo", meal: "photo", photoYmd: ymd, photoMeal: mealKey };
      }
    }
  }

  // when
  let when = "today";
  if (utter.includes("내일")) when = "tomorrow";
  else if (utter.includes("이번주") || utter.includes("이번 주") || utter.includes("주간")) when = "week";
  else if (utter.includes("오늘")) when = "today";

  // meal
  let meal = "all";
  if (utter === "아침" || utter.includes("조식")) meal = "breakfast";
  else if (utter === "점심" || utter.includes("중식")) meal = "lunch";
  else if (utter === "저녁" || utter.includes("석식")) meal = "dinner";
  else if (utter === "오늘" || utter === "내일" || utter.includes("이번주") || utter.includes("이번 주")) meal = "all";

  return { utter, when, meal };
}
function extractPhotoLinksFromHtml(html) {
  // Returns mealKey -> absolute image URL (preferably the HAFS popup URL act=lunch.image_pop&img=...)
  // We MUST avoid mixing meals (e.g., lunch returning breakfast photo).
  const $ = cheerio.load(String(html || ""));

  const toAbs = (p) => {
    if (!p) return null;
    const s = String(p).replace(/&amp;/g, "&").trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    const path = s.startsWith("/") ? s : `/${s}`;
    return `https://${HAFS_HOST}${path}`;
  };

  const looksLikeFood = (s) => {
    const v = String(s || "");
    if (!v) return false;
    if (v.includes("no_foodimg")) return false;
    // popup OR direct image path
    return v.includes("lunch.image_pop") || v.includes("/files/food/") || (v.includes("/hosts/") && v.includes("/food/"));
  };

  const extractPopupOrPath = (raw) => {
    if (!raw) return null;
    const norm = String(raw).replace(/&amp;/g, "&").trim();
    if (!norm) return null;

    // If it's already a direct food image path/url
    if (norm.includes("/files/food/") || (norm.includes("/hosts/") && norm.includes("/files/food/"))) return norm;

    // If it's a popup URL, keep it (we normalize later in fetchMealPhotoUrl and /img)
    if (norm.includes("lunch.image_pop")) return norm;

    // If it's an onclick like: window.open('...?act=lunch.image_pop&img=...')
    const mPop = norm.match(/(\?act=lunch\.image_pop[^'"\s)]*)/i);
    if (mPop && mPop[1]) return mPop[1];

    // If it contains img=...
    const mImg = norm.match(/img=([^'"\s)]+)/i);
    if (mImg && mImg[1]) return `?act=lunch.image_pop&img=${mImg[1]}`;

    return null;
  };

  const pickFromScope = ($scope) => {
    if (!$scope || $scope.length === 0) return null;

    // 1) Prefer popup links (most reliable)
    let found = null;
    $scope.find("a").each((_, a) => {
      if (found) return;
      const $a = $(a);
      const href = $a.attr("href") || "";
      const onclick = $a.attr("onclick") || "";
      const c1 = extractPopupOrPath(href);
      const c2 = extractPopupOrPath(onclick);
      const cand = c1 || c2;
      if (cand && looksLikeFood(cand)) found = cand;
    });
    if (found) return toAbs(found);

    // 2) Then try <img src=".../files/food/...">
    $scope.find("img").each((_, img) => {
      if (found) return;
      const $img = $(img);
      const src = $img.attr("src") || $img.attr("data-src") || $img.attr("data-original") || "";
      const cand = extractPopupOrPath(src) || src;
      if (cand && looksLikeFood(cand)) found = cand;
    });
    if (found) return toAbs(found);

    // 3) Last resort: regex inside the scope HTML
    const scopeHtml = String($scope.html() || "");
    const m1 = scopeHtml.match(/(\?act=lunch\.image_pop[^"'\s>]*)/i);
    if (m1 && m1[1]) return toAbs(m1[1]);
    const m2 = scopeHtml.match(/(\/hosts\/[^"'\s>]+\/files\/food\/[^"'\s>]+)/i) || scopeHtml.match(/(\/files\/food\/[^"'\s>]+)/i);
    if (m2 && m2[1]) return toAbs(m2[1]);

    return null;
  };

  // DOM-first: find the meal label marker and search in its nearest container.
  // This avoids the classic bug where "중식" search accidentally grabs the first photo (조식).
  const findByLabel = (label) => {
    // Most pages show meal labels as images with alt/title.
    const markers = $(
      `img[alt*="${label}"], img[title*="${label}"], span:contains("${label}"), strong:contains("${label}")`
    ).toArray();

    for (const el of markers) {
      const $m = $(el);

      // Try several reasonable containers, from tight to broad
      const scopes = [
        $m.parent(),
        $m.closest(".meal, .lunch, .lunch_list, .food, .menu, .tbl, .box, td, tr, table"),
        $m.closest("td"),
        $m.closest("table"),
      ].filter((x) => x && x.length);

      for (const sc of scopes) {
        const url = pickFromScope(sc);
        if (url) return url;
      }
    }

    return null;
  };

  const result = { breakfast: null, lunch: null, dinner: null };

  // 1) Label-scoped extraction (most accurate)
  result.breakfast = findByLabel("조식");
  result.lunch = findByLabel("중식");
  result.dinner = findByLabel("석식");

  // 2) Fallback fill: collect all unique food images on the page, then fill missing slots
  // WITHOUT duplicating already used ones.
  const ordered = [];
  $("a").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") || "";
    const onclick = $a.attr("onclick") || "";
    const cand = extractPopupOrPath(href) || extractPopupOrPath(onclick);
    if (cand && looksLikeFood(cand)) ordered.push(toAbs(cand));
  });
  $("img").each((_, img) => {
    const $img = $(img);
    const src = $img.attr("src") || $img.attr("data-src") || $img.attr("data-original") || "";
    const cand = extractPopupOrPath(src) || src;
    if (cand && looksLikeFood(cand)) ordered.push(toAbs(cand));
  });

  const seen = new Set();
  const uniq = [];
  for (const u of ordered) {
    if (!u) continue;
    if (u.includes("no_foodimg")) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    uniq.push(u);
  }

  const used = new Set(Object.values(result).filter(Boolean));
  for (const k of ["breakfast", "lunch", "dinner"]) {
    if (result[k]) continue;
    const next = uniq.find((u) => u && !used.has(u));
    if (next) {
      result[k] = next;
      used.add(next);
    }
  }

  return result;
}

async function fetchMealPhotoUrl(ymd, mealKey) {
  const key = `${ymd}|${mealKey}`;
  const cached = photoUrlCache.get(key);
  const now = Date.now();

  if (cached && now - cached.ts < PHOTO_URL_TTL_MS) {
    return cached.url || null;
  }

  const html = await fetchDayInfo(ymd);
  const map = extractPhotoLinksFromHtml(html);
  let url = map?.[mealKey] || null;

  // Normalize HAFS popup URL (act=lunch.image_pop&img=...) -> direct image URL
  const normalizePopupToDirect = (input) => {
    if (!input) return null;
    try {
      const u = new URL(String(input));
      const act = String(u.searchParams.get("act") || "").toLowerCase();
      const img = u.searchParams.get("img");
      if (act.includes("lunch.image_pop") && img) {
        const decoded = decodeURIComponent(img);
        const preferredScheme = "http"; // NitroEye blocks https more often
        if (/^https?:\/\//i.test(decoded)) {
          return decoded.replace(/^https:\/\//i, `${preferredScheme}://`).replace(/^http:\/\//i, `${preferredScheme}://`);
        }
        if (decoded.startsWith("/")) return `${preferredScheme}://${HAFS_HOST}${decoded}`;
        return `${preferredScheme}://${HAFS_HOST}/${decoded}`;
      }

      // Prefer http for direct HAFS image paths
      if (u.hostname === HAFS_HOST && /^https:\/\//i.test(String(input))) {
        return String(input).replace(/^https:\/\//i, "http://");
      }
    } catch {
      // ignore
    }
    return input;
  };

  url = normalizePopupToDirect(url);

  // If we still don't have a plausible URL, return null
  if (!url || !/^https?:\/\//i.test(url)) return null;

  // NOTE: We intentionally do NOT "HEAD-validate" the upstream image here.
  // Reason: HAFS/NitroEye frequently blocks HEAD/HTTPS or requires cookies,
  // which causes false negatives like "식단 사진이 없습니다." even when the photo exists.
  // The /img proxy already handles popup->direct extraction, HTTP preference, cookies, and fallback.

  // Cache and return
  photoUrlCache.set(key, { url, ts: now });
  return url;
}

const photoUrlCache = new Map();
const PHOTO_URL_TTL_MS = 30 * 60 * 1000;


function resolvePublicBaseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/+$/, "");
  const protoHeader = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const hostHeader = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").split(",")[0].trim();
  const proto = protoHeader || req?.protocol || "https";
  if (!hostHeader) return "https://hafs-cafeteria.onrender.com";
  return `${proto}://${hostHeader}`.replace(/\/+$/, "");
}

function proxiedImageUrl(rawUrl, req) {
  if (!rawUrl) return null;
  const base = resolvePublicBaseUrl(req);
  return `${base}/img?url=${encodeURIComponent(rawUrl)}`;
}

function mealKo(meal) {
  if (meal === "breakfast") return "조식";
  if (meal === "lunch") return "중식";
  if (meal === "dinner") return "석식";
  return "전체";
}

// ----------------- Routes -----------------
app.get("/", (req, res) => {
  res.status(200).send("✅ HAFS cafeteria bot (rebuild) running. POST /kakao");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Welcome/menu endpoint
app.post("/menu", (req, res) => {
  return res.json(
    kakaoText(
      "원하는 버튼을 눌러 급식을 확인해주세요.\n\n• 아침/점심/저녁: 오늘 해당 식사\n  - 응답에서 ‘식단 사진 보기’ 버튼으로 사진 확인\n• 오늘/내일/이번주: 전체 식단",
      menuQuickReplies()
    )
  );
});

// Optional image proxy (used by photo features)
// Kakao fetches the image from imageUrl server-side. If the file is too large/slow, Kakao may time out.
// So we: (1) cache, (2) prefer HTTP upstream, (3) compress/resize when large.
// 1x1 transparent PNG placeholder (prevents Kakao from showing a broken Not Found page)
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9WlKkAAAAASUVORK5CYII=",
  "base64"
);
function sendTransparentPng(res) {
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Length", String(TRANSPARENT_PNG.length));
  return res.status(200).send(TRANSPARENT_PNG);
}

app.head("/img", (req, res) => {
  // Kakao (kakaotalk-scrap / facebookexternalhit) often sends HEAD first.
  // Do NOT fetch upstream on HEAD; just return image-like headers quickly.
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).end();
});

app.get("/img", async (req, res) => {
  try {
    const raw = String(req.query.url || "");
    // If the incoming URL is a HAFS popup page (act=lunch.image_pop&img=...),
    // rewrite it to the *real* image URL before doing any network fetch.
    // This avoids fetching HTML first and fixes NOT_IMAGE_* failures.
    const normalizeImagePopToDirect = (input) => {
      try {
        const u = new URL(String(input));
        const act = String(u.searchParams.get("act") || "").toLowerCase();
        const img = u.searchParams.get("img");

        // HAFS photo popup -> direct image path
        if (act.includes("lunch.image_pop") && img) {
          const decoded = decodeURIComponent(img);

          // Prefer HTTP upstream (NitroEye blocks HTTPS frequently)
          const preferredScheme = "http";

          if (/^https?:\/\//i.test(decoded)) {
            // Force scheme to http for upstream fetch
            return decoded.replace(/^https:\/\//i, `${preferredScheme}://`).replace(/^http:\/\//i, `${preferredScheme}://`);
          }

          if (decoded.startsWith("/")) return `${preferredScheme}://${HAFS_HOST}${decoded}`;
          return `${preferredScheme}://${HAFS_HOST}/${decoded}`;
        }

        // If it's already a direct path on HAFS, also prefer HTTP
        const s = String(input);
        if (/^https:\/\//i.test(s) && u.hostname === HAFS_HOST) {
          return s.replace(/^https:\/\//i, "http://");
        }
      } catch {
        // ignore
      }
      return input;
    };

    const rawNormalized = normalizeImagePopToDirect(raw);
    console.log("[IMG HIT]", {
      time: new Date().toISOString(),
      raw,
      rawNormalized,
      host: (() => { try { return new URL(rawNormalized).hostname; } catch { return ""; } })(),
      path: (() => { try { const u = new URL(rawNormalized); return (u.pathname || "") + (u.search || ""); } catch { return ""; } })(),
      ua: req.headers["user-agent"] || "",
      ip: req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress || "",
    });
    if (!rawNormalized || !/^https?:\/\//i.test(rawNormalized)) {
      // Avoid Kakao showing an error card; return a tiny valid image.
      return sendTransparentPng(res);
    }

    const u0 = new URL(rawNormalized);
    const allowedHosts = new Set(["hafs.hs.kr"]);
    if (HAFS_IP_FALLBACK) allowedHosts.add(HAFS_IP_FALLBACK);
    if (!allowedHosts.has(u0.hostname)) {
      console.error("[IMG FORBIDDEN HOST]", { host: u0.hostname, rawNormalized });
      return sendTransparentPng(res);
    }

    // Normalize cache key (keep original + normalized schemes)
    const httpRaw = rawNormalized.replace(/^https:\/\//i, "http://");
    const httpsRaw = rawNormalized.replace(/^http:\/\//i, "https://");

    // If IP fallback is configured, prepare IP-based URLs (still sending Host header).
    const toIpIfNeeded = (url) => {
      if (!HAFS_IP_FALLBACK) return url;
      try {
        const uu = new URL(url);
        if (uu.hostname !== HAFS_HOST) return url;
        uu.hostname = HAFS_IP_FALLBACK;
        return uu.toString();
      } catch {
        return url;
      }
    };

    const httpIp = toIpIfNeeded(httpRaw);
    const httpsIp = toIpIfNeeded(httpsRaw);

    const now = Date.now();
    const pickCached = (key) => {
      const c = imageBinCache.get(key);
      if (!c) return null;
      if (now - (c.ts || 0) > IMAGE_TTL_MS) {
        imageBinCache.delete(key);
        return null;
      }
      return c;
    };

    // Serve from cache immediately if possible
    const cached = pickCached(rawNormalized) || pickCached(httpRaw) || pickCached(httpsRaw);
    if (cached && cached.buf && cached.ct) {
      res.setHeader("Content-Type", cached.ct);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "HEAD") return res.status(200).end();
      res.setHeader("Content-Length", String(cached.buf.length));
      return res.status(200).send(cached.buf);
    }

    // 1) axios로 빠르게 시도 (리다이렉트는 수동으로 2~3번만 따라간다)
    const fetchOnce = async (url) => {
      const uu = new URL(url);
      const isIpHost = Boolean(HAFS_IP_FALLBACK && uu.hostname === HAFS_IP_FALLBACK);

      const resp = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 5500,
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        httpsAgent: isIpHost ? httpsAgentHafsIp : httpsAgent,
        httpAgent,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "http://hafs.hs.kr/",
          ...(isIpHost ? { Host: HAFS_HOST } : {}),
          ...(HAFS_COOKIE ? { Cookie: HAFS_COOKIE } : {}),
        },
      });

      updateCookieFromResponse(resp);
      return resp;
    };

    const isNitro = (resp, buf) => {
      const loc = String(resp?.headers?.location || "");
      if (loc.includes("nitroeye.co.kr/404_firewall")) return true;
      const body = buf ? buf.toString("utf-8") : "";
      return body.includes("nitroeye.co.kr/404_firewall") || body.includes("404_firewall");
    };

    const isHtmlLike = (ct, buf) => {
      const ctL = String(ct || "").toLowerCase();
      if (ctL.includes("text/html")) return true;
      const head = buf ? buf.toString("utf-8", 0, Math.min(buf.length, 300)) : "";
      return head.includes("<!DOCTYPE") || head.includes("<html") || head.includes("404_firewall") || head.includes("nitroeye");
    };

    const sendBuf = (buf, ct) => {
      console.log("[IMG RESP]", {
        bytes: buf?.length || 0,
        contentType: ct,
      });
      res.setHeader("Content-Type", ct);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Length", String(buf.length));
      return res.status(200).send(buf);
    };

    // Compress helper (Kakao is much more reliable when images are <= ~1-2MB)
    const maybeCompress = async (buf, ct) => {
      // Only compress if Sharp is available and the payload is large
      const MAX_BYTES = 1_200_000; // ~1.2MB target
      if (!sharp) return { buf, ct };
      if (!buf || buf.length <= MAX_BYTES) return { buf, ct };

      const ctLower = String(ct || "").toLowerCase();
      const looksLikeImage = ctLower.startsWith("image/");
      if (!looksLikeImage) return { buf, ct };

      // Convert everything to jpeg for predictable size
      // Resize to max width 1024 (keep aspect)
      try {
        const out = await sharp(buf)
          .rotate() // respect EXIF orientation
          .resize({ width: 1024, withoutEnlargement: true })
          .jpeg({ quality: 70, mozjpeg: true })
          .toBuffer();

        // If compression somehow got bigger, keep original
        if (out && out.length > 0 && out.length < buf.length) {
          return { buf: out, ct: "image/jpeg" };
        }
      } catch {
        // ignore compression errors
      }
      return { buf, ct };
    };

    const followRedirect = (currentUrl, location) => {
      try {
        return new URL(String(location || ""), currentUrl).toString();
      } catch {
        return String(location || "");
      }
    };

    const tryFetchImage = async (startUrl) => {
      let cur = startUrl;
      for (let i = 0; i < 2; i++) {
        const resp = await fetchOnce(cur);
        const buf0 = Buffer.from(resp.data || []);

        // Handle redirects FIRST (avoid treating 301/302 HTML bodies as non-image)
        if (resp.status >= 300 && resp.status < 400) {
          const loc = String(resp.headers?.location || "");
          if (!loc) throw new Error("REDIRECT_WITHOUT_LOCATION");
          if (loc.includes("nitroeye.co.kr/404_firewall")) {
            const err = Object.assign(new Error("HAFS_FIREWALL_BLOCK"), { code: "HAFS_FIREWALL" });
            throw err;
          }
          cur = followRedirect(cur, loc);
          continue;
        }

        const ctMaybe = String(resp?.headers?.["content-type"] || "").toLowerCase();
        const htmlLike = isHtmlLike(ctMaybe, buf0);

        // NitroEye / firewall detection
        if (isNitro(resp, buf0)) {
          const err = Object.assign(new Error("HAFS_FIREWALL_BLOCK"), { code: "HAFS_FIREWALL" });
          throw err;
        }

        if (htmlLike) {
          // Some HAFS photo links are NOT direct images.
          // Example: https://hafs.hs.kr/?act=lunch.image_pop&img=/hosts/hafs.hs.kr/files/food/...
          // In that case, we can extract the `img` query param and fetch the real image directly.
          try {
            const curUrl = new URL(cur);
            const act = (curUrl.searchParams.get("act") || "").toLowerCase();
            const imgParam = curUrl.searchParams.get("img");
            if (act.includes("lunch.image_pop") && imgParam) {
              const scheme = String(cur || "").toLowerCase().startsWith("http://") ? "http" : "https";
              let extracted = decodeURIComponent(imgParam);
              if (!/^https?:\/\//i.test(extracted)) {
                extracted = extracted.startsWith("/")
                  ? `${scheme}://${HAFS_HOST}${extracted}`
                  : `${scheme}://${HAFS_HOST}/${extracted}`;
              } else {
                // normalize to current scheme (HTTP often works when HTTPS is blocked)
                extracted = extracted.replace(/^https:\/\//i, `${scheme}://`);
              }

              // IMPORTANT: prefer HTTP first to avoid NitroEye/HTTPS blocks in some environments
              cur = extracted.replace(/^https:\/\//i, "http://");
              continue;
            }
          } catch {
            // ignore
          }

          const html = buf0.toString("utf-8");

          // If it is the HAFS popup page, it usually includes an <img> tag pointing to
          // /files/food/... or /hosts/.../files/food/...
          // Extract the first matching image and retry using that URL.
          const $h = cheerio.load(html);
          let extracted = null;
          $h("img").each((_, img) => {
            if (extracted) return;
            const src = $h(img).attr("src") || "";
            if (!src) return;
            if (src.includes("no_foodimg")) return;
            if (src.includes("/files/food/") || (src.includes("/hosts/") && src.includes("/files/food/"))) {
              extracted = src;
            }
          });

          // Fallback regex extraction (covers cases where HTML is not well-formed)
          if (!extracted) {
            const mSrc = html.match(/src\s*=\s*["']([^"']*(?:\/hosts\/[^"']+\/)?files\/food\/[^"']+)["']/i);
            if (mSrc && mSrc[1]) extracted = mSrc[1];
          }
          if (!extracted) {
            const mPath = html.match(/(\/hosts\/[^"'\s>]+\/files\/food\/[^"'\s>]+)/i) || html.match(/(\/files\/food\/[^"'\s>]+)/i);
            if (mPath && mPath[1]) extracted = mPath[1];
          }

          if (extracted) {
            const scheme = String(cur || "").toLowerCase().startsWith("http://") ? "http" : "https";
            // make absolute
            if (!/^https?:\/\//i.test(extracted)) {
              extracted = extracted.startsWith("/")
                ? `${scheme}://${HAFS_HOST}${extracted}`
                : `${scheme}://${HAFS_HOST}/${extracted}`;
            } else {
              extracted = extracted.replace(/^https:\/\//i, `${scheme}://`);
            }

            // Prefer HTTP first
            cur = extracted.replace(/^https:\/\//i, "http://");
            continue;
          }

          // If we couldn't extract an image, treat it as blocked/invalid.
          const preview = html.slice(0, 180).replace(/\s+/g, " ");
          console.error("[IMG NOT_IMAGE_HTML]", { cur, ct: ctMaybe, preview });
          const err = Object.assign(new Error("NOT_IMAGE_HTML"), { code: "NOT_IMAGE_HTML" });
          throw err;
        }

        const ctRaw = String(resp.headers["content-type"] || "").toLowerCase();
        if (!ctRaw.startsWith("image/")) {
          // Sometimes image servers mislabel; if it's clearly binary and small header doesn't look like html, still allow.
          const head = buf0.toString("utf-8", 0, Math.min(buf0.length, 80));
          if (head.includes("<html") || head.includes("<!DOCTYPE")) throw new Error("NOT_IMAGE");
        }

        // Compress if needed
        const { buf, ct } = await maybeCompress(buf0, ctRaw || "image/jpeg");

        // Cache the FINAL payload we send to Kakao
        imageBinCache.set(rawNormalized, { buf, ct, ts: Date.now() });
        imageBinCache.set(startUrl, { buf, ct, ts: Date.now() });
        return sendBuf(buf, ct);
      }
      throw new Error("TOO_MANY_REDIRECTS");
    };

    let lastErr = null;
    const candidates = [httpRaw, httpIp, httpsRaw, httpsIp].filter(Boolean);
    let sent = false;
    for (const url of candidates) {
      try {
        await tryFetchImage(url);
        sent = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (sent) return;

    // 2) axios가 막히면 Playwright로 쿠키/세션 우회 → (같은 이미지 fetch 로직으로) 재시도
    try {
      try {
        await fetchHtmlWithPlaywright(httpsRaw, 12000);
      } catch (pwErr) {
        const msg = String(pwErr?.message || "");
        // If Playwright is installed but browsers are missing at runtime, surface a clear error.
        if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch") || msg.includes("chromium")) {
          console.error("[IMG PLAYWRIGHT MISSING BROWSER]", msg);
          return res.status(503).send("PLAYWRIGHT_BROWSER_MISSING");
        }
        throw pwErr;
      }

      // ✅ IMPORTANT:
      // After Playwright refreshes cookies/session, DO NOT do a naive axios.get(httpsRaw).
      // The HAFS photo URL is often a popup HTML (`act=lunch.image_pop`) that needs parsing
      // to reach the real `/files/food/...` image. We already implemented that logic in
      // `tryFetchImage()`, so reuse it here.
      try {
        await tryFetchImage(httpIp || httpRaw);
        return;
      } catch (e1) {
        // fall through to https
      }

      await tryFetchImage(httpsIp || httpsRaw);
      return;
    } catch (e) {
      lastErr = e;
    }

    // If we got here, nothing worked
    if (lastErr?.code === "HAFS_FIREWALL") {
      console.error("[IMG ERROR] HAFS_FIREWALL", lastErr?.message || lastErr);
      return res.status(503).send("HAFS_FIREWALL");
    }
    console.error("[IMG ERROR DETAIL]", {
      code: lastErr?.code,
      message: lastErr?.message,
      status: lastErr?.response?.status,
      location: lastErr?.response?.headers?.location,
    });
    console.error("[IMG ERROR] Not found", lastErr?.message || lastErr);
    return sendTransparentPng(res);
  } catch (err) {
    console.error("[IMG ERROR] Unexpected", err);
    return sendTransparentPng(res);
  }
});
// Kakao webhook
app.post("/kakao", async (req, res) => {
  try {
    const utter = sanitizeUtterance(req?.body?.userRequest?.utterance || "");
    const rawUtter = String(req?.body?.userRequest?.utterance || "");
    console.log("[KAKAO UTTER]", { raw: rawUtter, utter });

    // ✅ Hard-guard: if this is a photo command, handle it immediately.
    // Kakao sometimes sends separators that look like pipes (|/｜/ㅣ) or includes odd characters.
    // We normalize in `parseUtter`, but this early guard prevents falling into the default menu response.
    const maybePhoto = parseUtter(utter);
    if (maybePhoto.meal === "photo" && maybePhoto.when === "photo") {
      const ymd = maybePhoto.photoYmd;
      const mealKey = maybePhoto.photoMeal;
      try {
        const rawUrl = await fetchMealPhotoUrl(ymd, mealKey);
        if (!rawUrl) return res.json(kakaoText("식단 사진이 없습니다.", null));
        const imgUrl = proxiedImageUrl(rawUrl, req);
        const title = `📷 (${prettyYmd(ymd)}) ${mealKo(mealKey)}`;
        return res.json(kakaoImageCard(title, imgUrl, title, null));
      } catch (e) {
        console.error("[photo-fetch-failed]", { ymd, mealKey, code: e?.code, msg: e?.message });
        return res.json(kakaoText("식단 사진을 불러오다가 오류가 났어. 잠시 후 다시 시도해줘!", null));
      }
    }

    // Menu for empty or unknown
    const utterForMatch = utter.replace(/[^\p{Script=Hangul}\s]/gu, " ").replace(/\s+/g, " ").trim();

    if (
      !utterForMatch ||
      !["아침", "점심", "저녁", "오늘", "내일", "이번주", "이번 주"].some((k) => utterForMatch.includes(k))
    ) {
      return res.json(
        kakaoText(
          "원하는 버튼을 눌러 급식을 확인해주세요.\n\n• 아침/점심/저녁: 오늘 해당 식사(사진 있으면 같이 표시)\n• 오늘/내일/이번주: 전체 식단",
          menuQuickReplies()
        )
      );
    }

    const { when, meal, photoYmd, photoMeal } = maybePhoto;

    const now = new Date();
    let from, to;

    if (when === "tomorrow") {
      const d = addDays(now, 1);
      from = yyyymmdd(d);
      to = from;
    } else if (when === "week") {
      const monday = startOfWeekMonday(now);
      const sunday = addDays(monday, 6);
      from = yyyymmdd(monday);
      to = yyyymmdd(sunday);
    } else {
      from = yyyymmdd(now);
      to = from;
    }

    // Fetch range map via month scrape (1~2 requests)
    const rangeMap = await fetchMonthMapForRange(from, to);
    // Debug: log when nothing parsed for the requested range
    if (!rangeMap || rangeMap.size === 0) {
      console.error("[parse-empty] rangeMap empty", { from, to, when, meal, note: "will show empty if no menus OR blocked" });
    }

    // Render
    if (!rangeMap || rangeMap.size === 0) {
      return res.json(
        kakaoText(
          "해당 날짜의 급식 정보가 아직 등록되지 않았거나 제공되지 않는 날입니다."
        )
      );
    }

    // single meal
    if (meal !== "all" && from === to) {
      // Fast path for single-meal buttons: fetch just the day page and parse it.
      // This is much faster than month-range parsing under load.
      const dayHtml = await fetchDayInfo(from); // ✅ 한 번만 가져옴
      const info = parseDayMealsFromPageHtml(dayHtml) || {};

      // Build menu text for the requested meal
      let menuText = null;
      if (meal === "breakfast") menuText = info.breakfast || null;
      else if (meal === "lunch") menuText = info.lunch || null;
      else if (meal === "dinner") {
        if (info.dinner) {
          menuText = info.dinner;
          if (info.late) menuText += `\n\n<야식>\n${info.late}`;
        } else {
          menuText = null;
        }
      }

      if (!menuText) {
        // No menu for this meal (or blocked/empty)
        return res.json(
          kakaoText(`🍽 ${mealKo(meal)} 정보가 아직 등록되지 않았거나 오늘은 제공되지 않습니다.\n📅 ${prettyYmd(from)}`, null)
        );
      }

      const text = `🍽 ${mealKo(meal)}\n📅 ${prettyYmd(from)}\n${menuText}`;

      // Only show a single "식단 사진 보기" button for 아침/점심/저녁
      return res.json(kakaoText(text, photoQuickReply(from, meal)));
    }

    // all
    const days = [...rangeMap.keys()].sort();
    const text = days
      .map((d) => {
        const info = rangeMap.get(d) || {};
        const chunks = [];
        if (info.breakfast) chunks.push(`• 조식\n${info.breakfast}`);
        if (info.lunch) chunks.push(`• 중식\n${info.lunch}`);
        if (info.dinner) {
          let combined = `• 석식\n${info.dinner}`;
          if (info.late) combined += `\n\n<야식>\n${info.late}`;
          chunks.push(combined);
        }
        return `📅 ${prettyYmd(d)}\n${chunks.join("\n\n")}`;
      })
      .join("\n\n──────────\n\n");

    return res.json(kakaoText(text, null));
  } catch (err) {
    const code = err?.code || "";
    const msg = err?.message || "";
    console.error("KAKAO ERROR", code, msg);

    if (code === "HAFS_FIREWALL" || msg.includes("HAFS_FIREWALL")) {
      return res.json(
        kakaoText(
          "학교 사이트 접속이 차단(방화벽)되어 급식을 불러올 수 없어요.\n잠시 후 다시 시도해줘!"
        )
      );
    }
    if (code === "PLAYWRIGHT_NOT_INSTALLED" || msg.includes("PLAYWRIGHT_NOT_INSTALLED")) {
      return res.json(
        kakaoText(
          "서버에 브라우저 모듈(Playwright)이 없어 학교 사이트 차단을 우회할 수 없어요.\n관리자에게 Playwright 설치 후 재배포를 요청해줘!"
        )
      );
    }

    return res.json(kakaoText("급식 불러오다가 오류가 났어. 잠시 후 다시 시도해줘!"));
  }
});

// Run
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행중: http://localhost:${PORT}`));
