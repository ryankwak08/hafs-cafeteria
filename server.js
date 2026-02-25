import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

dotenv.config();

const app = express();
app.use(express.json());

// ====== 설정 ======
const NEIS_KEY = process.env.NEIS_KEY; // .env에서 가져옴
const ATPT_OFCDC_SC_CODE = "J10";      // 경기도교육청
const SD_SCHUL_CODE = "7531146";       // 너가 찾은 학교 코드
const NEIS_BASE = "https://open.neis.go.kr/hub";

// ====== 날짜 유틸 ======
function yyyymmdd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function startOfWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=일, 1=월, ...
  const diff = (day === 0 ? -6 : 1) - day; // 월요일 기준으로 이동
  d.setDate(d.getDate() + diff);
  return d;
}

// ====== 간단한 동시성 제한 유틸 (Kakao 응답 시간 제한 대응) ======
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (e) {
        results[idx] = e;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ====== HAFS 페이지 HTML 가져오기 (간단 캐시) ======
const hafsHtmlCache = new Map(); // ymd -> { html, ts }

// ====== 식단 사진 URL 캐시 (스크래핑/팝업 호출 최소화) ======
const photoUrlCache = new Map(); // key: `${ymd}|${mealKo}` -> { url: string|null, ts }
const PHOTO_CACHE_TTL_MS = 30 * 60 * 1000; // 30분

// ====== 이미지 프록시 버퍼 캐시 (Kakao 이미지 로딩 안정화) ======
const imgProxyCache = new Map(); // key: url -> { buf: Buffer, ct: string, ts: number }
const IMG_CACHE_TTL_MS = 60 * 60 * 1000; // 1시간

// ====== 마지막 조회(식사/날짜) 저장: '식단 사진 보기' 버튼이 라벨로 들어오는 경우 대응 ======
const lastSelection = new Map(); // userId -> { ymd, meal, ts }
const LAST_TTL_MS = 10 * 60 * 1000;

function getUserId(body) {
  // Kakao OpenBuilder에서 들어오는 user id 필드가 환경마다 다를 수 있어 최대한 폭넓게 잡는다.
  return (
    body?.userRequest?.user?.id ||
    body?.userRequest?.user?.userId ||
    body?.userRequest?.user?.uuid ||
    body?.userRequest?.user?.properties?.plusfriendUserKey ||
    body?.userRequest?.user?.properties?.appUserId ||
    "anon"
  );
}

function saveLastSelection(userId, ymd, meal) {
  if (!userId) return;
  if (!ymd || !meal || meal === "all" || meal === "week") return;
  lastSelection.set(userId, { ymd, meal, ts: Date.now() });
}

function loadLastSelection(userId) {
  const v = lastSelection.get(userId);
  if (!v) return null;
  if (Date.now() - v.ts > LAST_TTL_MS) {
    lastSelection.delete(userId);
    return null;
  }
  return v;
}

function hafsPageUrl(targetYmd) {
  const monthParam = ymdToDot(targetYmd);
  return `https://hafs.hs.kr/?act=lunch.main2&code=171113&month=${monthParam}`;
}

async function fetchHafsHtml(targetYmd) {
  const cached = hafsHtmlCache.get(targetYmd);
  const now = Date.now();
  if (cached && now - cached.ts < 5 * 60 * 1000) {
    return cached.html;
  }

  const url = hafsPageUrl(targetYmd);
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 2500,
  });

  let html = "";
  try {
    html = iconv.decode(Buffer.from(resp.data), "euc-kr");
  } catch {
    html = Buffer.from(resp.data).toString("utf-8");
  }

  hafsHtmlCache.set(targetYmd, { html, ts: now });
  return html;
}

function absolutizeHafsUrl(src) {
  if (!src) return null;
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  if (src.startsWith("//")) return `https:${src}`;
  if (src.startsWith("/")) return `https://hafs.hs.kr${src}`;
  return `https://hafs.hs.kr/${src}`;
}

function toAbsHafsUrl(u) {
  if (!u) return null;
  if (u.startsWith("http")) return u;
  if (u.startsWith("?")) return `https://hafs.hs.kr/${u}`;
  if (u.startsWith("/")) return `https://hafs.hs.kr${u}`;
  return `https://hafs.hs.kr/${u}`;
}

