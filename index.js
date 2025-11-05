/**
 * ESTACIO AGENT — index.js
 * Versão totalmente corrigida com detecção automática do Chrome no Render.
 */

import puppeteer from "puppeteer";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/* ============================================================
   ENV
============================================================ */
const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;
const COURSE_URL = process.env.COURSE_URL || "https://estudante.estacio.br/disciplinas";
const COOKIES_BASE64 = process.env.COOKIES_BASE64 || null;

const RUN_IMMEDIATELY = process.env.RUN_IMMEDIATELY === "true";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *";
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";
const HEADLESS = process.env.HEADLESS !== "false";

/* Diretório onde o Chrome foi instalado no Build */
const PUP_CACHE =
  process.env.PUPPETEER_CACHE_DIR ||
  path.join(process.cwd(), ".puppeteer");

/* ============================================================
   COOKIES (opcional)
============================================================ */
if (COOKIES_BASE64) {
  try {
    const buff = Buffer.from(COOKIES_BASE64, "base64");
    fs.writeFileSync("./cookies.json", buff);
    console.log("✅ cookies.json criado a partir de COOKIES_BASE64.");
  } catch (e) {
    console.warn("⚠️ Falha ao gravar cookies.json:", e.message);
  }
}

/* ============================================================
   FUNÇÃO: varredor recursivo para encontrar o binário "chrome"
============================================================ */
function findChromeBinary(startDir) {
  try {
    const stack = [startDir];

    while (stack.length) {
      const dir = stack.pop();

      if (!dir || !fs.existsSync(dir)) continue;

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const e of entries) {
        const fullPath = path.join(dir, e.name);

        if (e.isDirectory()) {
          stack.push(fullPath);
        } else if (e.isFile() && e.name === "chrome") {
          return fullPath;
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ Erro no finder recursivo:", e.message);
  }

  return null;
}

/* ============================================================
   FUNÇÃO: Resolve Path do Chrome
============================================================ */
function resolveChromePath() {
  // 1) Procurar no cache local do projeto (.puppeteer)
  const localChrome = findChromeBinary(path.join(PUP_CACHE, "chrome"));
  if (localChrome) return localChrome;

  // 2) Tentar o path do próprio Puppeteer
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  // 3) Tentativas comuns do SO
  const guesses = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium"
  ];

  for (const g of guesses) {
    if (fs.existsSync(g)) return g;
  }

  // 4) Último recurso → deixar o Puppeteer tentar sozinho
  return undefined;
}

/* ============================================================
   LAUNCH
============================================================ */
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
      "--no-first-run",
      "--no-zygote"
    ]
  });
}

/* ============================================================
   LOGIN
============================================================ */
async function ensureLoggedIn(page) {
  // Se existir cookies.json → tentar login automático
  try {
    if (fs.existsSync("./cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("./cookies.json", "utf8"));
      await page.setCookie(...cookies);
      console.log("✅ Cookies carregados.");
    }
  } catch (e) {
    console.warn("⚠️ Erro ao carregar cookies:", e.message);
  }

  await page.goto(COURSE_URL, { waitUntil: "domcontentloaded" });

  // Se já estiver logado:
  if (!page.url().includes("login")) {
    console.log("✅ Sessão já autenticada.");
    return;
  }

  console.log("🔑 Efetuando login…");

  await page.goto("https://estudante.estacio.br", {
    waitUntil: "domcontentloaded"
  });

  // E-mail
  await page.waitForSelector("input[type='email'], input[name='email']");
  await page.type("input[type='email'], input[name='email']", EMAIL, { delay: 50 });

  // Senha
  await page.type("input[type='password'], input[name='senha']", SENHA, { delay: 50 });

  // Enviar
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}),
    page.click("button[type='submit']").catch(() => {})
  ]);

  // Salvar cookies após login
  try {
    const cookies = await page.cookies();
    fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
    console.log("✅ Cookies salvos após login.");
  } catch (e) {
    console.warn("⚠️ Falha ao salvar cookies:", e.message);
  }
}

/* ============================================================
   Aguardar 15 minutos de aula
============================================================ */
async function waitMinimumWatchTime(page, minutes = 15) {
  const totalMs = minutes * 60 * 1000;
  const step = 30 * 1000;
  let waited = 0;

  console.log(`⏳ Aguardando ${minutes} minutos de aula…`);

  while (waited < totalMs) {
    await page.waitForTimeout(step);
    waited += step;

    try {
      await page.evaluate(() => window.scrollBy(0, 200));
    } catch {}
  }
}

