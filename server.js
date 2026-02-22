import express from "express";
import axios from "axios";
import dotenv from "dotenv";

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
  const exact = new Set(["아침", "점심", "저녁", "오늘", "내일", "이번주", "이번 주", "메뉴", "시작", "도움말"]);
  if (exact.has(u)) return true;

  // 포함되는 키워드(조식/중식/석식, 주간 등)
  const keywords = ["아침", "점심", "저녁", "조식", "중식", "석식", "오늘", "내일", "이번주", "이번 주", "주간", "메뉴", "시작", "도움말"];
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

function mealQuickReplies() {
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

function kakaoTextWithButtons(text) {
  return {
    version: "2.0",
    template: {
      outputs: [{ simpleText: { text } }],
      quickReplies: mealQuickReplies(),
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

    const { utter, when, meal } = parseKakaoRequest(req.body);

    // 웰컴/메뉴 진입용 + 저장된 발화/버튼 외 입력이면 메뉴로 유도
    if (!utter || utter === "메뉴" || utter === "시작" || utter === "도움말" || !isRecognizedUtter(utter)) {
      return res.json(
        kakaoTextWithButtons(
          "원하는 버튼을 눌러 급식을 확인해줘!\n\n• 아침/점심/저녁: 오늘 해당 식사\n• 오늘/내일/이번주: 전체 식단"
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

    const rows = await fetchMeals(from, to);

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
      return res.json(kakaoTextWithButtons("급식 정보가 없습니다."));
    }

    // 날짜별로 묶어서 출력(주간일 때도 보기 좋게)
    const byDate = new Map();
    for (const r of filteredRows) {
      const day = r.MLSV_YMD; // YYYYMMDD
      const mealName = r.MMEAL_SC_NM; // 조식/중식/석식
      const dish = cleanDishText(r.DDISH_NM);

      if (!byDate.has(day)) byDate.set(day, []);
      if (meal === "all") {
        byDate.get(day).push(`• ${mealName}\n${dish}`);
      } else {
        // 특정 식사만 보는 경우: 식사명은 생략하고 메뉴만
        byDate.get(day).push(dish);
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
    return res.json(kakaoTextWithButtons(header + text));
  } catch (err) {
    console.error(err);
    return res.json(kakaoTextWithButtons("급식 불러오다가 오류가 났어. 잠시 후 다시 시도해줘!"));
  }
});

// ====== 실행 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행중: http://localhost:${PORT}`));