async function fetchRealPhotoUrlFromPopup(popupUrl) {
  const resp = await axios.get(popupUrl, {
    responseType: "arraybuffer",
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://hafs.hs.kr/" },
    timeout: 2500,
  });

  let html = "";
  try {
    html = iconv.decode(Buffer.from(resp.data), "euc-kr");
  } catch {
    html = Buffer.from(resp.data).toString("utf-8");
  }

  const $ = cheerio.load(html);

  // 팝업 안에 있는 '진짜 사진' img src 찾기
  const imgEl = $("img").filter(function () {
    const src = $(this).attr("src") || "";
    return /\/hosts\//i.test(src) || /\/files\//i.test(src);
  }).first();

  const src = imgEl.attr("src") || null;
  return absolutizeHafsUrl(src);
}

async function fetchMealPhotoFromHafsSite(targetYmd, mealKo) {
  // mealKo: 조식 | 중식 | 석식
  const cacheKey = `${targetYmd}|${mealKo}`;
  const cached = photoUrlCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < PHOTO_CACHE_TTL_MS) {
    return cached.url;
  }
  const html = await fetchHafsHtml(targetYmd);
  const $ = cheerio.load(html);

  // 1) mealKo 텍스트가 있는 후보들을 모두 훑으면서,
  //    각 후보의 근처 컨테이너에서 '진짜 사진' img src를 찾아낸다.
  const candidates = $(`*:contains('${mealKo}')`).toArray();

  const isBad = (absUrl) => {
    if (!absUrl) return true;
    
    // HAFS 공용 UI/아이콘/버튼 이미지 제외 (font-plus 같은 것)
    if (/\/commons\/images\//i.test(absUrl)) return true;
    if (/font-plus|icon|btn|button|global/i.test(absUrl)) return true;

    // 식단 페이지 네비/버튼 gif (prev/next 등)
    if (/\/image\/access\/foodList\//i.test(absUrl)) return true;
    if (/prevMonth|nextMonth|today|cal|arrow/i.test(absUrl)) return true;

    // 플레이스홀더/빈이미지 패턴 (학교 사이트 기본 'no_foodimg.gif' 포함)
    if (/noimg|no_foodimg|blank|none|default/i.test(absUrl)) return true;
    // 중식/석식의 회색 도시락 기본 그림 같은 경우가 많아서, 파일명이 plate/meal/box가 아닌데도
    // 완전히 배제하면 오탐이 생길 수 있으니 위 패턴만 강하게 거른다.
    return false;
  };

  for (const el of candidates) {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    // 너무 큰 덩어리(페이지 전체) 매칭 방지
    if (!(t === mealKo || t.startsWith(mealKo + " ") || t.includes(mealKo))) continue;

    // ✅ 가장 정확한 범위는 '라벨이 있는 셀(td/th)'.
    // 점심 사진이 없을 때 같은 날짜의 조식 사진을 주워오는 문제를 막기 위해
    // td/th 안에서만 팝업 링크/이미지를 먼저 찾는다.
    const cellScope = $(el).closest("td, th");

    const rowScope = $(el).closest(
      "tr, li, .meal, .mealBox, .meal_box, .lunch, .lunchBox, .lunch_box"
    );

    const container = $(el).closest(
      "table, tr, td, div, section, article"
    );

    const scope = cellScope.length
      ? cellScope
      : (rowScope.length ? rowScope : (container.length ? container : $(el).parent()));

    // cellScope가 아닌 큰 범위를 쓰는 경우, 다른 식사 라벨이 섞여 있으면 안전하게 스킵
    if (!cellScope.length) {
      const st = scope.text();
      if (mealKo === "중식" && st.includes("조식")) continue;
      if (mealKo === "석식" && (st.includes("조식") || st.includes("중식"))) continue;
    }

    // ✅ 0) 먼저 현재 페이지의 img를 훑어서 '진짜 사진'이 있으면 그걸 사용 (팝업 호출 1회 절약)
    const imgs = scope.find("img").toArray();
    for (const imgEl of imgs) {
      const src = $(imgEl).attr("src") || $(imgEl).attr("data-src") || null;
      const abs = absolutizeHafsUrl(src);
      if (!abs || isBad(abs)) continue;
      photoUrlCache.set(cacheKey, { url: abs, ts: Date.now() });
      return abs;
    }

    // ✅ 1) img가 없으면 '사진 팝업' 링크를 통해 진짜 사진 URL을 가져온다
    const popupA = scope.find("a[href*='lunch.image_pop']").first();
    if (popupA.length) {
      const href = popupA.attr("href") || "";

      // ✅ (빠름) href에 img=/hosts/... 가 이미 들어있는 경우가 많다.
      // 이때는 팝업 페이지를 다시 요청하지 말고 img 파라미터를 그대로 사용한다.
      try {
        const absPopup = toAbsHafsUrl(href);
        if (absPopup) {
          const u = new URL(absPopup);
          const imgParam = u.searchParams.get("img");
          if (imgParam) {
            const direct = absolutizeHafsUrl(imgParam);
            if (direct && !isBad(direct)) {
              photoUrlCache.set(cacheKey, { url: direct, ts: Date.now() });
              return direct;
            }
          }
        }
      } catch {
        // URL 파싱 실패 시 아래 폴백으로
      }

      // (폴백) 그래도 없으면 팝업 HTML을 열어서 img src를 파싱
      const popupUrl = toAbsHafsUrl(href);
      if (popupUrl) {
        try {
          const real = await fetchRealPhotoUrlFromPopup(popupUrl);
          if (real && !isBad(real)) {
            photoUrlCache.set(cacheKey, { url: real, ts: Date.now() });
            return real;
          }
        } catch {
          // 팝업 파싱 실패 시 무시
        }
      }
    }
  }

  // 2) 그래도 못 찾으면,
  // 조식(아침)은 보통 사진이 있는 날이 많고, 페이지 구조상 안전한 전역 폴백이 가능하지만
  // 중식/석식은 사진이 없을 때 같은 날짜의 다른 식사(조식) 사진을 잘못 집기 쉬워서 전역 폴백을 금지한다.
  if (mealKo !== "조식") {
    photoUrlCache.set(cacheKey, { url: null, ts: Date.now() });
    return null;
  }

  const globalImgs = $("img").toArray();
  for (const imgEl of globalImgs) {
    const src = $(imgEl).attr("src") || $(imgEl).attr("data-src") || null;
    const abs = absolutizeHafsUrl(src);
    if (!abs || isBad(abs)) continue;

    // 이미지 주변 텍스트에 mealKo가 있으면 해당 이미지로 인정
    const 주변텍스트 = $(imgEl).closest("div, td, tr, section, article").text();
    if (주변텍스트 && 주변텍스트.includes(mealKo)) {
      photoUrlCache.set(cacheKey, { url: abs, ts: Date.now() });
      return abs;
    }
  }

  photoUrlCache.set(cacheKey, { url: null, ts: Date.now() });
  return null;
}

// ====== 요청 파싱 (오픈빌더 파라미터 + 발화 둘 다 지원) ======
function parseKakaoRequest(body) {
  const utter = (body?.userRequest?.utterance || "").trim();
  const params = body?.action?.params || {}; // 오픈빌더에서 파라미터로 넘기면 여기에 들어옴

  // when: today | tomorrow | week
  let when = String(params.when || "").toLowerCase();
  if (!when) {
    // 6버튼(오늘/내일/이번주) 지원
    if (utter === "내일" || utter.includes("내일")) when = "tomorrow";
    else if (utter === "이번주" || utter === "이번 주" || utter.includes("이번주") || utter.includes("이번 주") || utter.includes("주간")) when = "week";
    else when = "today"; // 기본
  }

  // meal: breakfast | lunch | dinner | all
  let meal = String(params.meal || "").toLowerCase();
  if (!meal) {
    // 6버튼(아침/점심/저녁) 지원: 기본은 "오늘" 기준
    if (utter === "아침" || utter.includes("아침") || utter.includes("조식") || utter.toLowerCase().includes("breakfast")) meal = "breakfast";
    else if (utter === "점심" || utter.includes("점심") || utter.includes("중식") || utter.toLowerCase().includes("lunch")) meal = "lunch";
    else if (utter === "저녁" || utter.includes("저녁") || utter.includes("석식") || utter.toLowerCase().includes("dinner")) meal = "dinner";
    else meal = "all";
  }

  return { utter, when, meal };
}

// 저장된 발화/버튼 외의 입력이면 메뉴로 유도
function isRecognizedUtter(utter) {
  const u = (utter || "").trim();
  if (!u) return true; // 웰컴(빈 발화)은 메뉴로 처리하는 로직이 이미 있음

  // 정확히 일치하는 버튼/명령
  const exact = new Set(["아침", "점심", "저녁", "오늘", "내일", "이번주", "이번 주", "메뉴", "시작", "도움말", "사진", "식단 사진", "식단 사진 보기"]);
  if (exact.has(u)) return true;

  // 포함되는 키워드(조식/중식/석식, 주간 등)
  const keywords = ["아침", "점심", "저녁", "조식", "중식", "석식", "오늘", "내일", "이번주", "이번 주", "주간", "메뉴", "시작", "도움말", "사진", "식단 사진"];
  return keywords.some((k) => u.includes(k));
}

function mealNameKo(meal) {
  if (meal === "breakfast") return "조식";
  if (meal === "lunch") return "중식";
  if (meal === "dinner") return "석식";
  return "전체";
}

// ====== 급식 정리 ======
function cleanDishText(raw) {
  if (!raw) return "급식 정보 없음";

  // 1) <br/> → 줄바꿈
  const text = raw.replace(/<br\s*\/?>/gi, "\n");

  // 2) 괄호로 붙는 불필요 정보 제거
  //   - (용인) 같은 지역표시
  //   - (1.2.5.6.) 같은 알레르기 번호 묶음
  //   - 빈 괄호 ()
  const withoutParens = text
    .replace(/\([^)]*용인[^)]*\)/g, "")
    .replace(/\(\s*\d+(?:\.\d+)*\s*\)/g, "")
    .replace(/\(\s*\)/g, "");

  // 3) 혹시 남아있는 숫자/점 제거
  const cleaned = withoutParens
    .replace(/\d+(?:\.\d+)?/g, "")
    .replace(/[.]/g, "");

  // 4) 줄 단위 공백 정리 + 빈 줄 제거
  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

  return lines.join("\n");
}

