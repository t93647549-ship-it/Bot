'use strict';

// ─── Load .env ───────────────────────────────────────────────────────────────
const _fs0  = require('fs');
const _path0 = require('path');
const _envPath = _path0.resolve(__dirname, '.env');
if (_fs0.existsSync(_envPath)) {
  _fs0.readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=\s][^=\s]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
}

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

// ─── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '8347282173:AAHR0AU6gVuSXbKgDriUMcJqayFNIVPliPs';
const ADMIN_ID   = process.env.ADMIN_ID
  ? Number(process.env.ADMIN_ID)
  : process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : 8281900951;

const CHECK_CONCURRENCY = Math.max(1, Number(process.env.CHECK_CONCURRENCY || 20));
const CHECK_DELAY_MS    = Math.max(0, Number(process.env.CHECK_DELAY_MS    || 0));
const SESSIONS_DIR      = path.resolve(process.env.SESSIONS_DIR || path.join(__dirname, 'sessions'));
const BATCH_SIZE        = 500;

if (!BOT_TOKEN) { console.error('❌  BOT_TOKEN is required.'); process.exit(1); }
if (!ADMIN_ID || Number.isNaN(ADMIN_ID)) { console.error('❌  ADMIN_ID is required.'); process.exit(1); }
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function isAdmin(id) { return Number(id) === ADMIN_ID; }
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── State ───────────────────────────────────────────────────────────────────
const userStates      = new Map();
const userFilePending = new Map();

// ─── Banned Users ─────────────────────────────────────────────────────────────
const BANNED_FILE = path.join(__dirname, 'banned.json');
const bannedUsers = new Set(
  fs.existsSync(BANNED_FILE) ? JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8')) : []
);
function saveBanned() { fs.writeFileSync(BANNED_FILE, JSON.stringify([...bannedUsers])); }
function banUser(id)   { bannedUsers.add(Number(id));    saveBanned(); }
function unbanUser(id) { bannedUsers.delete(Number(id)); saveBanned(); }
function isBanned(id)  { return bannedUsers.has(Number(id)); }

// ─── Invite Codes ─────────────────────────────────────────────────────────────
const CODES_FILE = path.join(__dirname, 'codes.json');
const AUTH_FILE  = path.join(__dirname, 'auth.json');
let inviteCodes    = fs.existsSync(CODES_FILE) ? JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')) : {};
const authorizedUsers = new Set(
  fs.existsSync(AUTH_FILE) ? JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) : []
);
function saveCodes() { fs.writeFileSync(CODES_FILE, JSON.stringify(inviteCodes, null, 2)); }
function saveAuth()  { fs.writeFileSync(AUTH_FILE,  JSON.stringify([...authorizedUsers])); }

// ─── Protection Toggle ────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = fs.existsSync(SETTINGS_FILE)
  ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  : { protectionEnabled: true };
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
function isProtected()  { return settings.protectionEnabled; }
function toggleProtection() { settings.protectionEnabled = !settings.protectionEnabled; saveSettings(); return settings.protectionEnabled; }

function isAuthorized(id) { return isAdmin(id) || !isProtected() || authorizedUsers.has(Number(id)); }
function authorizeUser(id) { authorizedUsers.add(Number(id)); saveAuth(); }
function revokeUser(id)    { authorizedUsers.delete(Number(id)); saveAuth(); }
function generateCode(maxUses = 1, note = '') {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  inviteCodes[code] = { maxUses, uses: 0, note, createdAt: Date.now() };
  saveCodes();
  return code;
}
function useCode(code, userId) {
  const c = inviteCodes[code?.toUpperCase()];
  if (!c) return 'invalid';
  if (c.maxUses > 0 && c.uses >= c.maxUses) return 'expired';
  c.uses++;
  if (c.maxUses > 0 && c.uses >= c.maxUses) { delete inviteCodes[code.toUpperCase()]; }
  saveCodes();
  authorizeUser(userId);
  return 'ok';
}
function deleteCode(code) { delete inviteCodes[code?.toUpperCase()]; saveCodes(); }

// ─── Share Keys (Shared Session Codes) ───────────────────────────────────────
// shareKeys: { CODE: { ownerUserId, maxUses, uses, note, createdAt } }
const SHARE_FILE = path.join(__dirname, 'share_keys.json');
let shareKeys = fs.existsSync(SHARE_FILE) ? JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')) : {};
function saveShareKeys() { fs.writeFileSync(SHARE_FILE, JSON.stringify(shareKeys, null, 2)); }
function generateShareKey(ownerUserId, maxUses = 0, note = '') {
  const code = 'S-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  shareKeys[code] = { ownerUserId: Number(ownerUserId), maxUses, uses: 0, note, createdAt: Date.now() };
  saveShareKeys();
  return code;
}
function getShareKey(code) { return shareKeys[code?.toUpperCase()] || null; }
function useShareKey(code) {
  const k = shareKeys[code?.toUpperCase()];
  if (!k) return false;
  if (k.maxUses > 0 && k.uses >= k.maxUses) return false;
  k.uses++;
  saveShareKeys();
  return true;
}
function deleteShareKey(code) { delete shareKeys[code?.toUpperCase()]; saveShareKeys(); }

// userShareMap: userId → ownerUserId (which session to borrow)
const USER_SHARE_MAP_FILE = path.join(__dirname, 'user_share_map.json');
let userShareMap = fs.existsSync(USER_SHARE_MAP_FILE)
  ? JSON.parse(fs.readFileSync(USER_SHARE_MAP_FILE, 'utf8'))
  : {};
function saveUserShareMap() { fs.writeFileSync(USER_SHARE_MAP_FILE, JSON.stringify(userShareMap, null, 2)); }
function setUserShareOwner(userId, ownerUserId) { userShareMap[String(userId)] = Number(ownerUserId); saveUserShareMap(); }
function getUserShareOwner(userId) { return userShareMap[String(userId)] || null; }
function getUserSharedSock(userId) {
  const ownerId = getUserShareOwner(userId);
  if (!ownerId) return null;
  const ownerState = userStates.get(Number(ownerId));
  if (!ownerState || ownerState.status !== 'ready' || !ownerState.sock) return null;
  return ownerState;
}

