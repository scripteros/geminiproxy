import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Mutex para evitar interações concorrentes na UI
class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const uiMutex = new Mutex();

export async function initPlaywright(headless = false) {
  if (context) return;
  const profilePath = path.resolve('gemini_profile');
  
  // console.log(`[Playwright] Lançando Chrome (headless=${headless})...`);

  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  activePage = await context.newPage();
  // console.log('[Playwright] Browser pronto.');
}

/**
 * Envia uma mensagem para o Gemini via automação de UI
 * e captura a resposta interceptando as respostas de rede (batchexecute).
 * Isso evita a necessidade de tokens internos e é muito mais confiável
 * do que tentar raspar o DOM.
 */
export async function sendMessageToGemini(prompt: string, isNewSession = false, model?: string): Promise<string> {
  const release = await uiMutex.acquire();
  try {
    return await _sendMessageInternal(prompt, isNewSession, model);
  } finally {
    release();
  }
}

async function _sendMessageInternal(prompt: string, isNewSession = false, model?: string): Promise<string> {
  if (!activePage) {
    throw new Error('Playwright not initialized');
  }

  const currentUrl = activePage.url();
  const isOnGemini = currentUrl.includes('gemini.google.com');
  const isChatUrl = currentUrl.includes('/app/chat/');

  if (!isOnGemini || (isNewSession && isChatUrl)) {
    // console.log('[Gemini] Iniciando nova conversa no Gemini...');
    await activePage.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
  }

  const inputSelector = 'rich-textarea, .chat-input, textarea';
  // console.log('[Gemini] Esperando campo de texto...');
  await activePage.waitForSelector(inputSelector, { timeout: 30000 });
  await sleep(1500);

  // Vamos capturar a requisição POST real do batchexecute
  let interceptedRequest: any = null;
  let requestResolve: (req: any) => void;
  const requestPromise = new Promise<any>(resolve => {
    requestResolve = resolve;
  });

  let clickInitiated = false;

  const onRequest = async (route: any) => {
    try {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      if ((url.includes('batchexecute') || url.includes('/data/')) && method === 'POST') {
        const postData = req.postData() || '';
        let decoded = postData;
        try { decoded = decodeURIComponent(postData); } catch(e) {}
        // console.log(`[Interceptor] POST request to ${url.substring(0, 80)} | clickInitiated=${clickInitiated} | hasHook=${decoded.includes('PROXY_HOOK')}`);
      }

      if (!clickInitiated) {
        await route.continue();
        return;
      }

      if ((url.includes('batchexecute') || url.includes('/data/')) && method === 'POST') {
        const postData = req.postData();
        if (postData) {
          let decoded = postData;
          try { decoded = decodeURIComponent(postData); } catch(e) {}
          
          if (decoded.includes('PROXY_HOOK')) {
            // console.log('[Gemini] Requisição de envio interceptada com sucesso! Abortando...');
            interceptedRequest = {
              url: req.url(),
              headers: req.headers(),
              postData: req.postData() // Guardamos a original para enviar depois
            };
            await route.abort(); // Cancela o envio! Não aparece na UI
            requestResolve(interceptedRequest);
            return;
          }
        }
      }
      await route.continue();
    } catch(e) {
      console.error('[Gemini] Erro no interceptor:', e);
      try { await route.continue(); } catch(e2) {}
    }
  };

  // Habilita interceptação
  await activePage.route('**/*', onRequest);

  // --- Digita e envia a mensagem FALSA ---
  // console.log('[Gemini] Preparando requisição invisível...');
  
  const isImageMode = model && model.includes('imagen');
  if (isImageMode) {
    try {
      const imageMenuSelector = 'mat-list-item:has(mat-icon[data-mat-icon-name="image_create"])';
      const imageBtn = activePage.locator(imageMenuSelector).first();
      // Try to force click it. If the menu is hidden, it might still register, or we might need to click the '+' button first.
      // We will do a force click.
      await imageBtn.click({ force: true, timeout: 2000 });
      await sleep(1000);
    } catch (e) {
      // Ignora erro se não encontrar, pois pode já estar ativado ou a interface mudou.
    }
  }

  await activePage.focus(inputSelector);
  await activePage.keyboard.press('Control+A');
  await activePage.keyboard.press('Backspace');
  await sleep(200);
  
  // Digitamos um texto falso bem específico para interceptar
  await activePage.keyboard.type('PROXY_HOOK');
  await sleep(200);

  // Clica no botão de enviar
  clickInitiated = true;
  const sendSelectors = [
    'button[aria-label="Send message"]',
    'button[aria-label="Enviar mensagem"]',
    'button.send-button',
    'rich-textarea ~ button:has(svg)'
  ];

  let clicked = false;
  for (const sel of sendSelectors) {
    try {
      const btn = activePage.locator(sel).locator('visible=true').first();
      const count = await btn.count();
      if (count > 0) {
        const isDisabled = await btn.getAttribute('disabled');
        const ariaDisabled = await btn.getAttribute('aria-disabled');
        if (isDisabled === null && ariaDisabled !== 'true') {
          await btn.click({ force: true });
          clicked = true;
          // console.log(`[Gemini] Botão de envio clicado via seletor: ${sel}`);
          break;
        }
      }
    } catch(e) {}
  }
  
  if (!clicked) {
    // console.log('[Gemini] Nenhum botão de envio encontrado. Tentando Enter...');
    await activePage.keyboard.press('Enter');
  }

  // Aguarda a interceptação
  // console.log('[Gemini] Aguardando captura da requisição...');
  const reqData = await Promise.race([
    requestPromise,
    sleep(15000).then(() => null)
  ]);

  // Remove a interceptação
  await activePage.unroute('**/*', onRequest);

  if (!reqData) {
    // Se não pegou, talvez tenhamos que limpar o campo
    await activePage.keyboard.press('Control+A');
    await activePage.keyboard.press('Backspace');
    throw new Error('Timeout esperando captura da requisição.');
  }

  // Limpa o campo de texto para a próxima (já que cancelamos o envio, o texto fica lá)
  await activePage.focus(inputSelector);
  await activePage.keyboard.press('Control+A');
  await activePage.keyboard.press('Backspace');

  // --- Modifica e envia a requisição via API Node ---
  // console.log('[Gemini] Enviando requisição real via API invisível...');
  
  // Pegamos os cookies do navegador atualizados
  const cookies = await activePage.context().cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(reqData.headers)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.startsWith(':') || 
      lowerKey === 'content-length' || 
      lowerKey === 'host'
    ) {
      continue;
    }
    headers[key] = value as string;
  }
  
  headers['cookie'] = cookieStr;

  // Prepara o corpo substituindo o PROXY_HOOK pelo prompt real de forma totalmente segura via JSON parse/stringify
  let newBody = reqData.postData;
  try {
    const params = new URLSearchParams(reqData.postData);
    const fReqStr = params.get('f.req');
    if (fReqStr) {
      const fReq = JSON.parse(fReqStr);
      if (Array.isArray(fReq) && fReq[1]) {
        const innerPayload = JSON.parse(fReq[1]);
        
        const replaceProxyHook = (obj: any): any => {
          if (typeof obj === 'string') {
            if (obj.includes('PROXY_HOOK')) {
              return obj.replace(/PROXY_HOOK/g, prompt);
            }
            return obj;
          }
          if (Array.isArray(obj)) {
            return obj.map(replaceProxyHook);
          }
          if (obj && typeof obj === 'object') {
            const newObj: any = {};
            for (const [k, v] of Object.entries(obj)) {
              newObj[k] = replaceProxyHook(v);
            }
            return newObj;
          }
          return obj;
        };

        fReq[1] = JSON.stringify(replaceProxyHook(innerPayload));
        params.set('f.req', JSON.stringify(fReq));
        newBody = params.toString();
      }
    }
  } catch (e) {
    console.error('[Gemini] Erro ao processar f.req JSON:', e);
    newBody = newBody.replace('PROXY_HOOK', encodeURIComponent(prompt));
  }

  const response = await fetch(reqData.url, {
    method: 'POST',
    headers: headers,
    body: newBody
  });

  if (!response.ok) {
    let errBody = '';
    try { errBody = await response.text(); } catch(e) {}
    console.error(`[Gemini] Erro na requisição. Status: ${response.status} ${response.statusText}. Corpo:`, errBody);
    throw new Error(`Erro na API do Gemini: ${response.status} ${response.statusText}`);
  }

  const responseText = await response.text();
  
  // Extrai a resposta da API do Google (mesma lógica dos chunks)
  // console.log(`[Gemini] Resposta recebida da API (${responseText.length} chars)`);
  
  // Always save raw response for debug
  try {
     fs.writeFileSync('gemini_api_debug.txt', responseText);
  } catch(e) {}

  // Check for Gemini API errors (e.g., BardErrorInfo)
  if (responseText.includes('BardErrorInfo') || responseText.includes('type.googleapis.com/assistant.boq.bard')) {
    console.error('[Gemini] API retornou erro (BardErrorInfo). Tentando com nova sessão...');
    
    // Navigate to a fresh session and retry
    if (activePage) {
      await activePage.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
      await sleep(2000);
    }
    
    // Retry once with a fresh session (recursive call with isNewSession=true)
    if (!isNewSession) {
      // console.log('[Gemini] Reenviando com nova sessão...');
      return _sendMessageInternal(prompt, true);
    }
    
    return "Erro: O Gemini retornou um erro interno. Tente novamente.";
  }

  const extracted = extractResponseFromChunks([responseText]);
  if (extracted) {
    return extracted;
  }

  // console.log('[Gemini] Falha ao extrair do texto bruto. Salvando debug...');
  
  return "Erro: Formato de resposta não reconhecido. Verifique os logs.";
}