// ====== HAFS 사이트에서 석식 가져오기(NEIS 지연 보완) ======
function ymdToDot(ymd) {
  // YYYYMMDD -> YYYY.MM.DD
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

function cleanHafsText(text) {
  if (!text) return "";

  // 석식 블록에서 같이 딸려오는 영양표/라벨 제거
  const dropPhrases = [
    "에너지",
    "탄수화물",
    "단백질",
    "지방",
    "칼슘",
    "kcal",
    // ⚠️ 'mg', 'g' 같은 단위는 메뉴 텍스트에도 자주 섞여서 오탐이 많아 제외
  ];

  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .filter((l) => !dropPhrases.some((p) => l.includes(p)));

  // 너무 짧은 한두 글자 라벨 제거(조/중/석 같은 배지)
  const cleaned = lines.filter((l) => l.length >= 2);

  // 중복 제거
  const uniq = [];
  const seen = new Set();
  for (const l of cleaned) {
    if (!seen.has(l)) {
      seen.add(l);
      uniq.push(l);
    }
  }

  return uniq.join("\n").trim();
}

function extractHafsMealSection(joinedText, label) {
  // label: "석식" or "야식" etc.
  const idx = joinedText.lastIndexOf(label);
  if (idx < 0) return null;

  const after = joinedText.slice(idx + label.length);

  // 메뉴가 끝나고 영양정보/다른 식사 라벨이 시작되는 지점에서 컷
  const stopKeys = [
    "에너지",
    "탄수화물",
    "단백질",
    "지방",
    "칼슘",
    "kcal",
    // 다른 식사 라벨(섞임 방지)
    "조식",
    "중식",
    "석식",
    // ⚠️ '야식'은 석식 블록 안에 '<야식>'로 포함될 수 있어서 여기서 자르면 안 됨
  ].filter((k) => k !== label); // 자기 자신은 제외

  let end = after.length;
  for (const k of stopKeys) {
    const j = after.indexOf(k);
    if (j >= 0 && j < end) end = j;
  }

  const block = after.slice(0, end);
  const cleaned = cleanHafsText(block);
  return cleaned || null;
}

async function fetchMealsFromHafsSite(targetYmd) {
  const html = await fetchHafsHtml(targetYmd);

  // script/style 제거
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  // ⚠️ `<야식>`이 HTML 태그처럼 보여서 `<[^>]+>` 정규식에 의해 통째로 사라질 수 있음
  // 먼저 `<야식>` / `&lt;야식&gt;`를 안전한 플레이스홀더로 바꿔둔 뒤 텍스트화하고,
  // 마지막에 다시 `<야식>`으로 복원한다.
  const YA_PLACEHOLDER = "__YA_SNACK__";

  let text = noScript
    // 엔티티 먼저 처리
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    // &lt;야식&gt; 형태도 잡기
    .replace(/&lt;\s*야식\s*&gt;/gi, `\n${YA_PLACEHOLDER}\n`)
    // 혹시 이미 <야식> 형태로 들어온 경우도 잡기 (태그 제거 전에!)
    .replace(/<\s*야식\s*>/gi, `\n${YA_PLACEHOLDER}\n`)
    // 줄바꿈 의미 태그 -> \n
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h\d)>/gi, "\n")
    // 나머지 태그 제거
    .replace(/<[^>]+>/g, "")
    // 남아있는 엔티티 처리
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    // 플레이스홀더 복원
    .replace(new RegExp(YA_PLACEHOLDER, "g"), "<야식>");

  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);

  const joined = lines.join("\n");

  const dinnerAll = extractHafsMealSection(joined, "석식");

  // 기본값
  let dinner = dinnerAll;
  let late = null;

  // 석식 블록 안에 '<야식>'이 실제로 포함된 경우: 석식/야식 분리
  if (dinnerAll && dinnerAll.includes("<야식>")) {
    const parts = dinnerAll.split("<야식>");
    const dinnerPart = (parts[0] || "").trim();
    const latePart = (parts.slice(1).join("\n") || "").trim();

    dinner = dinnerPart ? cleanHafsText(dinnerPart) : null;
    late = latePart ? cleanHafsText(latePart) : null;
  }

  return { dinner, late };
}

