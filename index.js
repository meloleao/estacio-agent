// index.js — Background Worker (Render)
// Correções: resolução dinâmica do caminho do Chrome + fallback
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
const PUP_CACHE = process.env.PUPPETEER_CACHE_DIR || "/opt/render/.cache/puppeteer";

/* ====== COOKIES (opcional) ====== */
if (COOKIES_BASE64) {
  try {
    const buff = Buffer.from(COOKIES_BASE64, "base64");
    fs.writeFileSync("./cookies.json", buff);
    console.log("✅ cookies.json criado a partir de COOKIES_BASE64.");
  } catch (e) {
    console.warn("⚠️ Falha ao gravar cookies.json:", e.message);
  }
}

/* ====== Chrome path resolver ====== */
function findChromeInCache(cacheDir = PUP_CACHE) {
  try {
    if (!fs.existsSync(cacheDir)) return null;
    // procura .../chrome/linux-xxx/chrome
    const chromeRoot = path.join(cacheDir, "chrome");
    if (!fs.existsSync(chromeRoot)) return null;

    const platforms = fs.readdirSync(chromeRoot); // ex: ['linux-131.0.6778.204']
    for (const plat of platforms) {
      const candidate = path.join(chromeRoot, plat, "chrome-linux64", "chrome");
      const candidate2 = path.join(chromeRoot, plat, "chrome-linux", "chrome");
      if (fs.existsSync(candidate)) return candidate;
      if (fs.existsSync(candidate2)) return candidate2;
    }
  } catch {}
  return null;
}

function resolveChromePath() {
  // 1) valor que o Puppeteer expõe
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  // 2) procurar no cache padrão do Render
  const fromCache = findChromeInCache(PUP_CACHE);
  if (fromCache) return fromCache;
  // 3) possíveis binários do sistema
  const guesses = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  // 4) como último recurso, deixa o Puppeteer decidir
  return undefined;
}

/* ====== Browser ====== */
async function launchBrowser() {
  const execPath = resolveChromePath();
  console.log("🧭 Chrome path:", execPath || "(default by Puppeteer)");
  return await puppeteer.launch({
    headless: HEADLESS,
    executablePath: execPath, // pode ser undefined (Puppeteer decide)
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

/* ====== Login ====== */
async function ensureLoggedIn(page) {
  try {
    if (fs.existsSync("./cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("./cookies.json", "utf8"));
      if (Array.isArray(cookies) && cookies.length) {
        await page.setCookie(...cookies);
        console.log("✅ Cookies carregados.");
      }
    }
  } catch (e) { console.warn("⚠️ Erro ao carregar cookies:", e.message); }

  await page.goto(COURSE_URL, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("login")) { console.log("✅ Sessão autenticada."); return; }

  if (!EMAIL || !SENHA) throw new Error("Credenciais ausentes");

  console.log("🔑 Fazendo login…");
  await page.goto("https://estudante.estacio.br", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[type='email'], input#email, input[name='email']", { timeout: 15000 });
  await page.type("input[type='email'], input#email, input[name='email']", EMAIL, { delay: 40 });
  await page.type("input[type='password'], input[name='password'], input[name='senha']", SENHA, { delay: 40 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
    page.click("button[type='submit']").catch(() => {})
  ]);

  try {
    const cookies = await page.cookies();
    fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
    console.log("✅ Cookies salvos.");
  } catch (e) { console.warn("⚠️ Falha ao salvar cookies:", e.message); }
}

/* ====== Aula ====== */
async function waitMinimumWatchTime(page, minutes = 15) {
  const ms = minutes * 60 * 1000;
  const step = 30 * 1000;
  let waited = 0;
  console.log(`⏳ Aguardando ${minutes} minutos…`);
  while (waited < ms) {
    const chunk = Math.min(step, ms - waited);
    await page.waitForTimeout(chunk);
    waited += chunk;
    try { await page.evaluate(() => window.scrollBy(0, 200)); } catch {}
  }
}

async function markLessonCompleted(page) {
  const xps = [
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'concluir')]",
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'finalizar')]",
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'completo')]"
  ];
  for (const xp of xps) {
    const [btn] = await page.$x(xp);
    if (btn) {
      try { await btn.click(); console.log("✅ Aula marcada como concluída."); return true; } catch {}
    }
  }
  console.log("⚠️ Botão de concluir não encontrado.");
  return false;
}

