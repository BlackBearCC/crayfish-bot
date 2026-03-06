const WebSocket = require('ws');
const crypto = require('crypto');

const TOKEN = 'qq72122219';
const ws = new WebSocket('ws://127.0.0.1:18789');
let reqId = 1;

function send(method, params) {
  ws.send(JSON.stringify({ type: 'req', id: String(reqId++), method, params }));
}

ws.on('message', (data) => {
  const f = JSON.parse(data.toString());

  if (f.event === 'connect.challenge') {
    send('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: 'gateway-client', displayName: 'OpenClaw Pet', version: '0.2.0', platform: 'win32', mode: 'ui', instanceId: crypto.randomUUID() },
      caps: ['tool-events'],
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token: TOKEN },
    });
  }

  if (f.event === 'connect.ready') {
    console.log('[connected] Testing available methods...');
    // 探测 agents 相关 RPC
    send('agents.list', {});
    send('agent.get', { agentId: 'main' });
    send('skills.list', {});
    send('skills.catalog', {});
  }

  if (f.type === 'res') {
    console.log(`[res id=${f.id}] ok=${f.ok}`);
    if (f.ok) {
      console.log(JSON.stringify(f.result, null, 2).slice(0, 500));
    } else {
      console.log('error:', f.error?.message);
    }
    if (parseInt(f.id) >= 5) { ws.close(); }
  }
});

ws.on('error', (e) => console.error(e.message));
setTimeout(() => ws.close(), 8000);