// ====== NEIS 급식 호출 ======
async function fetchMeals(fromYmd, toYmd) {
  const url = `${NEIS_BASE}/mealServiceDietInfo`;
  const params = {
    KEY: NEIS_KEY,
    Type: "json",
    pIndex: 1,
    pSize: 100,
    ATPT_OFCDC_SC_CODE,
    SD_SCHUL_CODE,
    MLSV_FROM_YMD: fromYmd,
    MLSV_TO_YMD: toYmd,
  };

  const { data } = await axios.get(url, { params });

  const block = data?.mealServiceDietInfo;
  if (!block || !Array.isArray(block) || !block[1]?.row) return [];
  return block[1].row;
}

function menuQuickReplies() {
  // 버튼 6개: 아침/점심/저녁/오늘/내일/이번주
  return [
    { label: "아침", action: "message", messageText: "아침" },
    { label: "점심", action: "message", messageText: "점심" },
    { label: "저녁", action: "message", messageText: "저녁" },
    { label: "오늘", action: "message", messageText: "오늘" },
    { label: "내일", action: "message", messageText: "내일" },
    { label: "이번주", action: "message", messageText: "이번주" },
  ];
}

function photoQuickReplies(ymd, meal) {
  // OpenBuilder에서 특정 문구가 다른 블록으로 라우팅되거나 매칭이 꼬일 수 있어
  // 버튼 라벨은 그대로 두고, 실제 발화는 짧고 안정적인 '사진'으로 보낸다.
  // 서버는 lastSelection 메모리로 어떤 날짜/식사 사진인지 알아서 처리한다.
  return [
    { label: "식단 사진 보기", action: "message", messageText: "사진" },
  ];
}