function getState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      sock: null, status: 'disconnected', method: null, screen: 'main',
      pairingRequested: false, pairingCode: null,
      chatId: null, info: null, connectedAt: null, authenticatedAt: null,
      lastDisconnectReason: null, lastError: null, userId,
      checks: { totalChecked: 0, registered: 0, unregistered: 0, errors: 0 },
    });
  }
  return userStates.get(userId);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function cleanNumber(raw) { return String(raw || '').replace(/\D+/g, ''); }
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function hasSavedSession(userId) {
  return fs.existsSync(path.join(SESSIONS_DIR, `session-${userId}`, 'creds.json'));
}
function statusLabel(st) {
  switch (st.status) {
    case 'ready':           return '✅ مربوط وجاهز';
    case 'connecting':      return '⏳ جاري الاتصال...';
    case 'qr_pending':      return '📷 بانتظار مسح QR';
    case 'pairing_pending': return '📱 بانتظار رمز الربط';
    default:                return '❌ غير مربوط';
  }
}
function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = [];
  if (d) p.push(`${d}ي`); if (h) p.push(`${h}س`);
  if (m) p.push(`${m}د`); if (!d && !h) p.push(`${s % 60}ث`);
  return p.join(' ');
}
function formatDateTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('ar-EG', { timeZone: 'Asia/Riyadh' }); }
  catch (_) { return new Date(ts).toISOString(); }
}
function chunkLines(lines, maxLen = 3800) {
  const chunks = []; let buf = '';
  for (const line of lines) {
    const next = buf ? buf + '\n' + line : line;
    if (next.length > maxLen) { if (buf) chunks.push(buf); buf = line; } else buf = next;
  }
  if (buf) chunks.push(buf);
  return chunks;
}
function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => resolve(Buffer.concat(ch).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Country Codes & Grouping ─────────────────────────────────────────────────
const COUNTRY_CODES = new Set([
  '1','7','20','27','30','31','32','33','34','36','39',
  '40','41','43','44','45','46','47','48','49',
  '51','52','53','54','55','56','57','58',
  '60','61','62','63','64','65','66',
  '81','82','84','86','90','91','92','93','94','95','98',
  '211','212','213','216','218','220','221','222','223','224','225','226','227','228','229',
  '230','231','232','233','234','235','236','237','238','239',
  '240','241','242','243','244','245','246','247','248','249',
  '250','251','252','253','254','255','256','257','258',
  '260','261','262','263','264','265','266','267','268','269',
  '290','291','297','298','299',
  '350','351','352','353','354','355','356','357','358','359',
  '370','371','372','373','374','375','376','377','378','379',
  '380','381','382','383','385','386','387','389',
  '420','421','423','500','501','502','503','504','505','506','507','508','509',
  '590','591','592','593','594','595','596','597','598','599',
  '670','672','673','674','675','676','677','678','679',
  '680','681','682','683','685','686','687','688','689','690','691','692',
  '850','852','853','855','856','870','880','886',
  '960','961','962','963','964','965','966','967','968',
  '970','971','972','973','974','975','976','977',
  '992','993','994','995','996','998',
]);
function stripCountryCode(n) {
  for (let l = 3; l >= 1; l--) {
    if (COUNTRY_CODES.has(n.slice(0, l))) return n.slice(l);
  }
  return n;
}
function groupByPrefix(numbers) {
  const groups = {};
  for (const n of numbers) {
    const p = stripCountryCode(n).slice(0, 2);
    if (!groups[p]) groups[p] = [];
    groups[p].push(n);
  }
  return groups;
}
function groupBySubPrefix(numbers) {
  const groups = {};
  for (const n of numbers) {
    const p = stripCountryCode(n).slice(0, 3);
    if (!groups[p]) groups[p] = [];
    groups[p].push(n);
  }
  return groups;
}

// ─── Session Destroy ──────────────────────────────────────────────────────────
async function destroyClient(state) {
  const sock = state.sock;
  state.sock = null; state.status = 'disconnected'; state.pairingRequested = false;
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { await Promise.race([sock.end(new Error('destroy')), new Promise(r => setTimeout(r, 2000))]); } catch (_) {}
  }
}

// ─── Keyboards ────────────────────────────────────────────────────────────────
function mainMenuKeyboard(userId) {
  const rows = [
    [
      { text: '🔗 ربط الحساب',    callback_data: 'menu_link' },
      { text: '♻️ استعادة الجلسة', callback_data: 'menu_restore' },
    ],
    [
      { text: '🔢 فحص الأرقام', callback_data: 'menu_check' },
      { text: '📊 الحالة',       callback_data: 'menu_status' },
    ],
    [{ text: '❓ مساعدة', callback_data: 'menu_help' }],
  ];
  if (isAdmin(userId)) {
    rows.push([{ text: '📢 رسالة جماعية', callback_data: 'menu_broadcast' }]);
    rows.push([
      { text: '👥 المستخدمون', callback_data: 'menu_users' },
      { text: '🎟️ أكواد الدعوة', callback_data: 'menu_codes' },
    ]);
    rows.push([
      { text: isProtected() ? '🔓 تعطيل الحماية' : '🔒 تفعيل الحماية', callback_data: 'admin_toggle_protect' },
      { text: '🚪 تسجيل خروج', callback_data: 'menu_logout' },
    ]);
  }
  return { inline_keyboard: rows };
}
function linkMenuKeyboard() {
  return { inline_keyboard: [
    [{ text: '📷 QR كود', callback_data: 'link_qr' }, { text: '📱 رقم الهاتف', callback_data: 'link_phone' }],
    [{ text: '🔙 رجوع', callback_data: 'back_main' }],
  ]};
}
function backKeyboard() {
  return { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'back_main' }]] };
}
function statusKeyboard(state) {
  const row1 = [{ text: '🔄 تحديث', callback_data: 'menu_status' }];
  if (state.status === 'ready') row1.push({ text: '🔢 فحص', callback_data: 'menu_check' });
  else row1.push({ text: '🔗 ربط', callback_data: 'menu_link' });
  const rows = [row1];
  if (isAdmin(state.userId)) rows.push([
    { text: '👥 المستخدمون', callback_data: 'menu_users' },
    { text: '🚪 خروج', callback_data: 'menu_logout' },
  ]);
  rows.push([{ text: '🔙 رجوع', callback_data: 'back_main' }]);
  return { inline_keyboard: rows };
}
function afterCheckKeyboard(userId, totalChecked, hasPending) {
  const rows = [];
  if (hasPending) rows.push([{ text: `↩️ رجوع للقائمة (فحصت: ${totalChecked})`, callback_data: 'menu_file_list' }]);
  rows.push([
    { text: totalChecked > 0 ? `🔢 فحص أخرى (${totalChecked})` : '🔢 فحص أخرى', callback_data: 'menu_check' },
    { text: '📊 الحالة', callback_data: 'menu_status' },
  ]);
  rows.push([{ text: '🏠 الرئيسية', callback_data: 'back_main' }]);
  return { inline_keyboard: rows };
}
function buildPrefixMarkup(parentGroups, checked) {
  const btns = Object.keys(parentGroups).sort().map(p => {
    const total = parentGroups[p].length;
    const done  = Object.entries(checked).filter(([k]) => k.startsWith(p)).reduce((s, [,v]) => s + v.size, 0);
    const icon  = done >= total ? '✅' : done > 0 ? '🔄' : '📞';
    return { text: `${icon} ${p} (${total})`, callback_data: `pfx:${p}` };
  });
  const rows = [];
  for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
  rows.push([{ text: '🔙 رجوع', callback_data: 'back_main' }]);
  return { inline_keyboard: rows };
}
function buildSubPrefixMarkup(parentPrefix, subGroups, checked) {
  const btns = Object.keys(subGroups).filter(p => p.startsWith(parentPrefix)).sort().map(p => {
    const done = checked[p] ? checked[p].size : 0;
    const rem  = subGroups[p].length - done;
    const icon = rem === 0 ? '✅' : done > 0 ? '🔄' : '🔢';
    return { text: `${icon} ${p} (${rem})`, callback_data: `subpfx:${p}` };
  });
  const rows = [];
  for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
  rows.push([{ text: '↩️ رجوع للبادئات', callback_data: 'menu_file_list' }]);
  return { inline_keyboard: rows };
}

