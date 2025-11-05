/**
 * ESTACIO AGENT — index.js (fallback por título com XPath/translate sem acentos)
 * - Grid: tenta botões; se falhar, abre por TÍTULO com XPath robusto
 * - Aula: Acessar/Avançar → play → 15min → Marcar como estudado → Atividades/Testes
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

/** Títulos de disciplinas p/ fallback */
const COURSE_TITLES = (process.env.COURSE_TITLES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

/** Diretório do Chrome baixado no build */
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
async function clickAndWaitSPA(page, element, timeout = 10000) {
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
  const keys = ["acessar conteúdo", "avançar", "próximo", "acessar conteudo"];
  const btn = await findElementByText(page, "button, a[role='button']", keys);
  if (!btn) return false;
  try { await btn.click(); await page.waitForTimeout(800); return true; } catch {}
  return false;
}

async function markLessonCompleted(page) {
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

  const entries = await findAllByText(page, "a, button, div, span", kws);
  for (const el of entries) {
    try { await el.click(); await page.waitForTimeout(1000); } catch {}
  }

  // responder (heurística simples)
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

  const send = await findElementByText(page, "button, a[role='button']", ["responda", "enviar", "finalizar", "submeter", "concluir"]);
  if (send) {
    try { await send.click(); await page.waitForTimeout(1200); console.log("✅ Teste/atividade enviado(a)."); } catch {}
  }
}

/* ================== GRID: localizar e abrir disciplinas ================== */

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

    const btns = await c.$$("button");
    if (!btns.length) continue;

    const circleCandidates = [];
    for (const b of btns) {
      const ok = await b.evaluate((el) => {
        try {
          const rect = el.getBoundingClientRect();
          if (!rect || !rect.width || !rect.height) return false;
          if (rect.width < 40 || rect.height < 40) return false;
          const approxSquare = Math.abs(rect.width - rect.height) <= 16;
          const hasIcon = !!el.querySelector("svg");
          return approxSquare && hasIcon;
        } catch { return false; }
      });
      if (ok) circleCandidates.push(b);
    }

    const chosen = circleCandidates.length ? circleCandidates[circleCandidates.length - 1] : btns[btns.length - 1];
    if (chosen) buttons.push(chosen);
  }

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

/**
 * Fallback MUITO ROBUSTO (XPath + translate para tirar acentos):
 *  1) Espera o título aparecer no DOM (mesmo com SPA)
 *  2) Acha nós que contenham o título, sobe ao "card"
 *  3) Prioriza a seta dentro do card; se não houver, clica no card
 *  4) Último recurso: seta mais próxima do texto
 */
