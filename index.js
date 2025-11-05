/**
 * ESTACIO AGENT — index.js
 * - Varre TODAS as disciplinas do grid
 * - Assiste 15min, tenta concluir e faz testes
 * - Compatível com Render (Chrome em .puppeteer)
 */

import puppeteer from "puppeteer";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/* ==================== ENV ==================== */
const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;
const COURSE_URL = process.env.COURSE_URL || "https://estudante.estacio.br/disciplinas";
const COOKIES_BASE64 = process.env.COOKIES_BASE64 || null;

const RUN_IMMEDIATELY = process.env.RUN_IMMEDIATELY === "true";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *";
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";
const HEADLESS = process.env.HEADLESS !== "false";

/** Diretório onde o Chrome foi instalado no build */
const PUP_CACHE = process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), ".puppeteer");

/* ================= Cookies opcionais ================= */
if (COOKIES_BASE64) {
  try {
    const buff = Buffer.from(COOKIES_BASE64, "base64");
    fs.writeFileSync("./cookies.json", buff);
    console.log("✅ cookies.json criado a partir de COOKIES_BASE64.");
  } catch (e) {
    console.warn("⚠️ Falha ao gravar cookies.json:", e.message);
  }
}

/* ============= Chrome path resolver (Render) ============= */
function findChromeBinary(startDir) {
  try {
    const stack = [startDir];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir || !fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(fp);
        else if (e.isFile() && e.name === "chrome") return fp;
      }
    }
  } catch {}
  return null;
}

function resolveChromePath() {
  // 1) .puppeteer (empacotado no projeto)
  const localChrome = findChromeBinary(path.join(PUP_CACHE, "chrome"));
  if (localChrome) return localChrome;

  // 2) API do Puppeteer
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  // 3) Palpites do SO
  for (const g of ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
    if (fs.existsSync(g)) return g;
  }
  return undefined;
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
      "--no-first-run",
      "--no-zygote"
    ]
  });
}

/* ==================== LOGIN ==================== */
async function ensureLoggedIn(page) {
  // cookies
  try {
    if (fs.existsSync("./cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("./cookies.json", "utf8"));
      if (Array.isArray(cookies) && cookies.length) {
        await page.setCookie(...cookies);
        console.log("✅ Cookies carregados.");
      }
    }
  } catch (e) {
    console.warn("⚠️ Erro ao carregar cookies:", e.message);
  }

  await page.goto(COURSE_URL, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("login")) {
    console.log("✅ Sessão já autenticada.");
    return;
  }

  // login
  console.log("🔑 Efetuando login…");
  await page.goto("https://estudante.estacio.br", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("input[type='email'], input[name='email']", { timeout: 15000 });
  await page.type("input[type='email'], input[name='email']", EMAIL, { delay: 50 });
  await page.type("input[type='password'], input[name='senha'], input[name='password']", SENHA, { delay: 50 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
    page.click("button[type='submit']").catch(() => {})
  ]);

  // salva cookies
  try {
    const cookies = await page.cookies();
    fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
    console.log("✅ Cookies salvos após login.");
  } catch (e) {
    console.warn("⚠️ Falha ao salvar cookies:", e.message);
  }
}

/* ================ AULA: aguardar 15 minutos ================ */
async function waitMinimumWatchTime(page, minutes = 15) {
  const totalMs = minutes * 60 * 1000;
  const step = 30 * 1000;
  let waited = 0;
  console.log(`⏳ Aguardando ${minutes} minutos de aula…`);
  while (waited < totalMs) {
    const chunk = Math.min(step, totalMs - waited);
    await page.waitForTimeout(chunk);
    waited += chunk;
    try { await page.evaluate(() => window.scrollBy(0, 200)); } catch {}
  }
}

/* ================= Marcar aula concluída ================= */
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

/* ================== Testes/Atividades ================== */
async function findAndDoModuleTests(page) {
  console.log("🔎 Procurando testes/atividades…");
  const kws = ["teste", "atividade", "avaliação", "quiz", "prova", "múltipla escolha"];
  const els = await page.$$("a, button, div, span");
  const targets = [];

  for (const el of els) {
    try {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (kws.some(k => txt.includes(k))) targets.push(el);
    } catch {}
  }

  if (!targets.length) { console.log("ℹ️ Nenhuma atividade encontrada."); return; }
  console.log(`📌 ${targets.length} atividade(s) encontrada(s).`);

  for (const el of targets) {
    try {
      await el.click();
      await page.waitForTimeout(1200);

      // perguntas → escolhe uma opção por bloco ou por name
      const blocks = await page.$$(".question, .questao, .q-item, .enunciado, fieldset, .form-group");
      if (blocks.length) {
        for (const b of blocks) {
          const opts = await b.$$("label, .option, .alternativa, .answer");
          if (opts.length) {
            const pick = Math.floor(Math.random() * opts.length);
            try { await opts[pick].click(); } catch {}
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

      // enviar
      const submitXps = [
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'enviar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'finalizar')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'submeter')]",
        "//button[@type='submit']"
      ];
      for (const xp of submitXps) {
        const [btn] = await page.$x(xp);
        if (btn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
            btn.click().catch(() => {})
          ]);
          console.log("✅ Teste enviado.");
          break;
        }
      }
    } catch (e) {
      console.warn("⚠️ Erro ao processar atividade:", e.message);
    }
  }
}

/* ================== Navegação por disciplinas ================== */
async function gotoHome(page) {
  await page.goto(COURSE_URL, { waitUntil: "networkidle2" });
}

async function openCourseByIndex(page, courseIndex) {
  await gotoHome(page);

  const cards = await page.$$(
    "article, div[class*='card']:not([class*='small']), div[data-testid*='card']"
  );
  if (!cards.length || courseIndex >= cards.length) return false;

  const card = cards[courseIndex];

  // pular 100%
  try {
    const percentEl = await card.$("div:has-text('%'), span:has-text('%')");
    if (percentEl) {
      const txt = (await percentEl.evaluate(el => el.textContent)).trim();
      const m = txt.match(/(\d{1,3})\s*%/);
      if (m && Number(m[1]) >= 100) {
        console.log(`↷ Pulando disciplina ${courseIndex + 1} (100%).`);
        return false;
      }
    }
  } catch {}

  // cliques possíveis
  const inside = [
    "button[aria-label*='Ir' i]",
    "button[aria-label*='Continuar' i]",
    "a[href]",
    "button"
  ];
  for (const sel of inside) {
    const el = await card.$(sel);
    if (el) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}),
          el.click()
        ]);
        return true;
      } catch {}
    }
  }
  // fallback: clicar no card
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}),
      card.click()
    ]);
    return true;
  } catch {}
  return false;
}