// ─── Screens ─────────────────────────────────────────────────────────────────
async function showMain(chatId, state) {
  if (!isAuthorized(state.userId)) { await promptInviteCode(chatId, state); return; }
  state.screen = 'main';
  await bot.sendMessage(chatId, `👋 <b>القائمة الرئيسية</b>\n\nالحالة: ${statusLabel(state)}`,
    { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(state.userId) });
}
async function showLinkMenu(chatId, state) {
  state.screen = 'link';
  await bot.sendMessage(chatId, '🔗 اختر طريقة الربط:', { reply_markup: linkMenuKeyboard() });
}
async function showStatus(chatId, state) {
  state.screen = 'status';
  const lines = [`📊 <b>حالة الجلسة</b>`, '', `• الحالة: ${statusLabel(state)}`];
  lines.push(`• طريقة الربط: ${
    state.method === 'qr' ? 'QR كود' :
    state.method === 'phone' ? 'رقم الهاتف' :
    state.method === 'restore' ? 'استعادة محفوظة' :
    state.method === 'borrowed' ? '🔌 مستعارة' : '—'
  }`);
  if (state.info) {
    lines.push('', `👤 <b>معلومات الحساب</b>`);
    lines.push(`• الاسم: ${escapeHtml(state.info.name || '—')}`);
    lines.push(`• الرقم: <code>${escapeHtml(state.info.phone || '—')}</code>`);
  }
  if (state.connectedAt) {
    lines.push('', `⏱ <b>التوقيت</b>`);
    lines.push(`• الجاهزية: ${escapeHtml(formatDateTime(state.connectedAt))}`);
    lines.push(`• مدة الاتصال: ${escapeHtml(formatDuration(Date.now() - state.connectedAt))}`);
  }
  const c = state.checks;
  if (c?.totalChecked > 0) {
    lines.push('', `📈 <b>إحصائيات الفحص</b>`);
    lines.push(`• إجمالي: ${c.totalChecked} | ✅ ${c.registered} | ❌ ${c.unregistered} | ⚠️ ${c.errors}`);
  }
  if (state.status === 'pairing_pending' && state.pairingCode)
    lines.push('', `🔑 رمز الربط: <code>${escapeHtml(state.pairingCode)}</code>`);
  if (state.lastError) lines.push(`⚠️ آخر خطأ: ${escapeHtml(String(state.lastError))}`);
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup: statusKeyboard(state) });
}
async function showHelp(chatId, state) {
  state.screen = 'help';
  await bot.sendMessage(chatId,
    '📖 <b>طريقة الاستخدام</b>\n\n' +
    '1) اضغط «🔗 ربط الحساب» واختر QR أو رقم الهاتف.\n' +
    '2) بعد الربط أرسل ملف .txt/.csv مباشرة.\n' +
    '3) كل ضغطة = 100 رقم عشوائي من البادئة المختارة.\n' +
    '4) النتائج: ✅ المسجلة أولًا ثم ❌ غير المسجلة.\n\n' +
    '• «♻️ استعادة الجلسة» تُعيد الاتصال بجلسة محفوظة.' +
    (isAdmin(state.userId) ? '\n• 👥 «المستخدمون» — إدارة الجلسات.' : ''),
    { parse_mode: 'HTML', reply_markup: backKeyboard() });
}
async function promptCheck(chatId, state) {
  if (isBanned(state.userId)) {
    await bot.sendMessage(chatId, '🚫 أنت محظور من استخدام الفحص. تواصل مع الأدمن.');
    return;
  }
  if (state.status !== 'ready') {
    await bot.sendMessage(chatId, `⚠️ يجب الربط أولًا.\nالحالة: ${statusLabel(state)}`,
      { reply_markup: mainMenuKeyboard(state.userId) });
    return;
  }
  state.screen = 'awaiting_numbers';
  const total = state.checks.totalChecked;
  await bot.sendMessage(chatId,
    `📥 أرسل قائمة الأرقام أو ملف .txt/.csv الآن.\n(حتى ${BATCH_SIZE} رقم/رسالة)` +
    (total > 0 ? `\n📊 تم فحص <b>${total}</b> رقم في هذه الجلسة.` : ''),
    { parse_mode: 'HTML', reply_markup: backKeyboard() });
}
async function promptPhone(chatId, state) {
  state.screen = 'awaiting_phone';
  await bot.sendMessage(chatId,
    '📱 أرسل رقم هاتفك مع رمز الدولة بدون + (مثال: 9677xxxxxxxx)',
    { reply_markup: backKeyboard() });
}

// ─── Admin ────────────────────────────────────────────────────────────────────
async function showAdminUsers(chatId) {
  const active = [...userStates.entries()].filter(([, s]) => s.sock || s.status === 'ready');
  if (active.length === 0) {
    await bot.sendMessage(chatId, '👥 لا يوجد مستخدمون مرتبطون حاليًا.', { reply_markup: backKeyboard() });
    return;
  }
  const lines = [`👥 <b>المستخدمون المرتبطون (${active.length})</b>\n`];
  const rows = [];
  for (const [uid, s] of active) {
    const banned = isBanned(uid);
    lines.push(`• <code>${uid}</code> — ${escapeHtml(s.info?.name || '—')} | 📞 ${s.info?.phone || '—'} | ${statusLabel(s)}${banned ? ' | 🚫 محظور' : ''}`);
    rows.push([
      { text: `👤 ${s.info?.name || uid}`, callback_data: `admin_info_${uid}` },
      { text: '✉️ مراسلة', callback_data: `admin_dm_${uid}` },
      { text: '🔌 استخدام', callback_data: `admin_use_${uid}` },
    ]);
    rows.push([
      { text: '🚪 طرد', callback_data: `admin_kick_${uid}` },
      { text: banned ? '✅ رفع حظر' : '🚫 حظر', callback_data: banned ? `admin_unban_${uid}` : `admin_ban_${uid}` },
      { text: '🔑 كود مشاركة', callback_data: `admin_sharekey_${uid}` },
    ]);
  }
  rows.push([{ text: '🔙 رجوع', callback_data: 'back_main' }]);
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}
async function showAdminCodes(chatId) {
  const codes = Object.entries(inviteCodes);
  const auth  = authorizedUsers.size;
  const lines = [`🎟️ <b>إدارة أكواد الدعوة</b>\n`, `👤 المصرّح لهم: <b>${auth}</b> مستخدم\n`];
  const rows  = [];
  if (codes.length === 0) {
    lines.push('لا توجد أكواد نشطة.');
  } else {
    for (const [code, c] of codes) {
      const usedOf = c.maxUses > 0 ? `${c.uses}/${c.maxUses}` : `${c.uses}/∞`;
      lines.push(`🔑 <code>${code}</code> — استخدم: ${usedOf}${c.note ? ' — ' + escapeHtml(c.note) : ''}`);
      rows.push([
        { text: `🔑 ${code} (${usedOf})`, callback_data: `code_info_${code}` },
        { text: '🗑️ حذف', callback_data: `code_del_${code}` },
      ]);
    }
  }
  rows.push([
    { text: '➕ كود لمرة واحدة', callback_data: 'code_gen_1' },
    { text: '➕ كود غير محدود', callback_data: 'code_gen_0' },
  ]);
  rows.push([{ text: '👥 المصرّح لهم', callback_data: 'code_authlist' }, { text: '🔙 رجوع', callback_data: 'back_main' }]);
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}
async function showAuthList(chatId) {
  if (authorizedUsers.size === 0) {
    await bot.sendMessage(chatId, '👤 لا يوجد مستخدمون مصرّح لهم.', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'menu_codes' }]] } });
    return;
  }
  const lines = [`👥 <b>المصرّح لهم (${authorizedUsers.size})</b>\n`];
  const rows  = [];
  for (const uid of authorizedUsers) {
    const s = userStates.get(uid);
    lines.push(`• <code>${uid}</code>${s?.info?.name ? ' — ' + escapeHtml(s.info.name) : ''}`);
    rows.push([
      { text: `🆔 ${uid}`, callback_data: `code_info_uid_${uid}` },
      { text: '🚫 سحب الصلاحية', callback_data: `code_revoke_${uid}` },
    ]);
  }
  rows.push([{ text: '🔙 رجوع', callback_data: 'menu_codes' }]);
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}
async function promptInviteCode(chatId, state) {
  state.screen = 'awaiting_invite_code';
  await bot.sendMessage(chatId,
    '🎟️ <b>البوت محمي بكود دعوة</b>\n\nأرسل كود الدعوة الخاص بك للمتابعة:',
    { parse_mode: 'HTML' });
}
async function adminKickUser(chatId, targetUserId) {
  const state = userStates.get(Number(targetUserId));
  if (!state) { await bot.sendMessage(chatId, '⚠️ المستخدم غير موجود.'); return; }
  const name = state.info?.name || targetUserId;
  await destroyClient(state);
  if (state.chatId) {
    try { await bot.sendMessage(state.chatId, '⚠️ تم إنهاء جلستك من قِبَل الأدمن.', { reply_markup: mainMenuKeyboard(Number(targetUserId)) }); } catch (_) {}
  }
  await bot.sendMessage(chatId, `✅ تم طرد ${escapeHtml(String(name))}.`, { reply_markup: backKeyboard() });
}

