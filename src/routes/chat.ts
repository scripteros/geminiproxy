import { Context } from 'hono';
import { streamText } from 'hono/streaming';
import { initPlaywright, sendMessageToGemini } from '../services/playwright.ts';
import { StreamingToolParser } from '../tools/parser.ts';

export const chatCompletions = async (c: Context) => {
  try {
    const body = await c.req.json();
    // console.log("Received chat completion request");
    
    // Make sure playwright is initialized
    await initPlaywright(true);
    
    const messages = body.messages || [];
    const isNewSession = !messages.some((m: any) => m.role === 'assistant');
    
    let finalPrompt = '';

    // Extract system prompt from messages (since clients send it in every request)
    let systemPrompt = '';
    for (const msg of messages) {
      if (msg.role === 'system') {
        let contentStr = '';
        if (Array.isArray(msg.content)) {
          contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
        } else if (typeof msg.content === 'object' && msg.content !== null) {
          contentStr = JSON.stringify(msg.content);
        } else {
          contentStr = msg.content || '';
        }
        systemPrompt += contentStr + '\n\n';
      }
    }

    // Build tools instructions
    let toolsPrompt = '';
    if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
      const formattedTools = body.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      toolsPrompt = `# TOOLS AVAILABLE
You have access to the following tools:
${toolsJson}

# TOOL CALLING FORMAT (MANDATORY)
To use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:
<tool_call>
{"name": "tool_name", "arguments": {"param_name": "value"}}
</tool_call>

EXAMPLE - Creating a file:
<tool_call>
{"name": "write", "arguments": {"filePath": "C:\\\\Users\\\\project\\\\index.html", "content": "<!DOCTYPE html>..."}}
</tool_call>

EXAMPLE - Running a command:
<tool_call>
{"name": "bash", "arguments": {"command": "npm install"}}
</tool_call>

# CRITICAL RULES - READ CAREFULLY:
1. SE UM ARQUIVO NÃO EXISTE no projeto, você DEVE usar <tool_call> com a ferramenta "write" para criá-lo.
2. SE O ARQUIVO JÁ EXISTE no projeto, você DEVE usar <tool_call> com a ferramenta "edit" para editá-lo/modificá-lo, em vez de sobrescrever o arquivo inteiro com "write" (a menos que o usuário peça explicitamente para substituir todo o conteúdo).
3. When the user asks to run a command, you MUST use <tool_call> with the "bash" tool.
4. ONLY use the <tool_call> tags for tool calling. NEVER output raw JSON without tags.
5. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.
6. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks.
7. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.
8. NEVER display code in a code block when you should be writing or editing it. USE THE TOOLS.

`;
    }

    if (isNewSession) {
      // Build full conversation history
      let prompt = '';
      
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'system') continue; // Already extracted above
        
        let contentStr = '';
        if (Array.isArray(msg.content)) {
          contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
        } else if (typeof msg.content === 'object' && msg.content !== null) {
          contentStr = JSON.stringify(msg.content);
        } else {
          contentStr = msg.content || '';
        }

        if (msg.role === 'user') {
          prompt += `User: ${contentStr}\n\n`;
        }
      }

      finalPrompt = `${systemPrompt}${toolsPrompt}\n${prompt}`;
      
      if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
        finalPrompt += `\n\nREMINDER: If you need to create or edit files, you MUST use <tool_call> tags with the appropriate tool. Do NOT just output the code as text.`;
      }
    } else {
      // If NOT a new session, only send the last message to keep it fast and avoid duplicating history in the same Gemini tab
      const latestMsg = messages[messages.length - 1];
      let contentStr = '';
      if (Array.isArray(latestMsg.content)) {
        contentStr = latestMsg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      } else if (typeof latestMsg.content === 'object' && latestMsg.content !== null) {
        contentStr = JSON.stringify(latestMsg.content);
      } else {
        contentStr = latestMsg.content || '';
      }

      let userMsg = '';
      if (latestMsg.role === 'user') {
        userMsg = contentStr;
      } else if (latestMsg.role === 'tool' || latestMsg.role === 'function') {
        userMsg = `Tool Response (${latestMsg.name || 'tool'}):\n${contentStr}`;
      } else {
        userMsg = contentStr;
      }

      finalPrompt = `${systemPrompt}${toolsPrompt}\n\nUser request:\n${userMsg}`;
      
      if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
        finalPrompt += `\n\nREMINDER: If you need to create or edit files, you MUST use <tool_call> tags with the appropriate tool. Do NOT just output the code as text.`;
      }
    }

    // console.log("=== PROMPT SENDING ===");
    // console.log(finalPrompt);
    // console.log("======================");

    // Call Gemini via UI + network interception
    const geminiResponseText = await sendMessageToGemini(finalPrompt, isNewSession);

    // console.log("=== GEMINI RESPONSE ===");
    // console.log(geminiResponseText);
    // console.log("=======================");

    if (body.stream) {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');
      
      return streamText(c, async (stream) => {
        const chunkId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const model = body.model || 'gemini-2.5-pro';
        
        // Initial choice role assistant
        await stream.writeln(`data: ${JSON.stringify({
          id: chunkId,
          object: 'chat.completion.chunk',
          created: created,
          model: model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
        })}\n`);

        const toolParser = new StreamingToolParser();
        const { text, toolCalls } = toolParser.feed(geminiResponseText);
        const flushResult = toolParser.flush();
        const finalText = (text + flushResult.text).trim();
        const allToolCalls = [...toolCalls, ...flushResult.toolCalls];

        if (allToolCalls.length > 0) {
          // Send tool calls stream chunk
          for (let idx = 0; idx < allToolCalls.length; idx++) {
            const tc = allToolCalls[idx];
            const data = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: created,
              model: model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: idx,
                      id: tc.id,
                      type: 'function',
                      function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments)
                      }
                    }]
                  },
                  finish_reason: null
                }
              ]
            };
            await stream.writeln(`data: ${JSON.stringify(data)}\n`);
          }

          // Finish tool calls
          await stream.writeln(`data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          })}\n`);
        } else {
          // Send text content stream chunk
          await stream.writeln(`data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }]
          })}\n`);

          // Finish content
          await stream.writeln(`data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n`);
        }

        await stream.writeln('data: [DONE]\n');
      });
    }

    const toolParser = new StreamingToolParser();
    const { text, toolCalls } = toolParser.feed(geminiResponseText);
    const flushResult = toolParser.flush();
    const finalText = (text + flushResult.text).trim();
    const allToolCalls = [...toolCalls, ...flushResult.toolCalls];

    const message: any = { role: 'assistant', content: allToolCalls.length ? null : finalText };
    if (allToolCalls.length) {
      message.tool_calls = allToolCalls.map((tc, idx) => ({
        index: idx,
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        }
      }));
    }

    return c.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'gemini-2.5-pro',
      choices: [
        {
          index: 0,
          message: message,
          finish_reason: allToolCalls.length ? 'tool_calls' : 'stop'
        }
      ]
    });
  } catch (error) {
    console.error("Error in chatCompletions:", error);
    return c.json({ error: { message: "Internal server error" } }, 500);
  }
};