function kakaoText(text, quickReplies) {
  return {
    version: "2.0",
    template: {
      outputs: [{ simpleText: { text } }],
      ...(quickReplies ? { quickReplies } : {}),
    },
  };
}

function kakaoTextWithButtons(text) {
  return kakaoText(text, menuQuickReplies());
}

const BASE_URL = process.env.BASE_URL || "https://hafs-cafeteria.onrender.com";

function kakaoPhotoCards(titlePrefix, photos, fallbackText) {
  if (!photos || photos.length === 0) {
    // 사진이 없을 때는 버튼 없이 텍스트만
    return kakaoText(fallbackText || "식단 사진이 없습니다.", null);
  }

  // Kakao는 '파일 자체 업로드'를 스킬 응답으로 직접 보내는 걸 지원하지 않고,
  // 반드시 imageUrl을 통해 이미지를 불러오게 되어 있어요.
  // 대신 simpleImage를 쓰면 카톡 대화창에 이미지가 바로 표시됩니다.
  const outputs = [];

  for (const p of photos) {
    const proxied = `${BASE_URL}/img?url=${encodeURIComponent(p.imageUrl)}`;

    // 캡션(제목)
    outputs.push({
      simpleText: {
        text: `${titlePrefix} ${p.title}`.trim(),
      },
    });

    // 이미지 본문
    outputs.push({
      simpleImage: {
        imageUrl: proxied,
        altText: `${p.title}`.trim(),
      },
    });
  }

  return {
    version: "2.0",
    template: {
      outputs,
      // ✅ 사진 화면에서는 quickReplies 없음
    },
  };
}