// ─── WhatsApp via Baileys ─────────────────────────────────────────────────────
async function startSession(userId, chatId, method, phoneNumber) {
  const state = getState(userId);
  state.userId = userId;
  await destroyClient(state);

  state.method = method; state.status = 'connecting';
  state.pairingRequested = false; state.pairingCode = null;
  state.chatId = chatId; state.lastError = null;

  try {
    const sessionPath = path.join(SESSIONS_DIR, `session-${userId}`);

    // عند ربط جديد (phone أو qr) — احذف الجلسة القديمة لتجنب خطأ "تسجيل الخروج"
    if (method === 'phone' || method === 'qr') {
      try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (_) {}
    }

    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    });

    state.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // ── QR or Pairing Code ──
      if (qr) {
        if (method === 'qr') {
          state.status = 'qr_pending';
          try {
            const buf = await qrcode.toBuffer(qr, { width: 512, margin: 1 });
            await bot.sendPhoto(chatId, buf, {
              caption: '📲 افتح واتساب › الأجهزة المرتبطة › ربط جهاز، ثم امسح هذا الكود.',
              reply_markup: backKeyboard(),
            });
          } catch (e) {
            await bot.sendMessage(chatId, `⚠️ تعذر إرسال QR: ${e.message}`);
          }
        } else if (method === 'phone' && phoneNumber && !state.pairingRequested) {
          state.pairingRequested = true;
          state.status = 'pairing_pending';
          try {
            const code   = await sock.requestPairingCode(phoneNumber);
            const pretty = code?.length === 8 ? `${code.slice(0,4)}-${code.slice(4)}` : code;
            state.pairingCode = pretty;
            await bot.sendMessage(chatId,
              `🔑 <b>رمز ربط الجهاز</b>\n\n` +
              `افتح واتساب › الأجهزة المرتبطة › ربط جهاز › ربط برقم الهاتف:\n\n` +
              `<code>${escapeHtml(pretty)}</code>\n\n⌛ صالح لمدة 60 ثانية.`,
              {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: `📋 نسخ الرمز: ${pretty}`, copy_text: { text: pretty } }],
                    [{ text: '🔙 رجوع', callback_data: 'back_main' }],
                  ],
                },
              });
          } catch (e) {
            state.pairingRequested = false;
            state.lastError = e.message;
            await bot.sendMessage(chatId, `⚠️ فشل توليد رمز التحقق: ${e.message}`, { reply_markup: backKeyboard() });
          }
        }
      }

      // ── Connected ──
      if (connection === 'open') {
        state.status = 'ready';
        state.connectedAt = Date.now();
        state.authenticatedAt = state.authenticatedAt || Date.now();
        state.pairingCode = null;
        try {
          const me = sock.user;
          state.info = {
            name:  me?.name || me?.verifiedName || '—',
            phone: (me?.id || '').split(':')[0].split('@')[0] || '—',
          };
        } catch (_) {}

        const info = state.info;
        await bot.sendMessage(chatId,
          `✅ <b>تم الربط بنجاح</b> ${escapeHtml(info?.name || '')} ${info?.phone ? '— ' + info.phone : ''}\n\nأرسل ملفًا أو اضغط «🔢 فحص الأرقام».`,
          { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(userId) });

        if (!isAdmin(userId) && ADMIN_ID) {
          try {
            await bot.sendMessage(ADMIN_ID,
              `🔔 <b>مستخدم جديد ربط جلسة</b>\n\n` +
              `🆔 Telegram ID: <code>${userId}</code>\n` +
              `👤 الاسم: ${escapeHtml(info?.name || '—')}\n` +
              `📞 الرقم: <code>${info?.phone || '—'}</code>\n` +
              `📅 وقت الربط: ${escapeHtml(formatDateTime(Date.now()))}`,
              {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[
                  { text: '🔌 استخدام جلسته', callback_data: `admin_use_${userId}` },
                  { text: '🚪 طرد', callback_data: `admin_kick_${userId}` },
                ]]},
              });
          } catch (_) {}
        }
      }

      // ── Disconnected ──
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut  = statusCode === DisconnectReason.loggedOut;
        state.lastDisconnectReason = String(lastDisconnect?.error?.message || statusCode || 'unknown');

        if (!loggedOut && state.sock === sock) {
          state.status = 'connecting';
          setTimeout(() => startSession(userId, chatId, 'restore', null).catch(() => {}), 3000);
        } else {
          state.status = 'disconnected'; state.sock = null;
          await bot.sendMessage(chatId,
            loggedOut ? '⚠️ تم تسجيل الخروج من واتساب.' : `⚠️ انقطع الاتصال: ${state.lastDisconnectReason}`,
            { reply_markup: mainMenuKeyboard(userId) });
        }
      }
    });

  } catch (e) {
    state.status = 'disconnected'; state.sock = null; state.lastError = e.message;
    await bot.sendMessage(chatId, `⚠️ تعذر بدء الجلسة: ${e.message}`, { reply_markup: backKeyboard() });
  }
}

async function restoreSession(userId, chatId) {
  const state = getState(userId);
  state.userId = userId;
  if (state.status === 'ready') {
    await bot.sendMessage(chatId, '✅ الجلسة نشطة بالفعل.', { reply_markup: mainMenuKeyboard(userId) });
    return;
  }
  if (!hasSavedSession(userId)) {
    await bot.sendMessage(chatId, '⚠️ لا توجد جلسة محفوظة. استخدم «🔗 ربط الحساب».', { reply_markup: mainMenuKeyboard(userId) });
    return;
  }
  const msg = await bot.sendMessage(chatId, '♻️ جاري استعادة الجلسة المحفوظة...');
  await startSession(userId, chatId, 'restore', null);
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
}

async function handleLogout(userId, chatId) {
  const state = getState(userId);
  await bot.sendMessage(chatId, '🚪 جاري تسجيل الخروج...');
  if (state.sock) { try { await state.sock.logout(); } catch (_) {} }
  await destroyClient(state);
  try { fs.rmSync(path.join(SESSIONS_DIR, `session-${userId}`), { recursive: true, force: true }); } catch (_) {}
  state.info = null; state.connectedAt = null; state.authenticatedAt = null;
  state.method = null; state.lastError = null; state.lastDisconnectReason = null;
  state.checks = { totalChecked: 0, registered: 0, unregistered: 0, errors: 0 };
  await bot.sendMessage(chatId, '✅ تم تسجيل الخروج وحذف الجلسة.', { reply_markup: mainMenuKeyboard(userId) });
}