/**
 * Tenta extrair a resposta do Gemini a partir dos chunks de rede capturados.
 * Estrutura real do Gemini (descoberta via análise):
 * - Cada chunk contém linhas separadas por \n
 * - Linhas JSON começam com [["wrb.fr", rpcId, "<inner_json>", ...]]
 * - A resposta está no inner JSON na posição [4][0][1][0]
 * - O rpcId da resposta é null (não tem nome de RPC)
 */
function extractResponseFromChunks(chunks: string[]): string | null {
  let bestResponse: string | null = null;
  
  for (const chunk of chunks) {
    if (chunk.length < 100) continue;
    
    const lines = chunk.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === ")]}'") continue;
      // Skip lines that are just numbers (byte counts in streaming)
      if (/^\d+$/.test(trimmed)) continue;
      
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch(e) {
        continue;
      }
      
      if (!Array.isArray(parsed)) continue;
      
      for (const entry of parsed) {
        if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
        if (typeof entry[2] !== 'string') continue;
        
        let inner: any;
        try {
          inner = JSON.parse(entry[2]);
        } catch(e) {
          continue;
        }
        
        if (!Array.isArray(inner)) continue;
        
        // Pattern: inner[4][0][1][0] - response content from streaming chunks
        // The response is streamed in multiple chunks, each with a more complete version.
        // We want the LAST one (most complete).
        try {
          if (inner[4] && Array.isArray(inner[4]) && inner[4][0]) {
            const responseBlock = inner[4][0];
            if (Array.isArray(responseBlock) && responseBlock[1] && Array.isArray(responseBlock[1])) {
              const text = responseBlock[1][0];
              if (typeof text === 'string' && text.length > 0) {
                // Always keep the latest (most complete) response
                bestResponse = text;
              }
            }
          }
        } catch(e) {}
        
        // Fallback for direct text structure
        try {
          if (inner[0] && Array.isArray(inner[0])) {
            for (const item of inner[0]) {
              if (Array.isArray(item) && item[0] === 'main_text' && typeof item[1] === 'string') {
                bestResponse = item[1];
              }
            }
          }
        } catch(e) {}

        // Pattern: inner[22][0][0][0][1][2] - alternate response field
        try {
          if (inner[22] && Array.isArray(inner[22])) {
            const text = inner[22][0]?.[0]?.[0]?.[1]?.[2];
            if (typeof text === 'string' && text.length > 0) {
              bestResponse = text;
            }
          }
        } catch(e) {}
        
        // NOTE: inner[2]["11"] contains the CONVERSATION TITLE, not the response.
        // Do NOT extract from there!
      }
    }
  }
  
  // Clean markdown-formatted URLs that Gemini web UI auto-generates
  // e.g., [https://cdn.tailwindcss.com](https://cdn.tailwindcss.com) → https://cdn.tailwindcss.com
  if (bestResponse) {
    bestResponse = bestResponse.replace(/\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, text, url) => {
      // If text and URL are the same (or very similar), just use the URL
      if (text === url || url.includes(text) || text.includes(url)) {
        return url;
      }
      return match; // Keep actual markdown links with different text/url
    });
  }
  
  return bestResponse;
}

/**
 * Fallback: extrai a resposta diretamente do DOM do Gemini.
 */
async function extractResponseFromDOM(page: Page): Promise<string> {
  const response = await page.evaluate(() => {
    // Tenta vários seletores conhecidos da interface do Gemini
    const selectors = [
      'message-content',           // Web component customizado
      '.model-response-text',      // Classe de resposta
      '.message-content',          // Classe alternativa
      '.response-container',       // Container de resposta
      'ui-markdown',               // Componente de markdown
      '.markdown',                 // Classe markdown genérica
      '.gmat-body-1',              // Material Design body text
    ];
    
    let lastMessage: HTMLElement | null = null;
    
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      if (elements.length > 0) {
        lastMessage = elements[elements.length - 1] as HTMLElement;
        break;
      }
    }
    
    if (lastMessage) {
      return lastMessage.innerText || lastMessage.textContent || 'Mensagem vazia';
    }
    
    // Último fallback: pega o último bloco de texto grande na página
    const allText = document.body.innerText;
    const blocks = allText.split('\n\n').filter(b => b.trim().length > 20);
    if (blocks.length > 0) {
      return blocks[blocks.length - 1].trim();
    }
    
    return 'Não foi possível extrair a resposta do DOM.';
  });

  return response.trim();
}
