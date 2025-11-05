import puppeteer from "puppeteer";
import cron from "node-cron";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;
const COURSE_URL = process.env.COURSE_URL || "https://estudante.estacio.br/disciplinas";
const COOKIES_BASE64 = process.env.COOKIES_BASE64 || null;
const RUN_IMMEDIATELY = (process.env.RUN_IMMEDIATELY === "true");
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 7 * * *"; // default: every day at 07:00
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";
const HEADLESS = (process.env.HEADLESS !== "false");

if (!EMAIL || !SENHA) {
  console.warn("⚠️ ESTACIO_EMAIL e/ou ESTACIO_SENHA não definidos. Se estiver usando COOKIES_BASE64, tudo bem.");
}

// Se houver cookies base64 nas env vars, cria cookies.json localmente
if (COOKIES_BASE64) {
  try {
    const buff = Buffer.from(COOKIES_BASE64, "base64");
    fs.writeFileSync("./cookies.json", buff);
    console.log("✅ cookies.json criado a partir de COOKIES_BASE64.");
  } catch (err) {
    console.warn("⚠️ Falha ao gravar cookies a partir de COOKIES_BASE64:", err.message);
  }
}

async function ensureLoggedIn(page) {
  // tenta carregar cookies se existir arquivo
  try {
    if (fs.existsSync("./cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("./cookies.json", "utf8"));
      await page.setCookie(...cookies);
      console.log("✅ Cookies carregados de ./cookies.json");
    }
  } catch (err) {
    console.warn("⚠️ Erro ao carregar cookies:", err.message);
  }

  // vai para a página do curso e checa se já está logado
  await page.goto(COURSE_URL, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("login")) {
    console.log("✅ Sessão aparentemente autenticada (URL:", page.url(), ")");
    return;
  }

  // se chegou aqui, precisa tentar login por credenciais (se fornecidas)
  if (!EMAIL || !SENHA) {
    console.log("❗ Não há credenciais e o usuário não está autenticado. Encerrando tentativa de login.");
    return;
  }

  console.log("🔑 Tentando login por credenciais...");
  await page.goto("https://estudante.estacio.br", { waitUntil: "domcontentloaded" });

  try {
    // ajustar seletores se necessário (heurística)
    await page.waitForSelector("input[type='email'], input[name='email'], input#email", { timeout: 7000 });
    await page.type("input[type='email'], input[name='email'], input#email", EMAIL, { delay: 50 });
    await page.type("input[type='password'], input[name='password'], input[name='senha']", SENHA, { delay: 50 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(()=>{}),
      page.click("button[type='submit']")
    ]);

    // salva cookies após login se possível
    try {
      const cookies = await page.cookies();
      fs.writeFileSync("./cookies.json", JSON.stringify(cookies, null, 2));
      console.log("✅ Cookies salvos em ./cookies.json após login.");
    } catch (err) {
      console.warn("⚠️ Falha ao salvar cookies:", err.message);
    }

  } catch (err) {
    console.warn("⚠️ Login automático falhou:", err.message);
  }
}

async function waitMinimumWatchTime(page, minutes = 15) {
  const ms = minutes * 60 * 1000;
  console.log(`⏳ Aguardando ${minutes} minutos (tempo mínimo exigido)...`);
  // interação mínima periódica para evitar idle detection
  const step = 30 * 1000; // 30s
  let waited = 0;
  while (waited < ms) {
    await page.waitForTimeout(Math.min(step, ms - waited));
    // tentar um pequeno scroll
    try {
      await page.evaluate(() => { window.scrollBy(0, 100); });
    } catch {}
    waited += Math.min(step, ms - waited);
  }
}

async function markLessonCompleted(page) {
  // XPath para botões que contenham 'Concluir' ou 'Finalizar'
  const [btn] = await page.$x("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'concluir') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'finalizar')]");
  if (btn) {
    try {
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      console.log("✅ Botão 'Concluir/Finalizar' clicado.");
      return true;
    } catch (err) {
      console.warn("⚠️ Erro ao clicar no botão de concluir:", err.message);
      return false;
    }
  } else {
    console.log("⚠️ Botão de 'Concluir' não encontrado na página.");
    return false;
  }
}

async function processCourseOnce() {
  console.log("=== Início de execução: ", new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE }) , " ===");
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();

  try {
    await ensureLoggedIn(page);

    // Navega para o curso / disciplinas
    await page.goto(COURSE_URL, { waitUntil: "networkidle2" });

    // Tenta achar um link para conteúdos/aulas
    // (heurística: procurar links que contenham 'conteudos' ou 'aula' ou 'video')
    let lessonHref = null;
    try {
      const anchors = await page.$$("a");
      for (const a of anchors) {
        try {
          const href = await a.getAttribute("href");
          if (!href) continue;
          const low = href.toLowerCase();
          if (low.includes("conteudo") || low.includes("conteudos") || low.includes("aula") || low.includes("video") || low.includes("vídeo") || low.includes("conteudos")) {
            lessonHref = new URL(href, page.url()).toString();
            break;
          }
        } catch {}
      }
    } catch (err) {
      console.warn("⚠️ Erro ao buscar links de aulas:", err.message);
    }

    if (!lessonHref) {
      console.log("ℹ️ Não encontrou link óbvio de aula nesta execução. Verifique seletores e DOM.");
      await browser.close();
      return;
    }

    console.log("🔗 Abrindo aula:", lessonHref);
    await page.goto(lessonHref, { waitUntil: "networkidle2" });

    // Tenta iniciar vídeo (elemento <video> ou botão play)
    try {
      const video = await page.$("video");
      if (video) {
        await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.play().catch(()=>{}); });
        console.log("▶️ Elemento <video> encontrado e tentativa de play executada.");
      } else {
        const playBtn = await page.$x("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'play') or contains(., '▶')]");
        if (playBtn && playBtn[0]) {
          await playBtn[0].click().catch(()=>{});
          console.log("▶️ Botão Play clicado.");
        } else {
          console.log("ℹ️ Não foi possível identificar elemento de vídeo; permanecendo na página por 15 minutos.");
        }
      }
    } catch (err) {
      console.warn("⚠️ Erro ao iniciar vídeo:", err.message);
    }

    // Espera o tempo mínimo com pequenas interações
    await waitMinimumWatchTime(page, 15);

    // Tenta marcar como concluída
    await markLessonCompleted(page);

    // opcional: gerar screenshot de confirmação (útil para logs)
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const shotPath = `./screenshot_${ts}.png`;
      await page.screenshot({ path: shotPath, fullPage: false });
      console.log("📸 Screenshot gerado:", shotPath);
    } catch (err) {
      // não crítico
    }

    console.log("=== Fim de execução ===");
    await browser.close();
  } catch (err) {
    console.error("❌ Erro durante a execução:", err.message);
    try { await browser.close(); } catch {}
  }
}

// Scheduler: roda diariamente conforme CRON_SCHEDULE no timezone configurado
function startScheduler() {
  console.log(`🔁 Agendando execução diária com cron: "${CRON_SCHEDULE}" (timezone: ${TIMEZONE}).`);
  // cron.schedule(expression, fn, options)
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      await processCourseOnce();
    } catch (err) {
      console.error("❌ Execução agendada falhou:", err.message);
    }
  }, {
    timezone: TIMEZONE
  });
}

// Início
(async () => {
  if (RUN_IMMEDIATELY) {
    console.log("⚡ RUN_IMMEDIATELY=true → executando uma vez agora...");
    await processCourseOnce();
  }
  startScheduler();
})();