// ─── Parsing ──────────────────────────────────────────────────────────────────
function parseNumbers(text) {
  const tokens = text.split(/[\s,;\r\n]+/).filter(Boolean);
  const numbers = []; const seen = new Set();
  for (const t of tokens) {
    const n = cleanNumber(t);
    if (n.length >= 7 && !seen.has(n)) { seen.add(n); numbers.push(n); }
  }
  return numbers;
}
async function fetchFileNumbers(fileId) {
  const link    = await bot.getFileLink(fileId);
  const content = await downloadUrl(link);
  return parseNumbers(content);
}

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/^\/start\b/,   async msg => { const s = getState(msg.from.id); s.userId = msg.from.id; await showMain(msg.chat.id, s); });
bot.onText(/^\/help\b/,    async msg => { const s = getState(msg.from.id); s.userId = msg.from.id; await showHelp(msg.chat.id, s); });
bot.onText(/^\/link\b/,    async msg => { const s = getState(msg.from.id); s.userId = msg.from.id; if (!isAuthorized(s.userId)) { await promptInviteCode(msg.chat.id, s); return; } await showLinkMenu(msg.chat.id, s); });
bot.onText(/^\/check\b/,   async msg => { const s = getState(msg.from.id); s.userId = msg.from.id; if (!isAuthorized(s.userId)) { await promptInviteCode(msg.chat.id, s); return; } await promptCheck(msg.chat.id, s); });
bot.onText(/^\/status\b/,  async msg => { const s = getState(msg.from.id); s.userId = msg.from.id; if (!isAuthorized(s.userId)) { await promptInviteCode(msg.chat.id, s); return; } await showStatus(msg.chat.id, s); });
bot.onText(/^\/restore\b/, async msg => { const s = getState(msg.from.id); s.userId = msg.from.id; if (!isAuthorized(s.userId)) { await promptInviteCode(msg.chat.id, s); return; } await restoreSession(msg.from.id, msg.chat.id); });
bot.onText(/^\/logout\b/,  async msg => {
  if (!isAdmin(msg.from.id)) { await bot.sendMessage(msg.chat.id, '⛔ للأدمن فقط.'); return; }
  await handleLogout(msg.from.id, msg.chat.id);
});
bot.onText(/^\/users\b/, async msg => {
  if (!isAdmin(msg.from.id)) { await bot.sendMessage(msg.chat.id, '⛔ للأدمن فقط.'); return; }
  await showAdminUsers(msg.chat.id);
});
bot.onText(/^\/codes\b/, async msg => {
  if (!isAdmin(msg.from.id)) { await bot.sendMessage(msg.chat.id, '⛔ للأدمن فقط.'); return; }
  await showAdminCodes(msg.chat.id);
});
bot.onText(/^\/gencode\b(.*)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) { await bot.sendMessage(msg.chat.id, '⛔ للأدمن فقط.'); return; }
  const arg = (match[1] || '').trim();
  const parts = arg.split(' ');
  const maxUses = parseInt(parts[0]) || 1;
  const note = parts.slice(1).join(' ');
  const code = generateCode(maxUses, note);
  const label = maxUses === 0 ? 'غير محدود' : `${maxUses} استخدام`;
  await bot.sendMessage(msg.chat.id,
    `✅ <b>كود دعوة جديد</b>\n\n🔑 الكود: <code>${code}</code>\n📊 الاستخدامات: ${label}${note ? '\n📝 ملاحظة: ' + escapeHtml(note) : ''}`,
    { parse_mode: 'HTML' });
});

bot.onText(/^\/broadcast\b/, async msg => {
  if (!isAdmin(msg.from.id)) { await bot.sendMessage(msg.chat.id, '⛔ للأدمن فقط.'); return; }
  const state = getState(msg.from.id);
  state.screen = 'awaiting_broadcast';
  await bot.sendMessage(msg.chat.id,
    '📢 <b>رسالة جماعية</b>\n\nاكتب الرسالة التي تريد إرسالها لجميع المستخدمين:',
    { parse_mode: 'HTML', reply_markup: backKeyboard() });
});

async function sendBroadcast(chatId, text) {
  const allUsers = [...userStates.entries()];
  const targets = allUsers.filter(([uid]) => Number(uid) !== ADMIN_ID);
  if (targets.length === 0) {
    await bot.sendMessage(chatId, '⚠️ لا يوجد مستخدمون حالياً.');
    return;
  }
  const progress = await bot.sendMessage(chatId, `📤 جاري الإرسال لـ ${targets.length} مستخدم...`);
  let success = 0, failed = 0;
  for (const [uid, s] of targets) {
    try {
      const dest = s.chatId || Number(uid);
      await bot.sendMessage(dest,
        `📢 <b>رسالة من الأدمن</b>\n\n${escapeHtml(text)}`,
        { parse_mode: 'HTML' });
      success++;
    } catch (_) { failed++; }
  }
  await bot.editMessageText(
    `✅ <b>تم الإرسال</b>\n\n• وصلت: ${success}\n• فشلت: ${failed}`,
    { chat_id: chatId, message_id: progress.message_id, parse_mode: 'HTML' }
  ).catch(async () => {
    await bot.sendMessage(chatId, `✅ وصلت: ${success} | فشلت: ${failed}`);
  });
}

