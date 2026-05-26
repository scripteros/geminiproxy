/*
 * File: json.ts
 * Robust JSON parsing utilities
 */

export function robustParseJSON(str: string): any {
  let sanitized = str.trim();
  
  // Remove markdown code blocks if present
  sanitized = sanitized.replace(/^```json\s*/, '').replace(/```$/, '').trim();

  // Try to find the first '{'
  const firstBrace = sanitized.indexOf('{');
  if (firstBrace === -1) return null;

  let jsonPart = sanitized.substring(firstBrace);
  
  // Try parsing directly first
  try {
    return JSON.parse(jsonPart);
  } catch (e) {
    // Custom robust parser for JSON containing unescaped quotes/newlines
    try {
      const result: any = { name: '', arguments: {} };
      
      const nameMatch = jsonPart.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch) {
        result.name = nameMatch[1];
      }

      // Check if arguments are nested under an "arguments" key, or flat
      const hasArgumentsKey = jsonPart.includes('"arguments"');
      
      const possibleKeys = [
        'filePath', 'content', 'command', 'pattern', 'include', 'oldString', 
        'newString', 'query', 'sessionID', 'limit', 'timeout', 'workdir',
        'path', 'file'
      ];
      
      const positions: { key: string, index: number, valueStartIndex: number }[] = [];
      for (const key of possibleKeys) {
        const regex = new RegExp(`"${key}"\\s*:\\s*`, 'g');
        let match;
        while ((match = regex.exec(jsonPart)) !== null) {
          positions.push({
            key,
            index: match.index,
            valueStartIndex: match.index + match[0].length
          });
        }
      }
      
      positions.sort((a, b) => a.index - b.index);
      
      const targetArgsObj = hasArgumentsKey ? result.arguments : result;

      for (let i = 0; i < positions.length; i++) {
        const current = positions[i];
        const next = positions[i + 1];
        let rawValue = next 
          ? jsonPart.substring(current.valueStartIndex, next.index)
          : jsonPart.substring(current.valueStartIndex);
        
        rawValue = rawValue.trim();
        
        if (rawValue.startsWith('"')) {
          let val = rawValue.substring(1);
          let endTrimmed = val.trim();
          while (endTrimmed.length > 0 && (endTrimmed.endsWith('}') || endTrimmed.endsWith(']') || endTrimmed.endsWith(',') || endTrimmed.endsWith('\n') || endTrimmed.endsWith('\r'))) {
            endTrimmed = endTrimmed.slice(0, -1).trim();
          }
          if (endTrimmed.endsWith('"')) {
            endTrimmed = endTrimmed.slice(0, -1);
          }
          
          val = endTrimmed.replace(/\\(u[0-9a-fA-F]{4}|[^u])/g, (match, p1) => {
            if (p1.startsWith('u')) {
              return String.fromCharCode(parseInt(p1.substring(1), 16));
            }
            switch (p1) {
              case 'n': return '\n';
              case 'r': return '\r';
              case 't': return '\t';
              case 'b': return '\b';
              case 'f': return '\f';
              case '"': return '"';
              case '\\': return '\\';
              default: return p1;
            }
          });
          
          // Clean up markdown link representations in strings (often introduced by Gemini Web UI)
          val = val.replace(/\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, p1, p2) => {
            if (p1 === p2 || p2.includes(p1) || p1.includes(p2)) {
              return p2;
            }
            return match;
          });
          
          targetArgsObj[current.key] = val;
        } else {
          let valStr = rawValue;
          while (valStr.length > 0 && (valStr.endsWith('}') || valStr.endsWith(']') || valStr.endsWith(',') || valStr.endsWith('\n') || valStr.endsWith('\r'))) {
            valStr = valStr.slice(0, -1).trim();
          }
          if (valStr === 'true') targetArgsObj[current.key] = true;
          else if (valStr === 'false') targetArgsObj[current.key] = false;
          else if (valStr === 'null') targetArgsObj[current.key] = null;
          else {
            const num = Number(valStr);
            if (!isNaN(num)) {
              targetArgsObj[current.key] = num;
            } else {
              targetArgsObj[current.key] = valStr;
            }
          }
        }
      }
      
      if (result.name || Object.keys(result.arguments).length > 0) {
        return result;
      }
    } catch (err) {
      console.warn("[robustParseJSON] Custom regex parser failed:", err);
    }
  }

  // 1. Clean trailing noise from the end of the string
  let cleaned = jsonPart.trim();
  while (cleaned.length > 0 && !/[}\]"0-9a-z]/i.test(cleaned[cleaned.length - 1])) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  // 2. Pre-process to escape control characters in strings and count braces
  let fixedJson = '';
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  let lastBalancedIndex = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    
    if (escaped) {
      fixedJson += char;
      escaped = false;
      continue;
    }
    
    if (char === '\\') {
      fixedJson += char;
      escaped = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      fixedJson += char;
      continue;
    }
    
    if (inString) {
      // Escape literal control characters that are invalid in JSON strings
      if (char === '\n') fixedJson += '\\n';
      else if (char === '\r') fixedJson += '\\r';
      else if (char === '\t') fixedJson += '\\t';
      else if (char.charCodeAt(0) < 32) {
        fixedJson += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
      }
      else fixedJson += char;
    } else {
      fixedJson += char;
      if (char === '{') openBraces++;
      if (char === '}') openBraces--;
      if (char === '[') openBrackets++;
      if (char === ']') openBrackets--;
      
      if (openBraces === 0 && openBrackets === 0 && i > 0) {
        lastBalancedIndex = fixedJson.length - 1;
      }
    }
  }

  let tempJson = fixedJson;

  // If we found a point where it was balanced and there is trailing noise or it didn't stay balanced
  if (lastBalancedIndex !== -1 && (openBraces !== 0 || openBrackets !== 0 || fixedJson.length > lastBalancedIndex + 1)) {
    tempJson = fixedJson.substring(0, lastBalancedIndex + 1);
  } else if (openBraces > 0 || openBrackets > 0) {
    // If it never balanced, attempt to close everything that is open
    if (openBrackets > 0) tempJson += ']'.repeat(openBrackets);
    if (openBraces > 0) tempJson += '}'.repeat(openBraces);
  }

  try {
    return JSON.parse(tempJson);
  } catch (e) {
    console.error('[robustParseJSON] Failed to parse tempJson (1st attempt):', tempJson);
    console.error('[robustParseJSON] Error:', e);
    // Still fails, try one more aggressive approach: remove trailing comma before closing
    let aggressive = fixedJson.trim();
    if (aggressive.endsWith(',')) aggressive = aggressive.slice(0, -1);
    
    // Recount for the aggressive version
    let ob = 0, bk = 0, is = false, esc = false;
    let aggFixed = '';
    for (let i = 0; i < aggressive.length; i++) {
      const char = aggressive[i];
      if (esc) { aggFixed += char; esc = false; continue; }
      if (char === '\\') { aggFixed += char; esc = true; continue; }
      if (char === '"') { is = !is; aggFixed += char; continue; }
      
      if (is) {
        if (char === '\n') aggFixed += '\\n';
        else if (char === '\r') aggFixed += '\\r';
        else if (char === '\t') aggFixed += '\\t';
        else aggFixed += char;
      } else {
        aggFixed += char;
        if (char === '{') ob++;
        if (char === '}') ob--;
        if (char === '[') bk++;
        if (char === ']') bk--;
      }
    }
    
    if (bk > 0) aggFixed += ']'.repeat(bk);
    if (ob > 0) aggFixed += '}'.repeat(ob);
    
    try {
      return JSON.parse(aggFixed);
    } catch (e2) {
      console.error('[robustParseJSON] Failed to parse aggFixed (2nd attempt):', aggFixed);
      console.error('[robustParseJSON] Error:', e2);
      throw e; // Throw original error if all fixes fail
    }
  }
}
