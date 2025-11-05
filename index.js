/**
 * ESTACIO AGENT — index.js (robusto para grid + SPA)
 * - Varre TODAS as disciplinas (card "Digital (Ead)" e "Continue de onde parou")
 * - Clica no botão circular de seta do card
 * - Dentro da disciplina: Acessar conteúdo/Avançar → play → 15min → Marcar como estudado
 * - Faz atividades/testes e volta ao grid
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
  const localChrome = findChromeBinary(path.join(PUP_CACHE, "chrome"));
  if (localChrome) return localChrome;

  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}

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

/* ==================== HELPERS ==================== */

async function findElementByText(pageOrRoot, selector, keywords) {
  const els = await pageOrRoot.$$(selector);
  for (const el of els) {
    try {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (keywords.some(k => txt.includes(k.toLowerCase()))) return el;
    } catch {}
  }
  return null;
}

async function findAllByText(pageOrRoot, selector, keywords) {
  const out = [];
  const els = await pageOrRoot.$$(selector);
  for (const el of els) {
    try {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (keywords.some(k => txt.includes(k.toLowerCase()))) out.push(el);
    } catch {}
  }
  return out;
}

/** Clique com suporte a SPA (espera mudar URL OU sair do grid) */
async function clickAndWaitSPA(page, element, timeout = 9000) {
  const oldUrl = page.url();
  try { await element.evaluate(el => el.scrollIntoView({ block: "center", inline: "center" })); } catch {}
  await element.click({ delay: 50 });

  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (page.url() !== oldUrl) return true;
    const stillOnGrid = await page.evaluate(() => {
      const t = (document.body.innerText || "").toLowerCase();
      return t.includes("minhas disciplinas") || t.includes("continue de onde parou");
    }).catch(() => false);
    if (!stillOnGrid) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/* ==================== LOGIN ==================== */
async function ensureLoggedIn(page) {
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

  console.log("🔑 Efetuando login…");
  await page.goto("https://estudante.estacio.br", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("input[type='email'], input[name='email']", { timeout: 15000 });
  await page.type("input[type='email'], input[name='email']", EMAIL, { delay: 50 });
  await page.type("input[type='password'], input[name='senha'], input[name='password']", SENHA, { delay: 50 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
    page.click("button[type='submit']").catch(() => {})
  ]);

  try {
    const cookies = await page.cookies();
    fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
    console.log("✅ Cookies salvos após login.");
  } catch (e) {
    console.warn("⚠️ Falha ao salvar cookies:", e.message);
  }
}

/* ================ Tempo mínimo da aula ================ */
async function waitMinimumWatchTime(page, minutes = 15) {
  const totalMs = minutes * 60 * 1000;
  const step = 30000;
  let waited = 0;
  console.log(`⏳ Aguardando ${minutes} minutos…`);
  while (waited < totalMs) {
    const chunk = Math.min(step, totalMs - waited);
    await page.waitForTimeout(chunk);
    waited += chunk;
    try { await page.evaluate(() => window.scrollBy(0, 240)); } catch {}
  }
}

/* ================ Ações dentro da aula ================ */

async function clickPrimaryProgressButtons(page) {
  // “Acessar conteúdo”, “Avançar”, “Próximo”
  const keys = ["acessar conteúdo", "avançar", "próximo", "acessar conteudo"];
  const btn = await findElementByText(page, "button, a[role='button']", keys);
  if (!btn) return false;
  try { await btn.click(); await page.waitForTimeout(800); return true; } catch {}
  return false;
}

async function markLessonCompleted(page) {
  // Botão fica com um timer: “Marcar como estudado (03:11)”
  const key = "marcar como estudado";
  let tries = 20;
  while (tries--) {
    const el = await findElementByText(page, "button, a[role='button'], div", [key]);
    if (el) {
      const txt = (await (await el.getProperty("innerText")).jsonValue() || "").toLowerCase();
      const hasTimer = /\(\d+:\d+\)/.test(txt);
      if (!hasTimer) {
        try { await el.click(); console.log("✅ Aula marcada como estudada."); return true; } catch {}
      }
    }
    await page.waitForTimeout(6000);
  }
  console.log("⚠️ Não consegui marcar como estudada (tempo não liberou?).");
  return false;
}

/* ================== Testes/Atividades ================== */
async function findAndDoModuleTests(page) {
  console.log("🔎 Procurando testes/atividades…");
  const kws = ["atividade", "teste", "avaliação", "quiz", "prova", "múltipla escolha"];

  // entrar nas atividades se houver link/botão
  const entries = await findAllByText(page, "a, button, div, span", kws);
  for (const el of entries) {
    try {
      await el.click();
      await page.waitForTimeout(1000);
    } catch {}
  }

  // responder (heurística)
  const blocks = await page.$$(".question, .questao, .q-item, .enunciado, fieldset, .form-group");
  if (blocks.length) {
    for (const b of blocks) {
      const opts = await b.$$("label, .option, .alternativa, .answer, input[type='radio'] + label, li");
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

  // botão “Responda”, “Enviar”, “Finalizar”
  const send = await findElementByText(page, "button, a[role='button']", ["responda", "enviar", "finalizar", "submeter", "concluir"]);
  if (send) {
    try { await send.click(); await page.waitForTimeout(1200); console.log("✅ Teste/atividade enviado(a)."); } catch {}
  }
}

/* ================== GRID: localizar e abrir disciplinas ================== */

/**
 * Retorna os botões circulares de "seta" dentro de cards.
 * Estratégias:
 *  - procurar containers cujo texto contenha “Digital (Ead)” OU “Continue de onde parou”
 *  - dentro do container, pegar o **último** botão com `svg` e tamanho ≥ 40px
 */
async function getOpenCourseButtons(page) {
  const containers = await page.$$("article, section, div");
  const buttons = [];

  for (const c of containers) {
    let isCard = false;
    try {
      const txt = (await (await c.getProperty("innerText")).jsonValue() || "").toLowerCase();
      if (!txt) continue;
      if (txt.includes("digital (ead)") || txt.includes("continue de onde parou")) {
        isCard = true;
      }
    } catch {}

    if (!isCard) continue;

    // pega botões do card
    const btns = await c.$$("button");
    if (!btns.length) continue;

    // filtra por "circular com svg" e tamanho
    const circleCandidates = [];
    for (const b of btns) {
      const ok = await b.evaluate((el) => {
        try {
          const rect = el.getBoundingClientRect();
          if (!rect || !rect.width || !rect.height) return false;
          if (rect.width < 40 || rect.height < 40) return false;
          const approxSquare = Math.abs(rect.width - rect.height) <= 16;
          if (!approxSquare) return false;
          const hasIcon = !!el.querySelector("svg");
          return hasIcon;
        } catch { return false; }
      });
      if (ok) circleCandidates.push(b);
    }

    const chosen = circleCandidates.length ? circleCandidates[circleCandidates.length - 1] : btns[btns.length - 1];
    if (chosen) buttons.push(chosen);
  }

  // de-duplicar por referência
  const uniq = [];
  for (const b of buttons) {
    let dup = false;
    for (const u of uniq) {
      const same = await page.evaluate((a, b) => a === b, u, b).catch(() => false);
      if (same) { dup = true; break; }
    }
    if (!dup) uniq.push(b);
  }
  return uniq;
}

async function gotoHome(page) {
  await page.goto(COURSE_URL, { waitUntil: "networkidle2" });
}

async function openDisciplineByIndex(page, idx) {
  await gotoHome(page);
  const btns = await getOpenCourseButtons(page);
  if (!btns.length || idx >= btns.length) {
    console.log("⚠️ Nenhum botão de abrir disciplina detectado.");
    return false;
  }
  const ok = await clickAndWaitSPA(page, btns[idx], 10000);
  return ok;
}

/* ================== Processamento de uma disciplina ================== */
async function processSingleDiscipline(page, maxItemsPerDiscipline = 5) {
  let processed = 0;
  while (processed < maxItemsPerDiscipline) {
    // tenta “Acessar conteúdo/Avançar”
    await clickPrimaryProgressButtons(page);

    // dá play em vídeo (se existir)
    try {
      await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); });
    } catch {}

    // se entrou numa página de conteúdo, espera e tenta marcar
    await waitMinimumWatchTime(page, 15);
    await markLessonCompleted(page);

    // procura e executa atividades
    await findAndDoModuleTests(page);

    processed += 1;

    // Tenta voltar (se houver “Voltar”)
    const backBtn = await findElementByText(page, "a, button", ["voltar", "retornar"]);
    if (backBtn) {
      try { await backBtn.click(); await page.waitForTimeout(1200); } catch {}
    } else {
      // ou navega pro grid de novo
      try { await gotoHome(page); } catch {}
      break;
    }
  }
  console.log(`✅ Itens processados nesta disciplina: ${processed}`);
}

/* ================== Orquestrador ================== */
async function processAllDisciplines(page, maxDisciplines = 12) {
  console.log("🗂  Varredura das disciplinas…");
  await gotoHome(page);

  const btns = await getOpenCourseButtons(page);
  const total = Math.min(maxDisciplines, btns.length);

  if (!total) {
    console.log("ℹ️ Nenhum botão de abrir disciplina encontrado no grid.");
    return;
  }

  console.log(`📦 Detectados ${btns.length} cards • Processando até ${total}.`);

  for (let i = 0; i < total; i++) {
    console.log(`\n=== 📚 Disciplina ${i + 1}/${total} ===`);
    const opened = await openDisciplineByIndex(page, i);
    if (!opened) {
      console.log(`↷ Clique não abriu a disciplina ${i + 1}. Pulando…`);
      continue;
    }

    try {
      await processSingleDiscipline(page, 5);
    } catch (e) {
      console.warn("⚠️ Erro na disciplina:", e.message);
    }

    try { await gotoHome(page); } catch {}
  }

  console.log("\n✅ Varredura concluída.");
}

/* ================== Execução/Scheduler ================== */
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