// ─── Callbacks ────────────────────────────────────────────────────────────────
bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const state  = getState(userId);
  state.userId = userId;
  try {
    await bot.answerCallbackQuery(q.id).catch(() => {});

    // Auth gate for callbacks — block unauthorized users from all actions
    if (!isAuthorized(userId)) {
      await promptInviteCode(chatId, state);
      return;
    }

    if (q.data.startsWith('cpn:')) {
      const num = q.data.slice(4);
      await bot.sendMessage(chatId, `<code>${num}</code>`, { parse_mode: 'HTML' });
      return;
    }

    if (q.data.startsWith('admin_kick_')) {
      if (!isAdmin(userId)) return;
      await adminKickUser(chatId, q.data.replace('admin_kick_', ''));
      return;
    }
    if (q.data.startsWith('admin_sharekey_')) {
      if (!isAdmin(userId)) return;
      const ownerId = Number(q.data.replace('admin_sharekey_', ''));
      const ownerState = userStates.get(ownerId);
      if (!ownerState || ownerState.status !== 'ready' || !ownerState.sock) {
        await bot.sendMessage(chatId, '⚠️ هذا المستخدم غير مرتبط حالياً — لا يمكن إنشاء كود مشاركة.'); return;
      }
      const code = generateShareKey(ownerId, 0, '');
      const ownerName = ownerState.info?.name || String(ownerId);
      await bot.sendMessage(chatId,
        `🔑 <b>كود فحص مشترك</b>\n\n` +
        `الكود: <code>${code}</code>\n` +
        `مرتبط بجلسة: <b>${escapeHtml(ownerName)}</b>\n` +
        `الاستخدامات: غير محدودة\n\n` +
        `أرسل هذا الكود للمستخدم — سيفحص عبر جلسة <b>${escapeHtml(ownerName)}</b> بدون ربط.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [{ text: '🗑️ حذف الكود', callback_data: `sharekey_del_${code}` }],
          [{ text: '🔙 رجوع', callback_data: 'menu_users' }],
        ]}});
      return;
    }

    if (q.data.startsWith('sharekey_del_')) {
      if (!isAdmin(userId)) return;
      const code = q.data.replace('sharekey_del_', '');
      deleteShareKey(code);
      await bot.sendMessage(chatId, `🗑️ تم حذف كود المشاركة <code>${code}</code>.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'menu_users' }]] }});
      return;
    }

    if (q.data === 'admin_toggle_protect') {
      if (!isAdmin(userId)) return;
      const now = toggleProtection();
      await bot.sendMessage(chatId,
        now
          ? '🔒 <b>الحماية مفعّلة</b>\nالمستخدمون الجدد يحتاجون كود دعوة للدخول.'
          : '🔓 <b>الحماية معطّلة</b>\nالجميع يستطيع استخدام البوت بدون كود.',
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(userId) });
      return;
    }

    if (q.data.startsWith('admin_dm_')) {
      if (!isAdmin(userId)) return;
      const tid = q.data.replace('admin_dm_', '');
      const ts  = userStates.get(Number(tid));
      const name = ts?.info?.name || tid;
      state.screen = `awaiting_dm_${tid}`;
      await bot.sendMessage(chatId,
        `✉️ <b>مراسلة ${escapeHtml(name)}</b>\n\nأرسل الرسالة التي تريد إيصالها له:`,
        { parse_mode: 'HTML', reply_markup: backKeyboard() });
      return;
    }

    if (q.data.startsWith('code_del_')) {
      if (!isAdmin(userId)) return;
      const code = q.data.replace('code_del_', '');
      deleteCode(code);
      await bot.sendMessage(chatId, `🗑️ تم حذف الكود <code>${code}</code>.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'menu_codes' }]] } });
      return;
    }
    if (q.data.startsWith('code_revoke_')) {
      if (!isAdmin(userId)) return;
      const tid = Number(q.data.replace('code_revoke_', ''));
      revokeUser(tid);
      const ts = userStates.get(tid);
      if (ts?.chatId) {
        try { await bot.sendMessage(ts.chatId, '⚠️ تم سحب صلاحيتك من البوت. تواصل مع الأدمن.'); } catch (_) {}
      }
      await bot.sendMessage(chatId, `✅ تم سحب صلاحية المستخدم <code>${tid}</code>.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'code_authlist' }]] } });
      return;
    }
    if (q.data.startsWith('admin_ban_')) {
      if (!isAdmin(userId)) return;
      const tid = Number(q.data.replace('admin_ban_', ''));
      banUser(tid);
      const ts = userStates.get(tid);
      if (ts?.chatId) {
        try { await bot.sendMessage(ts.chatId, '🚫 تم حظرك من استخدام بوت الفحص. تواصل مع الأدمن لرفع الحظر.'); } catch (_) {}
      }
      await bot.sendMessage(chatId, `🚫 تم حظر المستخدم <code>${tid}</code> من الفحص.`, { parse_mode: 'HTML', reply_markup: backKeyboard() });
      return;
    }
    if (q.data.startsWith('admin_unban_')) {
      if (!isAdmin(userId)) return;
      const tid = Number(q.data.replace('admin_unban_', ''));
      unbanUser(tid);
      const ts = userStates.get(tid);
      if (ts?.chatId) {
        try { await bot.sendMessage(ts.chatId, '✅ تم رفع الحظر عنك. يمكنك الآن استخدام الفحص.'); } catch (_) {}
      }
      await bot.sendMessage(chatId, `✅ تم رفع الحظر عن المستخدم <code>${tid}</code>.`, { parse_mode: 'HTML', reply_markup: backKeyboard() });
      return;
    }
    if (q.data.startsWith('admin_info_')) {
      if (!isAdmin(userId)) return;
      const tid = Number(q.data.replace('admin_info_', ''));
      const ts  = userStates.get(tid);
      if (!ts) { await bot.sendMessage(chatId, '⚠️ لا يوجد بيانات.'); return; }
      await bot.sendMessage(chatId,
        `👤 <b>معلومات المستخدم</b>\n• ID: <code>${tid}</code>\n• الاسم: ${escapeHtml(ts.info?.name || '—')}\n• الرقم: <code>${ts.info?.phone || '—'}</code>\n• الحالة: ${statusLabel(ts)}\n• فحص: ${ts.checks.totalChecked} (✅${ts.checks.registered} ❌${ts.checks.unregistered})`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [{ text: '🔌 استخدام', callback_data: `admin_use_${tid}` }, { text: '🚪 طرد', callback_data: `admin_kick_${tid}` }],
          [{ text: '🔙 رجوع', callback_data: 'menu_users' }],
        ]}});
      return;
    }
    if (q.data.startsWith('admin_use_')) {
      if (!isAdmin(userId)) return;
      const tid = Number(q.data.replace('admin_use_', ''));
      const ts  = userStates.get(tid);
      if (!ts || ts.status !== 'ready' || !ts.sock) {
        await bot.sendMessage(chatId, '⚠️ جلسة هذا المستخدم غير جاهزة.');
        return;
      }
      state.sock = ts.sock; state.status = 'ready';
      state.info = ts.info; state.method = 'borrowed'; state.chatId = chatId;
      await bot.sendMessage(chatId,
        `🔌 <b>تم ربط جلسة المستخدم</b>\n👤 ${escapeHtml(ts.info?.name || String(tid))} | 📞 ${ts.info?.phone || '—'}\n\nأرسل ملفًا أو اضغط «🔢 فحص الأرقام».`,
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(userId) });
      return;
    }

    if (q.data.startsWith('pfx:')) {
      const parent  = q.data.slice(4);
      const pending = userFilePending.get(userId);
      if (!pending?.parentGroups[parent]) {
        await bot.answerCallbackQuery(q.id, { text: '⚠️ انتهت صلاحية الاختيار. أرسل الملف مجددًا.', show_alert: true });
        return;
      }
      const total = pending.parentGroups[parent].length;
      const done  = Object.entries(pending.checked).filter(([k]) => k.startsWith(parent)).reduce((s,[,v]) => s + v.size, 0);
      await bot.sendMessage(chatId,
        `📞 <b>بادئة ${parent}</b> | إجمالي: ${total} | ✅ تم: ${done}\n\n👇 اختر بادئة فرعية:`,
        { parse_mode: 'HTML', reply_markup: buildSubPrefixMarkup(parent, pending.subGroups, pending.checked) });
      return;
    }

    if (q.data.startsWith('subpfx:')) {
      const prefix  = q.data.slice(7);
      const parent  = prefix.slice(0, 2);
      const pending = userFilePending.get(userId);
      if (!pending?.subGroups[prefix]) {
        await bot.answerCallbackQuery(q.id, { text: '⚠️ انتهت صلاحية الاختيار.', show_alert: true });
        return;
      }
      const subEffective = pending.effectiveState
        || ((state.status === 'ready' && state.sock) ? state : getUserSharedSock(userId));
      if (!subEffective) {
        await bot.answerCallbackQuery(q.id, { text: '⚠️ الجلسة غير مربوطة.', show_alert: true });
        return;
      }
      if (!pending.checked[prefix]) pending.checked[prefix] = new Set();
      const checkedSet = pending.checked[prefix];
      const remaining  = pending.subGroups[prefix].filter(n => !checkedSet.has(n));
      if (remaining.length === 0) {
        await bot.answerCallbackQuery(q.id, { text: '✅ تم فحص جميع أرقام هذه البادئة!', show_alert: true });
        return;
      }
      const picked   = shuffle(remaining).slice(0, 100);
      for (const n of picked) checkedSet.add(n);
      const leftAfter = remaining.length - picked.length;
      const totalDone = Object.values(pending.checked).reduce((s, st) => s + st.size, 0);
      await bot.sendMessage(chatId, `🎲 بادئة <b>${prefix}</b> | 📦 ${picked.length} رقم | 🔁 متبقٍ: ${leftAfter}`, { parse_mode: 'HTML' });
      await checkNumbers(subEffective, chatId, picked, userId);
      const afterRows = [];
      if (leftAfter > 0) afterRows.push([{ text: `🔁 جولة جديدة من ${prefix} (${leftAfter} متبقٍ)`, callback_data: `subpfx:${prefix}` }]);
      afterRows.push([{ text: `↩️ رجوع لـ ${parent}`, callback_data: `pfx:${parent}` }]);
      afterRows.push([{ text: `📋 قائمة البادئات (${totalDone})`, callback_data: 'menu_file_list' }]);
      afterRows.push([{ text: '🏠 الرئيسية', callback_data: 'back_main' }]);
      await bot.sendMessage(chatId, '▸ اختر الإجراء التالي:', { reply_markup: { inline_keyboard: afterRows } });
      return;
    }

    switch (q.data) {
      case 'back_main':    await showMain(chatId, state); break;
      case 'menu_link':    await showLinkMenu(chatId, state); break;
      case 'menu_status':  await showStatus(chatId, state); break;
      case 'menu_check':   await promptCheck(chatId, state); break;
      case 'menu_help':    await showHelp(chatId, state); break;
      case 'menu_restore': await restoreSession(userId, chatId); break;
      case 'menu_file_list': {
        const fp = userFilePending.get(userId);
        if (!fp) { await bot.sendMessage(chatId, '⚠️ لا يوجد ملف محمّل.'); break; }
        const done = Object.values(fp.checked).reduce((s, st) => s + st.size, 0);
        await bot.sendMessage(chatId, `${fp.menuText}\n\n✅ تم فحص: <b>${done}</b> رقم حتى الآن`,
          { parse_mode: 'HTML', reply_markup: buildPrefixMarkup(fp.parentGroups, fp.checked) });
        break;
      }
      case 'menu_broadcast':
        if (!isAdmin(userId)) { await bot.sendMessage(chatId, '⛔ للأدمن فقط.'); break; }
        state.screen = 'awaiting_broadcast';
        await bot.sendMessage(chatId,
          '📢 <b>رسالة جماعية</b>\n\nاكتب الرسالة التي تريد إرسالها لجميع المستخدمين:',
          { parse_mode: 'HTML', reply_markup: backKeyboard() });
        break;
      case 'menu_users':
        if (!isAdmin(userId)) { await bot.sendMessage(chatId, '⛔ للأدمن فقط.'); break; }
        await showAdminUsers(chatId); break;
      case 'menu_codes':
        if (!isAdmin(userId)) { await bot.sendMessage(chatId, '⛔ للأدمن فقط.'); break; }
        await showAdminCodes(chatId); break;
      case 'code_authlist':
        if (!isAdmin(userId)) break;
        await showAuthList(chatId); break;
      case 'code_gen_1': {
        if (!isAdmin(userId)) break;
        const c = generateCode(1, '');
        await bot.sendMessage(chatId,
          `✅ <b>كود جديد (لمرة واحدة)</b>\n\n<code>${c}</code>\n\nشاركه مع المستخدم.`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع للأكواد', callback_data: 'menu_codes' }]] } });
        break;
      }
      case 'code_gen_0': {
        if (!isAdmin(userId)) break;
        const c = generateCode(0, '');
        await bot.sendMessage(chatId,
          `✅ <b>كود غير محدود الاستخدام</b>\n\n<code>${c}</code>\n\nيمكن استخدامه عدة مرات.`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع للأكواد', callback_data: 'menu_codes' }]] } });
        break;
      }
      case 'menu_logout':
        if (!isAdmin(userId)) { await bot.sendMessage(chatId, '⛔ للأدمن فقط.'); break; }
        await handleLogout(userId, chatId); break;
      case 'link_qr':
        await bot.sendMessage(chatId, '⏳ جاري الاتصال بواتساب...');
        await startSession(userId, chatId, 'qr'); break;
      case 'link_phone':
        await promptPhone(chatId, state); break;
    }
  } catch (e) {
    try { await bot.answerCallbackQuery(q.id, { text: 'خطأ: ' + e.message }); } catch (_) {}
  }
});

