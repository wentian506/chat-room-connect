/**
 * Client-side smoke test: loads the real page in a simulated DOM (jsdom),
 * joins a room, and drives a full two-user conversation through the actual UI.
 *   npm i --no-save jsdom && node test/ui.js     (expects the server on port 3000)
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const PORT = process.env.PORT || 3000;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openClient(name, room, { sandboxed = false } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message || e)));
  vc.on('error', (m) => errors.push(String(m)));

  const dom = await JSDOM.fromURL(`${ORIGIN}/?room=${encodeURIComponent(room)}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.HTMLElement.prototype.scrollTo = function () { this.scrollTop = this.scrollHeight; };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.confirm = () => true;
      window.navigator.clipboard = { writeText: async () => { throw new Error('blocked'); } };
      if (sandboxed) {
        // mimic an iframe with sandbox="allow-scripts": opaque origin
        Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError: access denied'); } });
        window.history.replaceState = () => { throw new Error('SecurityError: access denied'); };
        window.confirm = () => { throw new Error('confirm() is not available'); };
      }
    },
  });

  await sleep(700);                     // let app.js boot
  const doc = dom.window.document;
  doc.getElementById('name-input').value = name;
  doc.getElementById('room-input').value = room;
  doc.getElementById('join-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(900);

  return { dom, doc, errors, window: dom.window };
}

const typeAndSend = async (client, text) => {
  const input = client.doc.getElementById('msg-input');
  input.value = text;
  input.dispatchEvent(new client.window.Event('input', { bubbles: true }));
  client.doc.getElementById('composer').dispatchEvent(new client.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(500);
};

(async () => {
  console.log('\n── client boot ──');
  const a = await openClient('Haider', 'ui-room');
  const b = await openClient('Sara', 'ui-room');

  check('chat screen becomes visible', a.doc.getElementById('chat-screen').hidden === false);
  check('join screen is hidden', a.doc.getElementById('join-screen').hidden === true);
  check('room name rendered in header + sidebar',
    a.doc.getElementById('chat-room').textContent === 'ui-room' && a.doc.getElementById('sidebar-room').textContent === 'ui-room');
  check('own name + avatar initial shown', a.doc.getElementById('me-name').textContent === 'Haider' && a.doc.getElementById('me-avatar').textContent === 'H');
  check('transport reported as realtime', /realtime/.test(a.doc.getElementById('head-transport').textContent));
  check('invite URL carries the room', a.window.location.search.includes('room=ui-room'));

  await sleep(300);
  const rows = () => [...a.doc.querySelectorAll('#member-list li .who')].map((n) => n.textContent);
  check('both members listed in sidebar', rows().includes('Haider') && rows().includes('Sara'), JSON.stringify(rows()));
  check('online counter shows 2', a.doc.getElementById('online-count').textContent === '2');
  check('own row is tagged "you"', [...a.doc.querySelectorAll('#member-list li')].some((li) => li.querySelector('.who').textContent === 'Haider' && li.querySelector('.tag')?.textContent === 'you'));
  check('join event rendered as a system line', /Sara joined the room/.test(a.doc.querySelector('#messages').textContent));

  console.log('\n── sending messages through the UI ──');
  await typeAndSend(a, 'Hello Sara 👋');
  check('sender sees own message', [...a.doc.querySelectorAll('.msg.own .bubble')].some((n) => n.textContent === 'Hello Sara 👋'));
  check('sender bubble marked as own (right side)', a.doc.querySelectorAll('.msg.own').length === 1);
  check('receiver sees the message', b.doc.querySelector('#messages').textContent.includes('Hello Sara 👋'));
  check('receiver bubble is not own', b.doc.querySelectorAll('.msg.own').length === 0);
  check('author name + timestamp rendered', /Haider/.test(b.doc.querySelector('.msg .msg-meta .author').textContent) && /\d/.test(b.doc.querySelector('.msg .time').textContent));
  check('day separator inserted', !!b.doc.querySelector('.day-sep'));
  check('composer cleared after send', a.doc.getElementById('msg-input').value === '');
  check('send button disabled on empty input', a.doc.getElementById('send-btn').disabled === true);

  console.log('\n── XSS / link safety ──');
  await typeAndSend(b, '<img src=x onerror="window.PWNED=1"> and https://example.com');
  await sleep(400);
  const injected = a.doc.querySelector('#messages img');
  check('html payload is not parsed into elements', !injected, injected ? injected.outerHTML : '');
  check('no script executed from message text', a.window.PWNED === undefined);
  const link = a.doc.querySelector('.bubble a');
  check('urls linkified safely', !!link && link.getAttribute('rel').includes('noopener') && link.target === '_blank');

  console.log('\n── grouping, emoji & counters ──');
  await typeAndSend(b, 'second message from Sara');
  await sleep(400);
  const saraRows = [...a.doc.querySelectorAll('.msg')];
  check('consecutive messages from one author are grouped', saraRows.some((r) => r.classList.contains('grouped')));
  await typeAndSend(a, '🎉');
  check('emoji-only bubble gets its own style', !!a.doc.querySelector('.bubble.emoji-only'));

  const input = a.doc.getElementById('msg-input');
  input.value = 'x'.repeat(1600);
  input.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  check('character counter appears near the limit', a.doc.getElementById('counter').hidden === false, a.doc.getElementById('counter').textContent);
  input.value = '';
  input.dispatchEvent(new a.window.Event('input', { bubbles: true }));

  console.log('\n── typing indicator ──');
  const bInput = b.doc.getElementById('msg-input');
  bInput.value = 'typing…';
  bInput.dispatchEvent(new b.window.Event('input', { bubbles: true }));
  await sleep(500);
  check('typing indicator shown to the other user', /Sara is typing/.test(a.doc.getElementById('typing-line').textContent), a.doc.getElementById('typing-line').textContent);
  await sleep(2600);
  check('typing indicator clears itself', a.doc.getElementById('typing-line').textContent.trim() === '', a.doc.getElementById('typing-line').textContent);
  bInput.value = '';
  bInput.dispatchEvent(new b.window.Event('input', { bubbles: true }));

  console.log('\n── leave ──');
  const leaveBtn = a.doc.getElementById('leave-btn');
  leaveBtn.dispatchEvent(new a.window.Event('click', { bubbles: true }));
  await sleep(200);
  check('leave asks for confirmation first', leaveBtn.textContent === 'Confirm leave?' && a.doc.getElementById('chat-screen').hidden === false, leaveBtn.textContent);
  leaveBtn.dispatchEvent(new a.window.Event('click', { bubbles: true }));
  await sleep(700);
  check('leaving returns to the join screen', a.doc.getElementById('join-screen').hidden === false && a.doc.getElementById('chat-screen').hidden === true);
  check('remaining member is told about the departure', /Haider left/.test(b.doc.querySelector('#messages').textContent));
  const bRows = [...b.doc.querySelectorAll('#member-list li .who')].map((n) => n.textContent);
  check('remaining member\'s list drops the leaver', bRows.length === 1 && bRows[0] === 'Sara' && b.doc.getElementById('online-count').textContent === '1', JSON.stringify(bRows));

  console.log('\n── invite link ──');
  b.doc.getElementById('share-btn').dispatchEvent(new b.window.Event('click', { bubbles: true }));
  await sleep(300);
  const panel = b.doc.getElementById('invite-panel');
  const inviteVal = b.doc.getElementById('invite-input').value;
  check('invite panel opens with a room link', panel.hidden === false && inviteVal.includes('room=ui-room'), inviteVal);
  check('fallback copy instructions shown when clipboard is blocked',
    /Copy the link below/.test(b.doc.getElementById('invite-hint').textContent), b.doc.getElementById('invite-hint').textContent);
  b.doc.getElementById('invite-close').dispatchEvent(new b.window.Event('click', { bubbles: true }));
  await sleep(150);
  check('invite panel closes', b.doc.getElementById('invite-panel').hidden === true);

  console.log('\n── sandboxed iframe resilience ──');
  const sandboxed = await openClient('Sandy', 'sandbox-room', { sandboxed: true });
  check('app still boots when localStorage/history throw', sandboxed.doc.getElementById('chat-screen').hidden === false);
  check('no localStorage crash leaked to console', sandboxed.errors.filter((e) => !/Could not parse CSS|jsdom/i.test(e)).length === 0,
    sandboxed.errors.slice(0, 2).join(' | '));
  await typeAndSend(sandboxed, 'still works in a sandbox');
  check('sandboxed client can send messages', sandboxed.doc.querySelectorAll('.msg.own').length === 1);

  console.log('\n── console health ──');
  const noisy = [...a.errors, ...b.errors].filter((e) => !/Could not parse CSS|jsdom/i.test(e));
  check('no uncaught client errors', noisy.length === 0, noisy.slice(0, 3).join(' | '));

  a.dom.window.close();
  b.dom.window.close();
  sandboxed.dom.window.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('ui test crashed:', err); process.exit(1); });