// ====== 기본 라우트(브라우저에서 확인용) ======
app.get("/", (req, res) => {
  res.status(200).send(
    "✅ HAFS cafeteria bot is running. Use POST /kakao (Kakao webhook) or GET /health."
  );
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ====== 이미지 프록시 (HAFS 이미지 핫링크/차단 대응) ======
app.get("/img", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).send("Bad url");
    }

    // HAFS 도메인만 허용 (보안)
    const u = new URL(url);
    if (u.hostname !== "hafs.hs.kr") {
      return res.status(403).send("Forbidden");
    }

    // Cache hit
    const cached = imgProxyCache.get(url);
    const now = Date.now();
    if (cached && now - cached.ts < IMG_CACHE_TTL_MS) {
      res.setHeader("Content-Type", cached.ct || "image/jpeg");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Length", String(cached.buf.length));
      // 가벼운 로그
      console.log(`[img] cache hit ${u.pathname}`);
      return res.status(200).send(cached.buf);
    }

    console.log(`[img] fetch ${u.pathname}`);

    const resp = await axios.get(url, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://hafs.hs.kr/"
      },
      timeout: 5000,
    });

    // Kakao는 Content-Type이 image/* 가 아니면 이미지를 표시하지 않는 경우가 있음.
    // HAFS의 일부 파일은 확장자가 없거나 Content-Type이 비정상으로 올 수 있어 방어적으로 처리한다.
    const rawCt = String(resp.headers["content-type"] || "").toLowerCase();
    const ct = rawCt.startsWith("image/") ? rawCt : "image/jpeg";

    const buf = Buffer.from(resp.data);

    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Length", String(buf.length));

    // store cache (only if it looks like an image)
    imgProxyCache.set(url, { buf, ct, ts: Date.now() });

    return res.status(200).send(buf);
  } catch (e) {
    console.error("[img proxy failed]", e);
    return res.status(404).send("Not found");
  }
});

// ====== 웰컴/메뉴 전용 엔드포인트 (항상 버튼만 보여줌) ======
app.post("/menu", (req, res) => {
  return res.json(
    kakaoTextWithButtons(
      "원하는 버튼을 눌러 급식을 확인해주세요.\n\n• 아침/점심/저녁: 오늘 해당 식사\n• 오늘/내일/이번주: 전체 식단"
    )
  );
});

// 브라우저에서 확인용
app.get("/menu", (req, res) => {
  res.status(200).send("✅ Menu endpoint is ready. Use POST /menu from Kakao.");
});