// ─── Messages ────────────────────────────────────────────────────────────────
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state  = getState(userId);
  state.userId = userId;
  state.chatId = chatId;

  // Auth gate — unauthorized users can ONLY enter their invite code
  if (!isAuthorized(userId)) {
    const isCmd     = msg.text && msg.text.startsWith('/');
    const isText    = msg.text && !isCmd;
    const awaiting  = state.screen === 'awaiting_invite_code';
    if (isText && awaiting) {
      // fall through to the invite code handler below
    } else if (isCmd) {
      // commands handled by onText handlers (which call showMain with auth check)
      return;
    } else {
      // documents or non-code text → ask for code
      await promptInviteCode(chatId, state);
      return;
    }
  }

  if (msg.document) {
    if (isBanned(userId)) {
      await bot.sendMessage(chatId, '🚫 أنت محظور من استخدام الفحص. تواصل مع الأدمن.');
      return;
    }
    const docEffectiveState = (state.status === 'ready' && state.sock)
      ? state
      : getUserSharedSock(userId);
    if (!docEffectiveState) {
      await bot.sendMessage(chatId, `⚠️ يجب الربط أولًا أو الحصول على كود مشاركة جلسة.`, { reply_markup: mainMenuKeyboard(userId) });
      return;
    }
    const { file_name: name = '', mime_type: mime = '', file_size: size = 0 } = msg.document;
    if (!mime.includes('text') && !name.endsWith('.txt') && !name.endsWith('.csv')) {
      await bot.sendMessage(chatId, '⚠️ يُقبل ملفات النص فقط (.txt أو .csv).');
      return;
    }
    if (size > 5 * 1024 * 1024) { await bot.sendMessage(chatId, '⚠️ الملف كبير جدًا (5 MB حد أقصى).'); return; }
    try {
      const pm = await bot.sendMessage(chatId, '⏳ جاري قراءة الملف...');
      const numbers = await fetchFileNumbers(msg.document.file_id);
      if (numbers.length === 0) {
        await bot.editMessageText('⚠️ لم أجد أرقامًا صالحة.', { chat_id: chatId, message_id: pm.message_id }).catch(() => {});
        return;
      }
      const parentGroups = groupByPrefix(numbers);
      const subGroups    = groupBySubPrefix(numbers);
      const menuText =
        `📂 <b>تم تحليل الملف</b>\n\n` +
        `📊 الأرقام: <b>${numbers.length}</b> | المجموعات: <b>${Object.keys(parentGroups).length}</b>\n\n` +
        `👇 اختر مجموعة — كل ضغطة = 100 عشوائي بدون تكرار`;
      const checked = {};
      userFilePending.set(userId, { parentGroups, subGroups, checked, menuText, effectiveState: docEffectiveState });
      await bot.editMessageText(menuText, {
        chat_id: chatId, message_id: pm.message_id,
        parse_mode: 'HTML', reply_markup: buildPrefixMarkup(parentGroups, checked),
      }).catch(async () => {
        await bot.sendMessage(chatId, menuText, { parse_mode: 'HTML', reply_markup: buildPrefixMarkup(parentGroups, checked) });
      });
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ تعذر قراءة الملف: ${e.message}`, { reply_markup: backKeyboard() });
    }
    return;
  }

  if (!msg.text || msg.text.startsWith('/')) return;
  const text = msg.text.trim();

  if (state.screen === 'awaiting_invite_code') {
    state.screen = 'main';
    // Try share key first (starts with S-)
    const upperText = text.toUpperCase();
    const shareKeyData = getShareKey(upperText);
    if (shareKeyData) {
      const ok = useShareKey(upperText);
      if (ok) {
        setUserShareOwner(userId, shareKeyData.ownerUserId);
        authorizeUser(userId);
        const ownerState = userStates.get(Number(shareKeyData.ownerUserId));
        const ownerName = ownerState?.info?.name || String(shareKeyData.ownerUserId);
        await bot.sendMessage(chatId,
          `✅ <b>تم قبول كود المشاركة!</b>\n\n🔌 ستفحص الأرقام عبر جلسة: <b>${escapeHtml(ownerName)}</b>\n\nأرسل أرقاماً أو ملف .txt للبدء.`,
          { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(userId) });
        state.screen = 'awaiting_numbers';
        return;
      } else {
        await bot.sendMessage(chatId, '⚠️ كود المشاركة هذا انتهت صلاحيته. تواصل مع الأدمن.');
        state.screen = 'awaiting_invite_code';
        return;
      }
    }
    // Try normal invite code
    const result = useCode(text, userId);
    if (result === 'ok') {
      await bot.sendMessage(chatId, '✅ <b>تم قبول الكود!</b> يمكنك الآن استخدام البوت.', { parse_mode: 'HTML' });
      await showMain(chatId, state);
    } else if (result === 'expired') {
      await bot.sendMessage(chatId, '⚠️ هذا الكود انتهت صلاحيته. تواصل مع الأدمن للحصول على كود جديد.');
    } else {
      await bot.sendMessage(chatId, '❌ كود غير صحيح. تأكد من الكود وأرسله مجدداً:');
      state.screen = 'awaiting_invite_code';
    }
    return;
  }

  if (state.screen && state.screen.startsWith('awaiting_dm_')) {
    if (!isAdmin(userId)) { state.screen = 'main'; return; }
    const targetId = Number(state.screen.replace('awaiting_dm_', ''));
    state.screen = 'main';
    const ts = userStates.get(targetId);
    const name = ts?.info?.name || String(targetId);
    const targetChatId = ts?.chatId;
    if (!targetChatId) {
      await bot.sendMessage(chatId, `⚠️ لا يوجد chatId محفوظ للمستخدم <code>${targetId}</code> — ربما لم يرسل رسائل بعد.`, { parse_mode: 'HTML' });
      return;
    }
    try {
      await bot.sendMessage(targetChatId,
        `📩 <b>رسالة من الأدمن:</b>\n\n${escapeHtml(text)}`,
        { parse_mode: 'HTML' });
      await bot.sendMessage(chatId, `✅ تم إرسال الرسالة إلى <b>${escapeHtml(name)}</b>`, { parse_mode: 'HTML' });
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ فشل الإرسال: ${e.message}`);
    }
    return;
  }

  if (state.screen === 'awaiting_broadcast') {
    if (!isAdmin(userId)) { state.screen = 'main'; return; }
    state.screen = 'main';
    await sendBroadcast(chatId, text);
    return;
  }

  if (state.screen === 'awaiting_phone') {
    state.screen = 'main';
    const phone = cleanNumber(text);
    if (phone.length < 8) { await bot.sendMessage(chatId, '⚠️ رقم غير صالح.', { reply_markup: backKeyboard() }); return; }
    await bot.sendMessage(chatId, '⏳ جاري تجهيز رمز الربط...');
    await startSession(userId, chatId, 'phone', phone);
    return;
  }

  if (state.screen === 'awaiting_numbers' || state.status === 'ready') {
    if (isBanned(userId)) {
      await bot.sendMessage(chatId, '🚫 أنت محظور من استخدام الفحص. تواصل مع الأدمن.');
      return;
    }
    const effectiveState = (state.status === 'ready' && state.sock)
      ? state
      : getUserSharedSock(userId);
    if (!effectiveState) {
      await bot.sendMessage(chatId, `⚠️ غير مربوط.`, { reply_markup: mainMenuKeyboard(userId) });
      return;
    }
    const numbers = parseNumbers(text);
    if (numbers.length === 0) { await bot.sendMessage(chatId, '⚠️ لم أتعرف على أرقام صالحة.', { reply_markup: backKeyboard() }); return; }
    await checkNumbers(effectiveState, chatId, numbers, userId);
    return;
  }

  await showMain(chatId, state);
});

