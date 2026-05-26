import { getGeminiHeaders } from './playwright.ts';

export async function sendMessageViaApi(prompt: string): Promise<string> {
  const { headers, sessionTokens } = await getGeminiHeaders(false);
  
  if (!sessionTokens['at']) {
    throw new Error('Não foi possível encontrar o token de sessão "at" do Gemini. É necessário que o navegador esteja logado.');
  }

  // O formato exato do f.req para enviar uma mensagem:
  // f.req=[null,"[[\"PROMPT\",0,null,null,null,null,0],null,null,null,null,null,[1],0,[],[],1,0]"]
  const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const innerPayload = `[["${escapedPrompt}",0,null,null,null,null,0],null,null,null,null,null,[1],0,[],[],1,0]`;
  const fReqPayload = `[null,"${innerPayload.replace(/"/g, '\\"')}"]`;

  const body = new URLSearchParams();
  body.append('f.req', fReqPayload);
  body.append('at', sessionTokens['at']);

  const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otHzb&rt=c';

  console.log("Enviando requisição via API interna do Gemini...");
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error(`Erro na API do Gemini: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return extractGeminiResponse(text);
}

function extractGeminiResponse(text: string): string {
  try {
    // O retorno da API batchexecute é algo como:
    // )]}'
    // 
    // [["wrb.fr","otHzb","[[\"Resposta aqui\"...]]",null,null,null,"generic"]]
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.includes('wrb.fr') && line.includes('otHzb')) {
        const parsedLine = JSON.parse(line);
        // parsedLine é um array de arrays. O bloco principal está em parsedLine[0][2]
        if (Array.isArray(parsedLine) && parsedLine[0] && parsedLine[0][2]) {
          const innerStr = parsedLine[0][2];
          const innerJson = JSON.parse(innerStr);
          
          // O texto em markdown de resposta geralmente fica na posição [4][0][1][0] ou em [0][1] no formato interno
          if (innerJson[4] && innerJson[4][0] && innerJson[4][0][1] && innerJson[4][0][1][0]) {
            return innerJson[4][0][1][0];
          } else if (innerJson[0] && innerJson[0][1] && typeof innerJson[0][1] === 'string') {
             return innerJson[0][1];
          } else if (innerJson[0] && innerJson[0][2] && typeof innerJson[0][2] === 'string') {
             return innerJson[0][2];
          }
          
          return "Estrutura interna da API alterada. Extração falhou.";
        }
      }
    }
  } catch(e) {
    console.error("Erro ao analisar a resposta da API:", e);
  }
  
  // Fallback simples se o JSON parse falhar
  const match = text.match(/\["rcq\.MYSESSION.*?\[\["(.*?)"/);
  if (match && match[1]) {
      return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }

  return "Não foi possível analisar a resposta do Gemini.";
}