// ====== 카카오 웹훅 ======
app.post("/kakao", async (req, res) => {
  try {
    if (!NEIS_KEY) {
      return res.json(
        kakaoTextWithButtons("서버 설정이 아직 안 됐어! .env에 NEIS_KEY를 넣어줘.")
      );
    }

    const userId = getUserId(req.body);
    const { utter, when, meal } = parseKakaoRequest(req.body);

    // ====== 사진 요청 처리: 사진|YYYYMMDD|meal 또는 라벨 기반(식단 사진 보기 등) ======
    if (utter && (utter.startsWith("사진|") || utter === "사진" || utter === "식단 사진" || utter === "식단 사진 보기" || utter.includes("식단 사진"))) {
      const parts = utter.split("|");
      let ymd = parts[1];
      let mealCode = parts[2] || "all";

      // 라벨 기반(예: '식단 사진 보기')으로 들어오면 마지막 조회 기록을 사용
      if (!ymd || !/^\d{8}$/.test(ymd)) {
        const last = loadLastSelection(userId);
        if (!last) {
          return res.json(
            kakaoTextWithButtons(
              "사진을 보려면 먼저 '아침/점심/저녁' 중 하나를 눌러 식단을 확인한 뒤, 다시 '식단 사진 보기'를 눌러주세요."
            )
          );
        }
        ymd = last.ymd;
        mealCode = last.meal;
      }
      const pretty = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

      if (mealCode === "week") {
        return res.json(
          kakaoTextWithButtons(
            "주간 보기에서는 날짜가 여러 개라 사진을 한 번에 보여주기 어려워요.\n\n'오늘/내일' 또는 '아침/점심/저녁'을 눌러서 날짜/식사를 선택한 뒤, 다시 '식단 사진 보기'를 눌러줘!"
          )
        );
      }

      const photos = [];
      let photoTimedOut = false;
      const withTimeout = async (promise, ms) => {
        let t;
        const timeout = new Promise((_, reject) => {
          t = setTimeout(() => reject(new Error("PHOTO_TIMEOUT")), ms);
        });
        try {
          return await Promise.race([promise, timeout]);
        } finally {
          clearTimeout(t);
        }
      };

      const addPhoto = async (koName) => {
        try {
          const url = await withTimeout(fetchMealPhotoFromHafsSite(ymd, koName), 2800);
          if (url) photos.push({ title: `(${pretty}) ${koName}`, imageUrl: url });
        } catch (e) {
          if (String(e?.message || "") === "PHOTO_TIMEOUT") {
            photoTimedOut = true;
          } else {
            console.error("[photo fetch error]", e);
          }
        }
      };

      if (mealCode === "breakfast") await addPhoto("조식");
      else if (mealCode === "lunch") await addPhoto("중식");
      else if (mealCode === "dinner") await addPhoto("석식");
      else {
        // all
        await addPhoto("조식");
        await addPhoto("중식");
        await addPhoto("석식");
      }

      if (photos.length === 0 && photoTimedOut) {
        return res.json(
          kakaoText(
            "사진 불러오기가 지연되고 있어요.\n서버가 잠깐 느린 것 같습니다. 10초 뒤에 다시 눌러주세요!",
            null
          )
        );
      }

      return res.json(
        kakaoPhotoCards("📷", photos, "식단 사진이 없습니다.")
      );
    }

    // 웰컴/메뉴 진입용 + 저장된 발화/버튼 외 입력이면 메뉴로 유도
    if (!utter || utter === "메뉴" || utter === "시작" || utter === "도움말" || !isRecognizedUtter(utter)) {
      return res.json(
        kakaoTextWithButtons(
          "원하는 버튼을 눌러 급식을 확인해주세요.\n\n• 아침/점심/저녁: 오늘 해당 식사\n• 오늘/내일/이번주: 전체 식단"
        )
      );
    }

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
      // 기본: today
      from = yyyymmdd(now);
      to = from;
    }

    // ====== 석식은 NEIS 업로드가 늦을 수 있어 학교 홈페이지에서 우선 시도 ======
    // (저녁 버튼은 기본적으로 오늘 석식 요청)
    if (meal === "dinner" && from === to) {
      try {
        const { dinner, late } = await fetchMealsFromHafsSite(from);
        if (dinner) {
          const pretty = `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}`;

          let combined = `🍽 석식\n📅 ${pretty}\n${dinner}`;

          // 사이트에 <야식>이 실제로 포함되어 있으면 그대로 이어 붙임
          if (late) {
            combined += `\n\n<야식>\n${late}`;
          }

          saveLastSelection(userId, from, "dinner");
          return res.json(
            kakaoText(combined, photoQuickReplies(from, "dinner"))
          );
        }
      } catch (e) {
        // 실패하면 NEIS로 폴백
        console.error("[dinner scrape failed]", e);
      }
    }

    const rows = await fetchMeals(from, to);

    // ====== 전체 보기(today/tomorrow/week)에서도 석식+야식 보완 ======
    // 각 날짜별로 석식이 필요한 경우 학교 사이트에서 추가 보완
    const hafsDinnerMap = new Map(); // YYYYMMDD -> { dinner, late }

    if (meal === "all") {
      const daysToCheck = [];

      if (from === to) {
        daysToCheck.push(from);
      } else {
        // 주간일 경우 from~to 범위 일자 생성
        let d = new Date(
          Number(from.slice(0, 4)),
          Number(from.slice(4, 6)) - 1,
          Number(from.slice(6, 8))
        );
        const end = new Date(
          Number(to.slice(0, 4)),
          Number(to.slice(4, 6)) - 1,
          Number(to.slice(6, 8))
        );
        while (d <= end) {
          daysToCheck.push(yyyymmdd(d));
          d = addDays(d, 1);
        }
      }

      // Kakao는 응답 제한 시간이 짧아서(타임아웃/무응답 방지)
      // 주간 요청은 동시성 제한(예: 3개)으로 빠르게 긁어온다.
      const settled = await mapWithConcurrency(daysToCheck, 3, async (day) => {
        const result = await fetchMealsFromHafsSite(day);
        return { day, result };
      });

      for (const s of settled) {
        if (!s || s instanceof Error) continue;
        const { day, result } = s;
        if (result?.dinner) {
          hafsDinnerMap.set(day, result);
        }
      }
    }

    // meal 필터링
    const filteredRows = meal === "all"
      ? rows
      : rows.filter(r => {
          const nm = (r.MMEAL_SC_NM || "").trim();
          if (meal === "breakfast") return nm.includes("조식");
          if (meal === "lunch") return nm.includes("중식");
          if (meal === "dinner") return nm.includes("석식");
          return true;
        });

    if (!filteredRows.length) {
      // NEIS가 주간/전체에서 데이터를 안 주는 경우가 있어도,
      // 학교 사이트에서 긁어온 석식(+야식)이 있으면 그걸로라도 보여준다.
      if (meal === "all" && hafsDinnerMap.size > 0) {
        const byDate = new Map();

        for (const [day, info] of hafsDinnerMap.entries()) {
          if (!byDate.has(day)) byDate.set(day, []);
          const { dinner, late } = info;

          let combined = `• 석식\n${dinner}`;
          if (late) {
            combined += `\n\n<야식>\n${late}`;
          }
          byDate.get(day).push(combined);
        }

        const days = [...byDate.keys()].sort();
        const text = days
          .map((d) => {
            const pretty = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
            return `📅 ${pretty}\n${byDate.get(d).join("\n\n")}`;
          })
          .join("\n\n──────────\n\n");

        return res.json(kakaoText(text, null));
      }

      if (meal === "all") {
        return res.json(
          kakaoTextWithButtons(
            "해당 날짜의 급식 정보가 아직 등록되지 않았거나 제공되지 않는 날입니다."
          )
        );
      } else {
        return res.json(
          kakaoTextWithButtons(
            `🍽 ${mealNameKo(meal)} 정보가 아직 등록되지 않았거나 오늘은 제공되지 않습니다.`
          )
        );
      }
    }

    // 날짜별로 묶어서 출력(주간일 때도 보기 좋게)
    const byDate = new Map();
    const dinnerAdded = new Set(); // YYYYMMDD: 석식(사이트 보완 포함) 추가 여부
    for (const r of filteredRows) {
      const day = r.MLSV_YMD; // YYYYMMDD
      const mealName = r.MMEAL_SC_NM; // 조식/중식/석식
      const dish = cleanDishText(r.DDISH_NM);

      if (!byDate.has(day)) byDate.set(day, []);

      // 전체 보기일 때 석식은 사이트 기준으로 덮어씀
      if (meal === "all" && mealName.includes("석식") && hafsDinnerMap.has(day)) {
        const { dinner, late } = hafsDinnerMap.get(day);
        let combined = `• 석식\n${dinner}`;
        if (late) {
          combined += `\n\n<야식>\n${late}`;
        }
        byDate.get(day).push(combined);
        dinnerAdded.add(day);
      } else {
        if (meal === "all") {
          byDate.get(day).push(`• ${mealName}\n${dish}`);
        } else {
          byDate.get(day).push(dish);
        }
      }
    }

    // NEIS에 석식이 아예 없을 때(업로드 지연)도 사이트 석식(+야식)을 추가로 붙여준다
    if (meal === "all" && hafsDinnerMap.size > 0) {
      for (const [day, info] of hafsDinnerMap.entries()) {
        if (!byDate.has(day)) byDate.set(day, []);
        if (dinnerAdded.has(day)) continue;

        const { dinner, late } = info;
        let combined = `• 석식\n${dinner}`;
        if (late) {
          combined += `\n\n<야식>\n${late}`;
        }
        byDate.get(day).push(combined);
        dinnerAdded.add(day);
      }
    }

    const days = [...byDate.keys()].sort();
    const text = days
      .map((d) => {
        const pretty = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        return `📅 ${pretty}\n${byDate.get(d).join("\n\n")}`;
      })
      .join("\n\n──────────\n\n");

    const header = meal === "all" ? "" : `🍽 ${mealNameKo(meal)}\n`;

    // 결과 화면: 주간(이번주)에서는 '식단 사진 보기' 버튼을 노출하지 않음
    if (when === "week" || meal === "all") {
      return res.json(kakaoText(header + text, null));
    }

    // 오늘/내일/아침/점심/저녁에서는 '식단 사진 보기' 버튼 1개만 제공
    saveLastSelection(userId, from, meal);
    return res.json(kakaoText(header + text, photoQuickReplies(from, meal)));
  } catch (err) {
    console.error(err);
    return res.json(kakaoTextWithButtons("급식 불러오다가 오류가 났어. 잠시 후 다시 시도해줘!"));
  }
});

// ====== Render 등 무료 호스팅 콜드스타트 완화용(선택) ======
// SELF_PING=1 로 설정하면 서버가 주기적으로 /health 를 호출해 잠들지 않게 시도한다.
if (process.env.SELF_PING === "1" && process.env.NODE_ENV === "production") {
  setInterval(() => {
    axios.get(`${BASE_URL}/health`, { timeout: 2000 }).catch(() => {});
  }, 4 * 60 * 1000);
}

// ====== 실행 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행중: http://localhost:${PORT}`));