/* ============================================================
   Marcar aula como concluída
============================================================ */
async function markLessonCompleted(page) {
  const xpaths = [
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'concluir')]",
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'finalizar')]",
    "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'completo')]"
  ];

  for (const xp of xpaths) {
    const [btn] = await page.$x(xp);
    if (btn) {
      try {
        await btn.click();
        console.log("✅ Aula marcada como concluída.");
        return true;
      } catch {}
    }
  }

  console.log("⚠️ Botão de concluir não encontrado.");
  return false;
}

/* ============================================================
   Resolver e responder testes automaticamente
============================================================ */
async function findAndDoModuleTests(page) {
  console.log("🔎 Procurando testes/atividades…");

  const keywords = ["teste", "atividade", "avaliação", "quiz", "prova", "múltipla escolha"];

  const elements = await page.$$("a, button, div, span");
  const found = [];

  for (const el of elements) {
    try {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (keywords.some(k => txt.includes(k))) found.push(el);
    } catch {}
  }

  if (found.length === 0) {
    console.log("ℹ️ Nenhum teste encontrado.");
    return;
  }

  console.log(`📌 ${found.length} atividade(s) encontrada(s).`);

  // Loop nas atividades
  for (const el of found) {
    try {
      await el.click();
      await page.waitForTimeout(1500);

      const questions = await page.$$(".question, .questao, fieldset, .form-group");

      if (questions.length) {
        for (const q of questions) {
          const options = await q.$$("label, .option, .alternativa, .answer");
          if (options.length) {
            const pick = Math.floor(Math.random() * options.length);
            try { await options[pick].click(); } catch {}
          }
        }
      }

      // Botão enviar
      const submitXPaths = [
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'enviar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'finalizar')]",
        "//button[@type='submit']"
      ];

      for (const xp of submitXPaths) {
        const [btn] = await page.$x(xp);
        if (btn) {
          try {
            await Promise.all([
              page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}),
              btn.click()
            ]);
          } catch {}
          console.log("✅ Teste enviado.");
          break;
        }
      }
    } catch (e) {
      console.warn("⚠️ Erro ao processar teste:", e.message);
    }
  }
}

/* ============================================================
   Execução completa
============================================================ */
async function processCourseOnce() {
  console.log("=== Início ===", new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE }));

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await ensureLoggedIn(page);

    await page.goto(COURSE_URL, { waitUntil: "networkidle2" });

    const anchors = await page.$$("a");
    let lessonHref = null;

    for (const a of anchors) {
      const href = await a.evaluate(el => el.getAttribute("href"));
      if (!href) continue;

      const low = href.toLowerCase();

      if (
        low.includes("conteudo") ||
        low.includes("conteúdos") ||
        low.includes("aula") ||
        low.includes("video")
      ) {
        lessonHref = new URL(href, page.url()).toString();
        break;
      }
    }

    if (!lessonHref) {
      console.log("ℹ️ Nenhuma aula encontrada.");
      await browser.close();
      return;
    }

    console.log("🔗 Abrindo aula:", lessonHref);
    await page.goto(lessonHref, { waitUntil: "networkidle2" });

    // tentar dar play no vídeo
    try {
      await page.evaluate(() => {
        const v = document.querySelector("video");
        if (v) v.play().catch(() => {});
      });
    } catch {}

    await waitMinimumWatchTime(page, 15);
    await markLessonCompleted(page);

    await findAndDoModuleTests(page);

    console.log("✅ Execução finalizada.");
  } catch (e) {
    console.error("❌ Erro:", e.message);
  }

  await browser.close();
}

/* ============================================================
   Scheduler
============================================================ */
function startScheduler() {
  console.log(`🔁 CRON ativado: "${CRON_SCHEDULE}" tz:${TIMEZONE}`);

  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try {
        await processCourseOnce();
      } catch (e) {
        console.error("Erro no agendamento:", e.message);
      }
    },
    { timezone: TIMEZONE }
  );
}

/* ============================================================
   Main
============================================================ */
(async () => {
  if (RUN_IMMEDIATELY) {
    console.log("⚡ RUN_IMMEDIATELY=true → executando agora…");
    await processCourseOnce();
  }

  startScheduler();
})();