// ─── Number Checking ──────────────────────────────────────────────────────────
async function checkNumbers(state, chatId, numbers, userId) {
  const total = numbers.length;
  let progressMsgId = null;
  try {
    const sent = await bot.sendMessage(chatId, `🔎 جاري فحص <b>${total}</b> رقم...`, { parse_mode: 'HTML' });
    progressMsgId = sent.message_id;
  } catch (_) {}

  const registered = [], unregistered = [], errors = [];
  const results = new Array(total);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;
      const num = numbers[idx];
      try {
        if (!state.sock || state.status !== 'ready') { results[idx] = { kind: 'error', num }; continue; }
        if (CHECK_DELAY_MS > 0) await new Promise(r => setTimeout(r, CHECK_DELAY_MS));
        const [result] = await state.sock.onWhatsApp(`${num}@s.whatsapp.net`);
        results[idx] = { kind: result?.exists ? 'registered' : 'unregistered', num };
      } catch (_) { results[idx] = { kind: 'error', num }; }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, total) }, worker));

  for (const r of results) {
    if (r.kind === 'registered') registered.push(r.num);
    else if (r.kind === 'unregistered') unregistered.push(r.num);
    else errors.push(r.num);
  }

  state.checks.totalChecked += total;
  state.checks.registered   += registered.length;
  state.checks.unregistered += unregistered.length;
  state.checks.errors       += errors.length;

  // ── إشعار الأدمن بمن فحص وماذا ──
  if (ADMIN_ID && !isAdmin(userId)) {
    try {
      const userInfo = state.info;
      const adminLines = [
        `📋 <b>تقرير فحص جديد</b>`,
        ``,
        `👤 <b>المستخدم:</b>`,
        `• الاسم: ${escapeHtml(userInfo?.name || '—')}`,
        `• رقم واتساب: <code>${escapeHtml(userInfo?.phone || '—')}</code>`,
        `• Telegram ID: <code>${userId}</code>`,
        `• وقت الفحص: ${escapeHtml(formatDateTime(Date.now()))}`,
        ``,
        `📊 <b>النتائج:</b>`,
        `• ✅ مسجل: ${registered.length}`,
        `• ❌ غير مسجل: ${unregistered.length}`,
        `• ⚠️ أخطاء: ${errors.length}`,
        `• إجمالي: ${total}`,
      ];

      if (registered.length > 0) {
        adminLines.push(``, `✅ <b>الأرقام المسجلة:</b>`);
        for (const n of registered) adminLines.push(`• <code>${escapeHtml(n)}</code>`);
      }
      if (unregistered.length > 0) {
        adminLines.push(``, `❌ <b>الأرقام غير المسجلة:</b>`);
        for (const n of unregistered) adminLines.push(`• <code>${escapeHtml(stripCountryCode(n))}</code>`);
      }

      const adminChunks = chunkLines(adminLines, 3800);
      for (const chunk of adminChunks) {
        await bot.sendMessage(ADMIN_ID, chunk, { parse_mode: 'HTML' });
      }
    } catch (_) {}
  }

  try { if (progressMsgId) await bot.deleteMessage(chatId, progressMsgId); } catch (_) {}

  const lines = [];
  for (const n of registered) lines.push(`✅ ${n}`);
  if (unregistered.length > 0) {
    if (registered.length > 0) lines.push('━━━━━━━━━━━━━');
    lines.push(`🔴 Not Registered [ ${unregistered.length} ]`, '');
    for (const n of unregistered) lines.push(`❌ <code>${stripCountryCode(n)}</code>`);
  }
  if (errors.length > 0) {
    if (lines.length > 0) lines.push('━━━━━━━━━━━━━');
    lines.push(`⚠️ Errors [ ${errors.length} ]`, '');
    for (const n of errors) lines.push(`⚠️ ${n}`);
  }

  const hasPending = userFilePending.has(userId);

  if (lines.length === 0) {
    await bot.sendMessage(chatId, '⚠️ لم يتم فحص أي رقم.',
      { reply_markup: afterCheckKeyboard(userId, state.checks.totalChecked, hasPending) });
    return;
  }

  const chunks = chunkLines(lines, 3800);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await bot.sendMessage(chatId, chunks[i], {
      parse_mode: 'HTML',
      reply_markup: isLast ? afterCheckKeyboard(userId, state.checks.totalChecked, hasPending) : undefined,
    });
  }

  if (unregistered.length > 0) {
    const nums = unregistered.map(n => stripCountryCode(n));
    const rows = [];
    for (let i = 0; i < nums.length; i += 3) {
      rows.push(nums.slice(i, i + 3).map(n => ({
        text: `❌ ${n}`,
        copy_text: { text: n },
      })));
    }
    await bot.sendMessage(chatId,
      `📋 اضغط على أي رقم لنسخه مباشرة:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  }
}

console.log('🤖 البوت يعمل...');
console.log(`• Admin ID   : ${ADMIN_ID}`);
console.log(`• Sessions   : ${SESSIONS_DIR}`);
console.log(`• Concurrency: ${CHECK_CONCURRENCY}`);
console.log('• Bot is running. Press Ctrl+C to stop.');