async function processSingleDiscipline(page, maxItemsPerDiscipline = 5) {
  let processed = 0;
  while (processed < maxItemsPerDiscipline) {
    // localizar uma aula/conteúdo
    let lessonHref = null;
    const anchors = await page.$$("a");
    for (const a of anchors) {
      const href = await a.evaluate(el => el.getAttribute("href"));
      if (!href) continue;
      const low = href.toLowerCase();
      if (
        low.includes("conteudo") || low.includes("conteúdos") ||
        low.includes("aula")     || low.includes("video") ||
        low.includes("vídeo")    || low.includes("material") ||
        low.includes("assistir")
      ) {
        lessonHref = new URL(href, page.url()).toString();
        break;
      }
    }

    if (lessonHref) {
      console.log("🔗 Abrindo aula:", lessonHref);
      await page.goto(lessonHref, { waitUntil: "networkidle2" });
      try { await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); }); } catch {}
      await waitMinimumWatchTime(page, 15);
      await markLessonCompleted(page);
      await findAndDoModuleTests(page);
      processed += 1;
      try { await page.goBack({ waitUntil: "networkidle2" }); } catch {}
      continue;
    }

    // se não achou aula, tenta só atividades
    await findAndDoModuleTests(page);
    break;
  }
  console.log(`✅ Itens processados nesta disciplina: ${processed}`);
}

async function processAllDisciplines(page, maxDisciplines = 12) {
  console.log("🗂  Varredura das disciplinas…");
  await gotoHome(page);

  const count = (await page.$$(
    "article, div[class*='card']:not([class*='small']), div[data-testid*='card']"
  )).length;

  const total = Math.min(maxDisciplines, Math.max(count, 0));
  if (!total) { console.log("ℹ️ Nenhuma disciplina no grid."); return; }

  for (let i = 0; i < total; i++) {
    console.log(`\n=== 📚 Disciplina ${i + 1}/${total} ===`);
    const opened = await openCourseByIndex(page, i);
    if (!opened) { console.log(`↷ Não consegui abrir a disciplina ${i + 1}. Pulando…`); continue; }
    try { await processSingleDiscipline(page, 5); } catch (e) { console.warn("⚠️ Erro na disciplina:", e.message); }
    try { await gotoHome(page); } catch {}
  }
  console.log("\n✅ Varredura concluída.");
}

/* ================== Execução e Scheduler ================== */
async function processCourseOnce() {
  console.log("=== Início ===", new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE }));
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await ensureLoggedIn(page);
    await processAllDisciplines(page, 12);
  } catch (e) {
    console.error("❌ Erro:", e.message);
  }
  await browser.close();
}

function startScheduler() {
  console.log(`🔁 CRON ativado: "${CRON_SCHEDULE}" tz:${TIMEZONE}`);
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try { await processCourseOnce(); } catch (e) { console.error("Erro no agendamento:", e.message); }
    },
    { timezone: TIMEZONE }
  );
}

/* ================== Main ================== */
(async () => {
  if (RUN_IMMEDIATELY) {
    console.log("⚡ RUN_IMMEDIATELY=true → executando agora…");
    await processCourseOnce();
  }
  startScheduler();
})();
