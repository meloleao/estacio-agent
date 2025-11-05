import puppeteer from "puppeteer";

const EMAIL = process.env.ESTACIO_EMAIL;
const SENHA = process.env.ESTACIO_SENHA;

if (!EMAIL || !SENHA) {
  console.error("❌ Variáveis de ambiente ESTACIO_EMAIL e ESTACIO_SENHA não definidas.");
  process.exit(1);
}

async function iniciar() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();
  console.log("🚀 Acessando plataforma...");
  await page.goto("https://estudante.estacio.br/disciplinas", { waitUntil: "networkidle2" });

  // Login
  if (page.url().includes("login")) {
    console.log("🔑 Realizando login...");
    await page.type("input[type='email']", EMAIL);
    await page.type("input[type='password']", SENHA);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click("button[type='submit']")
    ]);
    console.log("✅ Login concluído.");
  }

  console.log("📚 Buscando cursos...");
  await page.waitForSelector("a[href*='disciplinas/estacio_']");
  const cursos = await page.$$("a[href*='disciplinas/estacio_']");
  await cursos[0].click();

  console.log("▶️ Abrindo primeira aula não concluída...");
  await page.waitForSelector("a[href*='conteudos']");
  await page.click("a[href*='conteudos']");
  console.log("⏳ Esperando 15 minutos (tempo mínimo exigido)...");
  await page.waitForTimeout(1000 * 60 * 15);

  console.log("✅ Tentando marcar aula como concluída...");
  const [botaoConcluir] = await page.$x("//button[contains(., 'Concluir') or contains(., 'Finalizar')]");
  if (botaoConcluir) {
    await botaoConcluir.click();
    console.log("✅ Aula marcada como concluída.");
  } else {
    console.log("⚠️ Botão de 'Concluir' não encontrado.");
  }

  console.log("🏁 Aula finalizada. Encerrando navegador.");
  await browser.close();
}

iniciar();
