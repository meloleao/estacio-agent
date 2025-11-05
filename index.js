// index.js — Background Worker com Chrome empacotado em .puppeteer
import puppeteer from "puppeteer";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/* ====== ENV ====== */
const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;
const COURSE_URL = process.env.COURSE_URL || "https://estudante.estacio.br/disciplinas";
const COOKIES_BASE64 = process.env.COOKIES_BASE64 || null;
const RUN_IMMEDIATELY = process.env.RUN_IMMEDIATELY === "true";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *";
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";
const HEADLESS = process.env.HEADLESS !== "false";

/* 👉 NOVO: cache local empacotado no build */
const PUP_CACHE = process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), ".puppeteer");

/* ====== (resto das variáveis e funções iguais) ====== */

/* ====== Chrome path resolver (ajustado para .puppeteer) ====== */
function findChromeInCache(cacheDir = PUP_CACHE) {
  try {
    const chromeRoot = path.join(cacheDir, "chrome");
    if (!fs.existsSync(chromeRoot)) return null;

    // ex.: chrome/linux-131.0.6778.204/chrome-linux64/chrome
    for (const plat of fs.readdirSync(chromeRoot)) {
      const c1 = path.join(chromeRoot, plat, "chrome-linux64", "chrome");
      const c2 = path.join(chromeRoot, plat, "chrome-linux", "chrome");
      if (fs.existsSync(c1)) return c1;
      if (fs.existsSync(c2)) return c2;
    }
  } catch {}
  return null;
}

function resolveChromePath() {
  // 1) primeiro, procurar no cache empacotado do projeto (.puppeteer)
  const fromLocalCache = findChromeInCache(PUP_CACHE);
  if (fromLocalCache) return fromLocalCache;

  // 2) fallback: API do Puppeteer (caso ele saiba do binário)
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  // 3) últimos palpites do SO
  const guesses = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  for (const g of guesses) if (fs.existsSync(g)) return g;

  return undefined; // deixa o Puppeteer tentar
}

async function launchBrowser() {
  const execPath = resolveChromePath();
  console.log("🧭 Chrome path:", execPath || "(default by Puppeteer)");

  return await puppeteer.launch({
    headless: HEADLESS,
    executablePath: execPath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--no-first-run"
    ]
  });
}

/* ====== DAQUI PRA BAIXO, MANTENHA O MESMO CÓDIGO QUE JÁ ESTÁ USANDO ====== */
/* (ensureLoggedIn, waitMinimumWatchTime, markLessonCompleted, findAndDoModuleTests,
   processCourseOnce, startScheduler e main) */
