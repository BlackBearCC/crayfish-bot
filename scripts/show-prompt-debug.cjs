const fs = require('fs');
const path = require('path');

const logPath = path.join(process.env.USERPROFILE, '.petclaw', 'logs', 'prompt-debug.jsonl');
const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l.trim());
const e = JSON.parse(lines[lines.length - 1]);

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text).join('');
  return '';
}

// Strip Telegram metadata envelope, keep only actual user text
function stripMeta(text) {
  // Remove leading System: lines
  text = text.replace(/^(System:[^\n]*\n+)+/, '');
  // Remove Conversation info block
  text = text.replace(/^Conversation info \(untrusted metadata\):\n```json[\s\S]*?```\n\n/, '');
  // Remove Sender block
  text = text.replace(/^Sender \(untrusted metadata\):\n```json[\s\S]*?```\n\n/, '');
  // Remove Forwarded block
  text = text.replace(/^Forwarded message context \(untrusted metadata\):\n```json[\s\S]*?```\n\n/, '');
  // Remove timestamp prefix like "[Wed 2026-03-11 22:25 GMT+8] "
  text = text.replace(/^\[[^\]]+\] /, '');
  return text.trim();
}

const msgs = e.messages;
console.log('=== 总消息数:', msgs.length, ' | 时间:', e.ts, ' | model:', e.model, '===\n');

const userAssistant = [];
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  const role = m.role;
  if (role !== 'user' && role !== 'assistant') continue;

  let text = extractText(m.content);
  if (role === 'user') text = stripMeta(text);
  text = text.trim();

  if (!text) continue;
  userAssistant.push({ idx: i + 1, role, text });
}

console.log('=== 去除元数据后 user/assistant 消息数:', userAssistant.length, '===\n');
userAssistant.forEach(m => {
  console.log('[' + m.idx + '] ' + m.role + ':');
  console.log(m.text.slice(0, 400));
  if (m.text.length > 400) console.log('...(截断 ' + (m.text.length - 400) + ' 字符)');
  console.log('---');
});