/* ====== Testes ====== */
async function findAndDoModuleTests(page) {
  console.log("🔎 Buscando testes/atividades…");
  const kws = ["teste", "atividade", "avaliação", "quiz", "prova", "múltipla escolha"];
  const els = await page.$$("a, button, div, span");
  const targets = [];
  for (const el of els) {
    try {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (kws.some(k => txt.includes(k))) targets.push(el);
    } catch {}
  }
  if (targets.length === 0) { console.log("ℹ️ Nenhuma atividade encontrada."); return; }

  console.log(`📌 ${targets.length} atividade(s) encontrada(s).`);
  for (const el of targets) {
    try {
      await el.click();
      await page.waitForTimeout(1500);

      const blocks = await page.$$(".question, .questao, .q-item, .enunciado, fieldset, .form-group");
      if (blocks.length) {
        for (const qb of blocks) {
          const labels = await qb.$$("label, .option, .alternativa, .answer");
          if (labels.length) {
            const pick = Math.floor(Math.random() * labels.length);
            try { await labels[pick].click(); } catch {}
          }
        }
      } else {
        const radios = await page.$$("input[type='radio']");
        const byName = {};
        for (const r of radios) {
          const n = await r.evaluate(e => e.name || "");
          if (!byName[n]) byName[n] = [];
          byName[n].push(r);
        }
        for (const name in byName) {
          const opts = byName[name];
          const pick = Math.floor(Math.random() * opts.length);
          try { await opts[pick].click(); } catch {}
        }
      }

      const submitXps = [
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'enviar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'finalizar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'submeter')]",
        "//button[@type='submit']"
      ];
      let submitted = false;
      for (const xp of submitXps) {
        const [btn] = await page.$x(xp);
        if (btn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
            btn.click().catch(() => {})
          ]);
          submitted = true;
          break;
        }
      }
      console.log(submitted ? "✅ Teste enviado." : "⚠️ Não foi possível enviar o teste.");

      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        await page.screenshot({ path: `./testshot_${ts}.png` });
      } catch {}
    } catch (e) {
      console.warn("⚠️ Erro ao processar atividade:", e.message);
    }
  }
}

/* ====== Execução ====== */
async function processCourseOnce() {
  console.log("=== Início de execução:", new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE }), "===");
  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await ensureLoggedIn(page);

    await page.goto(COURSE_URL, { waitUntil: "networkidle2" });

    // achar link de aula
    let lessonHref = null;
    const anchors = await page.$$("a");
    for (const a of anchors) {
      const href = await a.evaluate(el => el.getAttribute("href"));
      if (!href) continue;
      const low = href.toLowerCase();
      if (low.includes("conteudo") || low.includes("conteúdos") || low.includes("aula") || low.includes("video") || low.includes("vídeo")) {
        lessonHref = new URL(href, page.url()).toString();
        break;
      }
    }
    if (!lessonHref) { console.log("ℹ️ Nenhuma aula encontrada."); await browser.close(); return; }

    console.log("🔗 Abrindo aula:", lessonHref);
    await page.goto(lessonHref, { waitUntil: "networkidle2" });

    try {
      await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); });
    } catch {}

    await waitMinimumWatchTime(page, 15);
    await markLessonCompleted(page);
    await findAndDoModuleTests(page);

    try { const ts = new Date().toISOString().replace(/[:.]/g, "-"); await page.screenshot({ path: `./screenshot_${ts}.png` }); } catch {}

  } catch (e) {
    console.error("❌ Erro durante execução:", e.message);
  }

  await browser.close();
  console.log("=== Fim de execução ===");
}

/* ====== Scheduler ====== */
function startScheduler() {
  console.log(`🔁 CRON "${CRON_SCHEDULE}" (tz: ${TIMEZONE}).`);
  cron.schedule(CRON_SCHEDULE, async () => {
    try { await processCourseOnce(); }
    catch (e) { console.error("❌ Execução agendada falhou:", e.message); }
  }, { timezone: TIMEZONE });
}

/* ====== Main ====== */
(async () => {
  if (RUN_IMMEDIATELY) {
    console.log("⚡ RUN_IMMEDIATELY=true → executando agora…");
    await processCourseOnce();
  }
  startScheduler();
})();
