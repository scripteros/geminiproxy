import { chromium, BrowserContext } from 'playwright';
import path from 'path';

async function login() {
  console.log('🤖 Iniciando processo de Login no Gemini...');
  console.log('Uma janela do navegador será aberta. Por favor, faça login na sua conta do Google.');
  console.log('O script aguardará até que você alcance a interface de chat do Gemini (gemini.google.com/app).');

  const profilePath = path.resolve('gemini_profile');
  
  // Open visible browser for manual login
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      headless: false, 
      channel: 'chrome', // Use real Chrome to avoid bot detection if possible
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: null
    });
  } catch (e) {
    console.log('⚠️ Google Chrome não encontrado, tentando Chromium padrão...');
    context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: null
    });
  }

  const page = await context.newPage();
  
  // Hide webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await page.goto('https://gemini.google.com/app');

  console.log('\n⏳ Aguardando você fazer login e a página do chat carregar...');
  console.log('Não feche a janela do navegador! Ela fechará sozinha quando terminar.\n');

  try {
    // Wait for the chat input area which signifies a successful login and app load
    // The exact selector might need adjustment depending on Gemini UI updates.
    await page.waitForSelector('rich-textarea, .chat-input, textarea', { timeout: 0 }); // infinite timeout
    
    console.log('✅ Login detectado com sucesso!');
    console.log('Salvando sessão...');
    
    // Give it a second to store all cookies
    await new Promise(r => setTimeout(r, 2000));
    
    console.log('🎉 Sessão salva na pasta "gemini_profile". Agora você pode rodar "npm start"!');
  } catch (err) {
    console.error('❌ Erro durante o login:', err);
  } finally {
    await context.close();
    process.exit(0);
  }
}

login();