async function openDisciplineByTitle(page, title) {
  await page.goto(COURSE_URL, { waitUntil: "networkidle2" });

  // 1) Espera o texto (sem acento) aparecer no DOM
  const okWait = await page.waitForFunction(
    (t) => {
      const norm = s => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
      const body = document.body;
      return body && norm(body.innerText || "").includes(norm(t));
    },
    { timeout: 15000 },
    title
  ).catch(() => false);

  if (!okWait) return false;

  // 2–4) faz tudo no contexto da página com XPath/translate
  const opened = await page.evaluate((titleIn) => {
    const title = titleIn;

    // função para checar “card”
    const isBigBox = (el) => {
      const r = el.getBoundingClientRect();
      return r && r.width >= 280 && r.height >= 160;
    };
    const hasDigitalEad = (el) => {
      const t = (el.innerText || "").toLowerCase();
      return t.includes("digital (ead)") || t.includes("continue de onde parou");
    };
    const isArrowButton = (btn) => {
      try {
        const r = btn.getBoundingClientRect();
        if (!r || r.width < 36 || r.height < 36) return false;
        const approxSquare = Math.abs(r.width - r.height) <= 20;
        const hasIcon = !!btn.querySelector("svg");
        return approxSquare && hasIcon;
      } catch { return false; }
    };

    // Helpers
    const clickAndOk = (node) => {
      node.scrollIntoView({ block: "center", inline: "center" });
      node.click();
      return true;
    };

    // XPATH: translate para remover acentos (mapeamento a-z)
    const AC1 = "ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇç";
    const AC2 = "AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc";

    const xTitle = `
      //*[contains(
        translate(normalize-space(string(.)),
          '${AC1}', '${AC2}'
        ),
        translate('${title}', '${AC1}', '${AC2}')
      )]
    `;

    const result = document.evaluate(xTitle, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (!result || result.snapshotLength === 0) return false;

    // coleta candidatos (subida ao card)
    const candidates = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      let el = result.snapshotItem(i);
      // ignora nós invisíveis/zero dimensão
      const vr = el.getBoundingClientRect();
      if (!vr || (vr.width === 0 && vr.height === 0)) continue;

      let card = el;
      for (let j = 0; j < 10 && card; j++) {
        if (card.matches && (card.matches("article, section") || isBigBox(card) || hasDigitalEad(card))) break;
        card = card.parentElement;
      }
      if (!card) continue;
      candidates.push({ el, card });
    }
    if (!candidates.length) return false;

    // 3) prioriza seta do card
    for (const { card } of candidates) {
      const btns = Array.from(card.querySelectorAll("button"));
      let arrow = null;
      for (const b of btns) if (isArrowButton(b)) arrow = b;
      if (arrow) return clickAndOk(arrow);
    }

    // 3b) clica no card se não achou seta
    for (const { card } of candidates) {
      return clickAndOk(card);
    }

    // 4) último recurso: seta mais próxima do texto
    const arrows = Array.from(document.querySelectorAll("button")).filter(isArrowButton);
    if (!arrows.length) return false;

    const dist = (a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ax = ra.left + ra.width / 2, ay = ra.top + ra.height / 2;
      const bx = rb.left + rb.width / 2, by = rb.top + rb.height / 2;
      return Math.hypot(ax - bx, ay - by);
    };

    let best = null, bestD = Infinity;
    for (const { el } of candidates) {
      for (const ar of arrows) {
        const d = dist(el, ar);
        if (d < bestD) { bestD = d; best = ar; }
      }
    }
    if (best) return clickAndOk(best);

    return false;
  }, title);

  if (!opened) return false;

  // espera sair do grid / mudar URL
  const ok = await new Promise(resolve => {
    const oldUrl = page.url();
    const start = Date.now();
    const loop = async () => {
      if (page.url() !== oldUrl) return resolve(true);
      const stillOnGrid = await page.evaluate(() => {
        const t = (document.body.innerText || "").toLowerCase();
        return t.includes("minhas disciplinas") || t.includes("continue de onde parou");
      }).catch(() => false);
      if (!stillOnGrid) return resolve(true);
      if (Date.now() - start > 10000) return resolve(false);
      setTimeout(loop, 250);
    };
    loop();
  });
  return ok;
}

async function gotoHome(page) {
  await page.goto(COURSE_URL, { waitUntil: "networkidle2" });
}

async function openDisciplineByIndex(page, idx) {
  await gotoHome(page);
  const btns = await getOpenCourseButtons(page);
  if (!btns.length || idx >= btns.length) return false;
  const ok = await clickAndWaitSPA(page, btns[idx], 10000);
  return ok;
}

/* ================== Processamento de uma disciplina ================== */
async function processSingleDiscipline(page, maxItemsPerDiscipline = 5) {
  let processed = 0;
  while (processed < maxItemsPerDiscipline) {
    await clickPrimaryProgressButtons(page);

    try {
      await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(() => {}); });
    } catch {}

    await waitMinimumWatchTime(page, 15);
    await markLessonCompleted(page);

    await findAndDoModuleTests(page);

    processed += 1;

    const backBtn = await findElementByText(page, "a, button", ["voltar", "retornar"]);
    if (backBtn) {
      try { await backBtn.click(); await page.waitForTimeout(1200); } catch {}
    } else {
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

  let btns = await getOpenCourseButtons(page);
  let total = Math.min(maxDisciplines, btns.length);

  if (!total && COURSE_TITLES.length) {
    console.log("ℹ️ Nenhum botão detectado — usando fallback por TÍTULO…");
    for (const title of COURSE_TITLES) {
      console.log(`\n=== 🎯 Tentando abrir por título: ${title} ===`);
      const opened = await openDisciplineByTitle(page, title);
      if (!opened) { console.log(`↷ Não consegui abrir "${title}". Pulando…`); continue; }
      try { await processSingleDiscipline(page, 5); } catch (e) { console.warn("⚠️ Erro na disciplina:", e.message); }
      try { await gotoHome(page); } catch {}
    }
    console.log("\n✅ Varredura concluída (fallback por título).");
    return;
  }

  if (!total) {
    console.log("ℹ️ Nenhum botão de abrir disciplina encontrado no grid.");
    return;
  }

  console.log(`📦 Detectados ${btns.length} cards • Processando até ${total}.`);
  for (let i = 0; i < total; i++) {
    console.log(`\n=== 📚 Disciplina ${i + 1}/${total} ===`);
    const opened = await openDisciplineByIndex(page, i);
    if (!opened) { console.log(`↷ Clique não abriu a disciplina ${i + 1}. Pulando…`); continue; }

    try { await processSingleDiscipline(page, 5); } catch (e) { console.warn("⚠️ Erro na disciplina:", e.message); }
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
