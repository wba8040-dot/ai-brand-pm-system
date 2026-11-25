/**
 * 匯入專案檔案（專案管理頁 →「匯入專案檔案」）
 *
 * 支援格式：
 *  - Excel（.xlsx）：可一次含多個工作表（專案／行銷活動／里程碑／任務）
 *  - CSV（UTF-8 或 Big5，逗號／分號／Tab 分隔）
 *  - 原本的 Google 試算表：在 Google 試算表選「檔案 → 下載 → Microsoft Excel (.xlsx)」後上傳
 *  - MS Project：另存為「XML」(.xml) 後上傳（.mpp 為私有格式，瀏覽器無法讀取）
 *
 * 流程：① 選檔案 → ② 匯入到哪個專案 → ③ 欄位對應 → ④ 預覽（紅＝無法匯入、黃＝自動處理）→ ⑤ 寫入
 * 不使用外部套件：.xlsx 本身是 zip＋XML，用瀏覽器內建的解壓縮（DecompressionStream）讀取。
 */
const Importer = (() => {
  const me = () => Auth.current();
  const STEPS = ['選擇檔案', '匯入目標', '欄位對應', '預覽確認', '匯入'];

  // =====================================================================
  // 1. ZIP（讀取／寫入）
  // =====================================================================
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('瀏覽器版本太舊，無法讀取 Excel 檔，請改用 CSV 或更新瀏覽器');
    const ds = new DecompressionStream('deflate-raw');
    const out = new Blob([bytes]).stream().pipeThrough(ds);
    // 限制解壓後大小，避免壓縮炸彈把分頁記憶體吃光
    const MAX = 100 * 1024 * 1024;
    const reader = out.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX) { reader.cancel().catch(() => {}); throw new Error('檔案解壓後太大（超過 100 MB），請拆成較小的檔案'); }
      chunks.push(value);
    }
    const res = new Uint8Array(total); let o = 0;
    chunks.forEach((c) => { res.set(c, o); o += c.length; });
    return res;
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    // 從檔尾找 End of Central Directory
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('檔案不是有效的 Excel（.xlsx）格式，可能已損毀或其實是舊版 .xls');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      entries.set(name, { method, csize, off });
      p += 46 + nlen + elen + clen;
    }
    return async (name) => {
      const e = entries.get(name);
      if (!e) return null;
      const lnlen = dv.getUint16(e.off + 26, true);
      const lelen = dv.getUint16(e.off + 28, true);
      const start = e.off + 30 + lnlen + lelen;
      const data = u8.subarray(start, start + e.csize);
      const raw = e.method === 0 ? data : e.method === 8 ? await inflateRaw(data) : null;
      if (!raw) throw new Error('不支援的壓縮格式');
      return dec.decode(raw);
    };
  }

  // CRC32（產生範本檔用）
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = []; const central = []; let offset = 0;
    files.forEach(({ name, text }) => {
      const nameB = enc.encode(name); const data = enc.encode(text); const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameB.length, true);
      parts.push(new Uint8Array(lh.buffer), nameB, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    });
    const csize = central.reduce((s, x) => s + x.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // =====================================================================
  // 2. 讀取各種檔案 → 工作表 [{ name, rows: [[...]] }]
  // =====================================================================
  const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  const kids = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];

  async function readXlsx(buf) {
    const get = await unzip(buf);
    const wb = await get('xl/workbook.xml');
    if (!wb) throw new Error('找不到工作表，這可能不是 Excel 檔');
    const relsText = await get('xl/_rels/workbook.xml.rels');
    const rels = {};
    if (relsText) kids(xml(relsText), 'Relationship').forEach((r) => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const shared = [];
    const ss = await get('xl/sharedStrings.xml');
    if (ss) kids(xml(ss), 'si').forEach((si) => shared.push(kids(si, 't').map((t) => t.textContent).join('')));
    // 日期格式（樣式）判斷：numFmtId 14–22、45–47 或自訂格式含 y/m/d
    const dateStyles = new Set();
    const st = await get('xl/styles.xml');
    if (st) {
      const doc = xml(st);
      const custom = {};
      kids(doc, 'numFmt').forEach((n) => { custom[n.getAttribute('numFmtId')] = n.getAttribute('formatCode') || ''; });
      const cellXfs = kids(doc, 'cellXfs')[0];
      if (cellXfs) [...cellXfs.children].forEach((xf, i) => {
        const id = Number(xf.getAttribute('numFmtId'));
        if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (custom[id] && /[ymd]/i.test(custom[id].replace(/\[[^\]]*\]|"[^"]*"/g, '')))) dateStyles.add(i);
      });
    }
    const sheets = [];
    for (const s of kids(xml(wb), 'sheet')) {
      const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
      let target = rels[rid] || '';
      target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      const text = await get(target);
      if (!text) continue;
      const rows = [];
      kids(xml(text), 'row').forEach((r) => {
        const ri = Number(r.getAttribute('r')) - 1;
        const row = [];
        kids(r, 'c').forEach((c, ci) => {
          const ref = c.getAttribute('r') || '';
          const col = ref ? colIndex(ref.replace(/\d+/g, '')) : ci;
          const t = c.getAttribute('t');
          const v = kids(c, 'v')[0]?.textContent;
          let val = '';
          if (t === 's') val = shared[Number(v)] ?? '';
          else if (t === 'inlineStr') val = kids(c, 't').map((x) => x.textContent).join('');
          else if (t === 'b') val = v === '1';
          else if (t === 'str' || t === 'e') val = v ?? '';
          else if (v !== undefined) {
            const n = Number(v);
            val = dateStyles.has(Number(c.getAttribute('s'))) ? { serial: n } : n;
          }
          row[col] = val;
        });
        rows[ri >= 0 ? ri : rows.length] = row;
      });
      sheets.push({ name: s.getAttribute('name'), rows: [...rows].map((r) => r || []) });
    }
    return sheets;
  }
  function colIndex(letters) { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

  function decodeText(buf) {
    const u8 = new Uint8Array(buf);
    const utf8 = new TextDecoder('utf-8').decode(u8);
    if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
    try { return new TextDecoder('big5').decode(u8); } catch (e) { return utf8; }   // 台灣 Excel 另存 CSV 常是 Big5
  }

  function parseCsv(text) {
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', '\t', ';'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  // MS Project XML → 依本系統欄位整理好的工作表
  function readMsProject(text) {
    const doc = xml(text);
    if (doc.getElementsByTagName('parsererror').length || !kids(doc, 'Task').length) throw new Error('看不懂這個 XML，請確認是由 MS Project「另存新檔 → XML」產生的檔案');
    const one = (el, tag) => kids(el, tag)[0]?.textContent ?? '';
    const res = {}; kids(doc, 'Resource').forEach((r) => { res[one(r, 'UID')] = one(r, 'Name'); });
    const owner = {}; kids(doc, 'Assignment').forEach((a) => { const t = one(a, 'TaskUID'); if (!owner[t] && res[one(a, 'ResourceUID')]) owner[t] = res[one(a, 'ResourceUID')]; });
    const tasks = kids(doc, 'Task').filter((t) => one(t, 'UID') !== '0' && one(t, 'Name'));
    const projName = one(doc.documentElement, 'Title') || one(doc.documentElement, 'Name').replace(/\.(xml|mpp)$/i, '');
    const d = (s) => (s || '').slice(0, 10);
    const camps = []; const mss = []; const tks = [];
    let curCamp = '';
    const uidToId = {}; tasks.forEach((t) => { uidToId[one(t, 'UID')] = `T${one(t, 'ID')}`; });
    tasks.forEach((t) => {
      const lvl = Number(one(t, 'OutlineLevel') || 1);
      const name = one(t, 'Name');
      if (one(t, 'Summary') === '1') { if (lvl <= 1) { curCamp = name; camps.push([name, d(one(t, 'Start')), d(one(t, 'Finish')), owner[one(t, 'UID')] || '']); } return; }
      if (lvl <= 1) curCamp = '';
      if (one(t, 'Milestone') === '1') { mss.push([name, d(one(t, 'Finish')), curCamp]); return; }
      const preds = kids(t, 'PredecessorUID').map((p) => uidToId[p.textContent]).filter(Boolean).join(',');
      tks.push([uidToId[one(t, 'UID')], name, owner[one(t, 'UID')] || '', curCamp, d(one(t, 'Start')), d(one(t, 'Finish')),
        `${one(t, 'PercentComplete') || 0}%`, preds, one(t, 'Notes')]);
    });
    const sheets = [{ name: '專案', rows: [['專案名稱', '開始日期', '預計結束日期'], [projName || '匯入的專案', d(one(doc.documentElement, 'StartDate')), d(one(doc.documentElement, 'FinishDate'))]] }];
    if (camps.length) sheets.push({ name: '行銷活動', rows: [['活動名稱', '計畫開始', '計畫結束', '活動負責人'], ...camps] });
    if (mss.length) sheets.push({ name: '里程碑', rows: [['里程碑名稱', '預計完成日', '關聯活動'], ...mss] });
    sheets.push({ name: '任務', rows: [['任務ID', '任務名稱', '負責人', '關聯活動', '預計開始', '預計完成', '實際進度', '前置任務ID', '任務說明'], ...tks] });
    return sheets;
  }

  async function readFile(file) {
    const sheets = await readFileRaw(file);
    const rowTotal = sheets.reduce((s, x) => s + (x.rows ? x.rows.length : 0), 0);
    if (rowTotal > 20000) throw new Error('資料超過 20,000 列，請拆成較小的檔案再匯入');
    return sheets;
  }

  async function readFileRaw(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (file.size > 10 * 1024 * 1024) throw new Error('檔案超過 10 MB，請拆成較小的檔案');
    if (ext === 'mpp') throw new Error('.mpp 是 MS Project 的私有格式，請在 MS Project 選「檔案 → 另存新檔 → XML 格式（*.xml）」後再上傳');
    if (ext === 'xls') throw new Error('舊版 .xls 無法讀取，請用 Excel 另存成 .xlsx 或 CSV');
    if (ext === 'numbers' || ext === 'ods') throw new Error('請先另存為 .xlsx 或 CSV 再上傳');
    const buf = await file.arrayBuffer();
    if (ext === 'xlsx' || ext === 'xlsm') return readXlsx(buf);
    if (ext === 'xml') return readMsProject(decodeText(buf));
    if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return [{ name: file.name.replace(/\.[^.]+$/, ''), rows: parseCsv(decodeText(buf)) }];
    // 沒副檔名：看內容猜
    const head = new Uint8Array(buf.slice(0, 4));
    if (head[0] === 0x50 && head[1] === 0x4B) return readXlsx(buf);
    return [{ name: file.name, rows: parseCsv(decodeText(buf)) }];
  }

  // =====================================================================
  // 3. 欄位定義與自動對應（含原本 Apps Script 版試算表的中文欄名）
  // =====================================================================
  const KINDS = {
    project: { label: '專案', sheetSyn: ['專案', '專案總覽', '專案資訊', 'project', 'projects', 'overview'] },
    campaign: { label: '行銷活動', sheetSyn: ['行銷活動', '活動', '行銷活動管理', 'campaign', 'campaigns'] },
    milestone: { label: '里程碑', sheetSyn: ['里程碑', '里程碑管理', 'milestone', 'milestones'] },
    task: { label: '任務', sheetSyn: ['任務', '任務管理', '工作項目', 'wbs', 'task', 'tasks', '工作'] }
  };
  const F = (key, label, syn, extra = {}) => ({ key, label, syn, ...extra });
  const FIELDS = {
    project: [
      F('name', '專案名稱', ['專案名稱', '專案', 'project', 'projectname', 'name', '名稱'], { req: true }),
      F('owner_name', '專案負責人', ['專案負責人', '負責人', '專案經理', 'owner', 'pm', 'manager']),
      F('start_date', '開始日期', ['開始日期', '專案開始', '開始', 'start', 'startdate'], { type: 'date' }),
      F('planned_end_date', '預計結束日期', ['預計結束日期', '預計結束', '結束日期', '預計完成', 'end', 'enddate', 'finish', 'due']),
      F('total_budget', '專案總預算', ['專案總預算', '總預算', '預算', 'budget', 'totalbudget'], { type: 'money' }),
      F('status', '專案狀態', ['專案狀態', '狀態', 'status'], { type: 'option', opt: '專案狀態', optDef: ['未開始', '進行中', '暫停', '完成'], def: '進行中' }),
      F('objective', '專案目標', ['專案目標', '目標', 'objective', 'goal', '說明', 'description'])
    ],
    campaign: [
      F('ref', '活動ID', ['活動id', '活動編號', 'campaignid', 'id', '編號']),
      F('name', '活動名稱', ['活動名稱', '行銷活動', '活動', 'campaign', 'campaignname', 'name', '名稱'], { req: true }),
      F('campaign_type', '活動類型', ['活動類型', '類型', 'type'], { type: 'option', opt: '活動類型', optDef: ['品牌曝光', '會員招募', '轉換促購', '口碑行銷', '再行銷', '其他'], blank: true }),
      F('owner', '活動負責人', ['活動負責人', '負責人', 'owner', 'assignee', 'pic']),
      F('status', '活動狀態', ['活動狀態', '狀態', 'status'], { type: 'option', opt: '活動狀態', optDef: ['規劃中', '待審核', '進行中', '已完成', '已取消'], def: '規劃中' }),
      F('planned_start', '計畫開始', ['計畫開始', '預計開始', '開始日期', '開始', 'start', 'startdate'], { type: 'date' }),
      F('planned_end', '計畫結束', ['計畫結束', '預計結束', '結束日期', '結束', 'end', 'enddate', 'finish'], { type: 'date' }),
      F('approved_budget', '核定預算', ['核定預算', '預算', 'budget'], { type: 'money' }),
      F('target_audience', '目標受眾', ['目標受眾', '受眾', 'audience', 'ta']),
      F('objective', '活動目標', ['活動目標', '目標', 'objective', 'goal']),
      F('notes', '備註', ['備註', 'notes', 'note', 'remark'])
    ],
    milestone: [
      F('name', '里程碑名稱', ['里程碑名稱', '里程碑', 'milestone', 'milestonename', 'name', '名稱'], { req: true }),
      F('planned_end', '預計完成日', ['預計完成日', '預計完成', '完成日', '日期', 'date', 'due', 'duedate', 'finish'], { type: 'date', req: true }),
      F('campaign', '關聯活動', ['關聯活動', '行銷活動', '活動', 'campaign', '活動id']),
      F('acceptance_status', '驗收狀態', ['驗收狀態', '狀態', 'status'], { type: 'option', opt: '驗收狀態', optDef: ['未驗收', '驗收中', '通過', '未通過'], def: '未驗收' }),
      F('acceptor_name', '驗收負責人', ['驗收負責人', '驗收人', '負責人', 'owner']),
      F('acceptance_criteria', '完成標準', ['完成標準', '驗收標準', 'criteria']),
      F('description', '說明', ['說明', '描述', 'description', 'notes', '備註'])
    ],
    task: [
      F('ref', '任務ID', ['任務id', '任務編號', 'taskid', 'id', '編號', 'wbs']),
      F('name', '任務名稱', ['任務名稱', '任務', '工作項目', '工作名稱', 'task', 'taskname', 'name', '名稱'], { req: true }),
      F('owner', '負責人', ['負責人', '執行人', '負責人員', 'owner', 'assignee', 'resourcenames', '資源名稱', 'pic']),
      F('campaign', '關聯活動', ['關聯活動', '行銷活動', '活動', 'campaign', '活動id']),
      F('priority', '優先級', ['優先級', '優先順序', '優先', 'priority'], { type: 'option', opt: '優先級', optDef: ['高', '中', '低'], def: '中' }),
      F('planned_start', '預計開始', ['預計開始', '計畫開始', '開始日期', '開始', 'start', 'startdate'], { type: 'date' }),
      F('planned_end', '預計完成', ['預計完成', '預計結束', '計畫完成', '截止日', '截止日期', '結束日期', '完成日', 'due', 'duedate', 'finish', 'end'], { type: 'date' }),
      F('planned_progress', '預計進度', ['預計進度', 'plannedprogress'], { type: 'pct' }),
      F('actual_progress', '實際進度', ['實際進度', '進度', '完成度', '完成百分比', 'complete', 'progress'], { type: 'pct' }),
      F('status', '任務狀態', ['任務狀態', '狀態', 'status'], { type: 'option', opt: '任務狀態', optDef: ['未開始', '進行中', '阻塞', '完成', '取消'], def: '未開始' }),
      F('estimated_hours', '預估工時', ['預估工時', '工時', 'estimatedhours', 'hours', 'work'], { type: 'num' }),
      F('predecessor', '前置任務ID', ['前置任務id', '前置任務', '前置', 'predecessors', 'dependson']),
      F('description', '任務說明', ['任務說明', '說明', '描述', 'description', 'notes', '備註'])
    ]
  };
  // 專案的「開始日期」等也要是日期型別
  FIELDS.project[3].type = 'date';

  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-（）()%％:：/／.。*]/g, '');

  function guessKind(sheet, header) {
    const n = norm(sheet.name);
    for (const [k, d] of Object.entries(KINDS)) if (d.sheetSyn.some((x) => n === norm(x) || n.includes(norm(x)))) return k;
    // 依欄名判斷
    const score = (k) => FIELDS[k].reduce((s, f) => s + (header.some((h) => f.syn.map(norm).includes(norm(h))) ? (f.req ? 3 : 1) : 0), 0);
    const best = Object.keys(FIELDS).map((k) => [k, score(k)]).sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= 3 ? best[0] : 'skip';
  }

  function findHeaderRow(rows) {
    let best = 0; let bestScore = -1;
    rows.slice(0, 10).forEach((r, i) => {
      const filled = r.filter((c) => typeof c === 'string' && c.trim()).length;
      const hits = r.filter((c) => Object.values(FIELDS).some((fs) => fs.some((f) => f.syn.map(norm).includes(norm(c))))).length;
      const sc = hits * 3 + filled;
      if (filled >= 2 && sc > bestScore) { best = i; bestScore = sc; }
    });
    return best;
  }

  function autoMap(kind, header) {
    const map = {}; const used = new Set();
    // 第一輪：完全相同；第二輪：包含
    [true, false].forEach((exact) => {
      FIELDS[kind].forEach((f) => {
        if (map[f.key] !== undefined) return;
        const syns = f.syn.map(norm);
        const idx = header.findIndex((h, i) => !used.has(i) && norm(h) && (exact ? syns.includes(norm(h)) : syns.some((s) => s.length >= 2 && (norm(h).includes(s)))));
        if (idx >= 0) { map[f.key] = idx; used.add(idx); }
      });
    });
    return map;
  }

  // 專案表若是「欄位名稱｜數值」直式（舊版專案總覽），轉成一列
  function maybeTransposeKV(rows) {
    const twoCol = rows.filter((r) => r.filter((c) => String(c ?? '').trim()).length === 2);
    const keyHits = twoCol.filter((r) => FIELDS.project.some((f) => f.syn.map(norm).includes(norm(r[0])))).length;
    if (keyHits >= 2) return [twoCol.map((r) => r[0]), twoCol.map((r) => r[1])];
    return rows;
  }

  // =====================================================================
  // 4. 值的轉換與檢查
  // =====================================================================
  const pad = (n) => String(n).padStart(2, '0');
  function toDate(v) {
    if (v === null || v === undefined || v === '') return { v: null };
    if (typeof v === 'object' && v.serial !== undefined) v = v.serial;
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return { v: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` }; }
      return { err: `「${v}」不是日期` };
    }
    let s = String(v).trim().replace(/[年月.]/g, '/').replace(/日/g, '').replace(/T.*$/, '').replace(/\s.*$/, '');
    let m = s.match(/^(\d{2,4})[/-](\d{1,2})[/-](\d{1,2})$/);
    let y; let mo; let d;
    if (m) { [, y, mo, d] = m.map(Number); if (y < 1000) y += 1911; }            // 民國年
    else if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) { [, mo, d, y] = m.map(Number); }   // 11/20/2026
    else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { [, y, mo, d] = m.map(Number); }
    else return { err: `「${v}」看不懂的日期格式（建議 2026-11-20）` };
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { err: `「${v}」不是有效日期` };
    return { v: `${y}-${pad(mo)}-${pad(d)}` };
  }
  function toNum(v, { money = false } = {}) {
    if (v === null || v === undefined || v === '') return { v: null };
    if (typeof v === 'number') return v < 0 ? { err: '不可為負數' } : { v };
    const s = String(v).replace(/NT\$|\$|元|,|，|\s|小時|hr?s?/gi, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    let n = Number(s);
    if (/萬$/.test(s)) n = Number(s.slice(0, -1)) * 10000;
    if (!Number.isFinite(n)) return { err: `「${v}」不是${money ? '金額' : '數字'}` };
    return n < 0 ? { err: '不可為負數' } : { v: n };
  }
  function toPct(v) {
    if (v === null || v === undefined || v === '') return { v: null };
    const hasPct = /%|％/.test(String(v));
    const r = toNum(String(v).replace(/%|％/g, ''));
    if (r.err) return { err: `「${v}」不是百分比` };
    let n = r.v;
    if (hasPct || n > 1) n /= 100;
    return n > 1 ? { err: `「${v}」超過 100%` } : { v: Math.round(n * 1000) / 1000 };
  }

  // =====================================================================
  // 5. 精靈
  // =====================================================================
  let S = null;   // 精靈狀態

  function open() {
    S = {
      step: 0, file: null, sheets: [], cfg: [],              // cfg[i] = { kind, headerRow, header, map }
      target: 'new', projectId: API.currentProjectId(), newName: '', dup: 'skip',
      rows: null, running: false, result: null
    };
    const m = U.openModal({ title: '匯入專案檔案', body: '<div id="imp"></div>', wide: true, dirtyCheck: false });
    m.classList.add('import-modal');
    // 匯入中不可關閉
    const guard = (e) => {
      if (!S || !S.running) return;
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type !== 'keydown' && !e.target.closest('[data-close]') && !e.target.classList.contains('modal-backdrop')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      U.toast('正在匯入，請等完成後再關閉', 'warn');
    };
    window.addEventListener('keydown', guard, true);
    window.addEventListener('mousedown', guard, true);
    window.addEventListener('click', guard, true);
    const cleanup = new MutationObserver(() => {
      if (!document.contains(m)) {
        window.removeEventListener('keydown', guard, true); window.removeEventListener('mousedown', guard, true); window.removeEventListener('click', guard, true);
        cleanup.disconnect();
      }
    });
    cleanup.observe(document.getElementById('modal-root'), { childList: true });
    render();
  }

  const box = () => document.getElementById('imp');
  function frame(inner, foot) {
    box().innerHTML = `${UX.stepper(STEPS, S.step)}<div class="imp-body">${inner}</div><div class="imp-foot">${foot}</div>`;
  }

  function render() {
    if (!box()) return;
    [stepFile, stepTarget, stepMap, stepPreview, stepRun][S.step]();
  }

  // ---------- ① 選擇檔案 ----------
  function stepFile() {
    frame(`
      <label class="drop-zone" id="drop">
        <input type="file" id="imp-file" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.xml" hidden>
        <div class="dz-icon" aria-hidden="true">📄</div>
        <div><b>點這裡選擇檔案</b>，或把檔案拖進來</div>
        <div class="muted small">Excel（.xlsx）、CSV、MS Project XML，最大 10 MB</div>
        ${S.file ? `<div class="dz-file">已選：<b>${U.esc(S.file.name)}</b>（${S.sheets.length} 個工作表）</div>` : ''}
      </label>
      <div class="form-error" id="imp-err" role="alert"></div>
      <details class="imp-help"><summary>其他格式怎麼匯入？</summary>
        <ul>
          <li><b>Google 試算表</b>（包含原本 Apps Script 版本用的那份）：在 Google 試算表選「檔案 → 下載 → Microsoft Excel (.xlsx)」，再上傳下載的檔案。原本的中文欄名（任務名稱、預計完成、核定預算…）會自動辨識。</li>
          <li><b>MS Project</b>：選「檔案 → 另存新檔 → 存檔類型：XML 格式（*.xml）」後上傳。摘要任務會成為行銷活動、里程碑會成為里程碑。</li>
          <li><b>舊版 Excel（.xls）、Numbers</b>：先另存成 .xlsx 或 CSV。</li>
        </ul>
      </details>
      <p class="muted small">不確定格式？<button type="button" class="link-btn" id="imp-tpl">下載範本檔（.xlsx）</button>，照範本填寫最保險。</p>`,
      `<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button>
       <button class="btn primary" id="imp-next" ${S.file ? '' : 'disabled title="請先選擇檔案"'}>下一步</button>`);

    const input = box().querySelector('#imp-file');
    const drop = box().querySelector('#drop');
    const err = box().querySelector('#imp-err');
    const take = async (file) => {
      if (!file) return;
      err.textContent = '';
      drop.classList.add('loading');
      try {
        const sheets = (await readFile(file)).filter((s) => s.rows.some((r) => r.some((c) => String(c ?? '').trim())));
        if (!sheets.length) throw new Error('檔案裡沒有任何資料');
        S.file = file; S.sheets = sheets;
        S.cfg = sheets.map((s) => {
          let rows = s.rows;
          const hr = findHeaderRow(rows);
          const header0 = (rows[hr] || []).map((c) => String(c ?? '').trim());
          let kind = guessKind(s, header0);
          if (kind === 'project') rows = maybeTransposeKV(rows);
          const headerRow = kind === 'project' && rows !== s.rows ? 0 : hr;
          if (rows !== s.rows) s.rows = rows;
          const header = (rows[headerRow] || []).map((c) => String(c ?? '').trim());
          if (kind === 'skip' && sheets.length === 1) kind = 'task';
          return { kind, headerRow, header, map: kind === 'skip' ? {} : autoMap(kind, header) };
        });
        const projSheet = S.cfg.findIndex((c) => c.kind === 'project');
        if (projSheet >= 0) {
          const c = S.cfg[projSheet]; const v = S.sheets[projSheet].rows[c.headerRow + 1] || [];
          S.newName = String(v[c.map.name] ?? '').trim();
        }
        if (!S.newName) S.newName = file.name.replace(/\.[^.]+$/, '');
        S.rows = null;
        render();
      } catch (e) {
        err.textContent = e.message;
      } finally { drop.classList.remove('loading'); }
    };
    input.onchange = () => take(input.files[0]);
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => take(e.dataTransfer.files[0]));
    box().querySelector('#imp-tpl').onclick = downloadTemplate;
    box().querySelector('[data-cancel]').onclick = U.closeModal;
    box().querySelector('#imp-next').onclick = () => { S.step = 1; render(); };
  }

  // ---------- ② 匯入目標 ----------
  function stepTarget() {
    const projs = API.cache.projects || [];
    const hasProjSheet = S.cfg.some((c) => c.kind === 'project');
    frame(`
      <fieldset class="imp-choice">
        <legend>要匯入到哪裡？</legend>
        <label class="radio-card ${S.target === 'new' ? 'on' : ''}"><input type="radio" name="target" value="new" ${S.target === 'new' ? 'checked' : ''}>
          <div><b>建立新專案</b><div class="muted small">${hasProjSheet ? '使用檔案中「專案」工作表的資料' : '用檔名當專案名稱，可修改'}</div>
          <input type="text" id="imp-newname" maxlength="80" value="${U.esc(S.newName)}" placeholder="新專案名稱" aria-label="新專案名稱"></div></label>
        <label class="radio-card ${S.target === 'existing' ? 'on' : ''} ${projs.length ? '' : 'disabled'}"><input type="radio" name="target" value="existing" ${S.target === 'existing' ? 'checked' : ''} ${projs.length ? '' : 'disabled'}>
          <div><b>加到既有專案</b><div class="muted small">「專案」工作表會被略過</div>
          <select id="imp-proj" aria-label="選擇既有專案">${U.options(projs.map((p) => p.project_id), S.projectId, { labels: Object.fromEntries(projs.map((p) => [p.project_id, p.name])) })}</select></div></label>
      </fieldset>
      <fieldset class="imp-choice" id="dup-box" ${S.target === 'existing' ? '' : 'hidden'}>
        <legend>專案裡已經有同名的資料時</legend>
        <label class="check"><input type="radio" name="dup" value="skip" ${S.dup === 'skip' ? 'checked' : ''}> 略過（建議，避免重複）</label>
        <label class="check"><input type="radio" name="dup" value="update" ${S.dup === 'update' ? 'checked' : ''}> 用檔案內容覆蓋更新（檔案中空白的欄位保留原值）</label>
        <label class="check"><input type="radio" name="dup" value="add" ${S.dup === 'add' ? 'checked' : ''}> 仍然新增一筆</label>
      </fieldset>
      <div class="form-error" id="imp-err" role="alert"></div>`,
      `<button class="btn ghost" id="imp-back">上一步</button><span class="spacer"></span>
       <button class="btn primary" id="imp-next">下一步</button>`);
    const b = box();
    b.querySelectorAll('input[name=target]').forEach((r) => { r.onchange = () => { S.target = r.value; S.rows = null; render(); }; });
    b.querySelectorAll('input[name=dup]').forEach((r) => { r.onchange = () => { S.dup = r.value; S.rows = null; }; });
    b.querySelector('#imp-newname').oninput = (e) => { S.newName = e.target.value; S.rows = null; };
    b.querySelector('#imp-newname').onfocus = () => { if (S.target !== 'new') { S.target = 'new'; render(); b.querySelector('#imp-newname')?.focus(); } };
    b.querySelector('#imp-proj').onchange = (e) => { S.projectId = e.target.value; S.rows = null; };
    b.querySelector('#imp-back').onclick = () => { S.step = 0; render(); };
    b.querySelector('#imp-next').onclick = () => {
      if (S.target === 'new' && !S.newName.trim()) { b.querySelector('#imp-err').textContent = '請輸入新專案名稱'; return b.querySelector('#imp-newname').focus(); }
      S.step = 2; render();
    };
  }

  // ---------- ③ 欄位對應 ----------
  function stepMap() {
    const kindOpts = (cur) => `<option value="skip" ${cur === 'skip' ? 'selected' : ''}>不匯入</option>` +
      Object.entries(KINDS).map(([k, d]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${d.label}</option>`).join('');
    const sheetHtml = S.sheets.map((sh, i) => {
      const c = S.cfg[i];
      const dataRows = sh.rows.length - c.headerRow - 1;
      const sample = sh.rows[c.headerRow + 1] || [];
      const fields = c.kind === 'skip' ? [] : FIELDS[c.kind];
      const disabledProj = c.kind === 'project' && S.target === 'existing';
      return `<section class="card imp-sheet" data-sheet="${i}">
        <div class="imp-sheet-head">
          <div><b>📑 ${U.esc(sh.name)}</b> <span class="muted small">${dataRows} 列資料・標題在第 ${c.headerRow + 1} 列</span></div>
          <label class="inline">匯入成<select data-kind="${i}">${kindOpts(c.kind)}</select></label>
        </div>
        ${disabledProj ? '<p class="muted small">已選「加到既有專案」，這個工作表不會匯入。</p>' : ''}
        ${fields.length && !disabledProj ? `<div class="table-wrap"><table class="table compact map-table">
          <thead><tr><th>系統欄位</th><th>對應檔案欄位</th><th>第一列範例</th></tr></thead>
          <tbody>${fields.map((f) => {
            const idx = c.map[f.key];
            return `<tr class="${f.req && idx === undefined ? 'map-missing' : ''}">
              <td>${U.esc(f.label)}${f.req ? ' <span class="req">*</span>' : ''}</td>
              <td><select data-map="${i}" data-field="${f.key}" aria-label="${U.esc(f.label)} 對應的欄位">
                <option value="">（不匯入）</option>
                ${c.header.map((h, hi) => h ? `<option value="${hi}" ${idx === hi ? 'selected' : ''}>${U.esc(h)}</option>` : '').join('')}
              </select></td>
              <td class="muted small">${idx === undefined ? '—' : U.esc(fmtCell(sample[idx]))}</td></tr>`;
          }).join('')}</tbody></table></div>` : ''}
      </section>`;
    }).join('');
    const missing = S.cfg.some((c, i) => c.kind !== 'skip' && !(c.kind === 'project' && S.target === 'existing')
      && FIELDS[c.kind].some((f) => f.req && c.map[f.key] === undefined));
    const nothing = S.cfg.every((c) => c.kind === 'skip' || (c.kind === 'project' && S.target === 'existing'));
    frame(`<p class="muted small">已依欄位名稱自動對應，請確認；對錯了可以直接改。標 <span class="req">*</span> 的欄位必須對應。</p>${sheetHtml}
      <div class="form-error" role="alert">${nothing ? '沒有任何要匯入的工作表' : missing ? '還有必填欄位沒有對應（紅色列）' : ''}</div>`,
      `<button class="btn ghost" id="imp-back">上一步</button><span class="spacer"></span>
       <button class="btn primary" id="imp-next" ${missing || nothing ? 'disabled' : ''}>預覽</button>`);
    const b = box();
    b.querySelectorAll('[data-kind]').forEach((sel) => {
      sel.onchange = () => {
        const i = Number(sel.dataset.kind); const c = S.cfg[i];
        c.kind = sel.value; c.map = c.kind === 'skip' ? {} : autoMap(c.kind, c.header); S.rows = null; render();
      };
    });
    b.querySelectorAll('[data-map]').forEach((sel) => {
      sel.onchange = () => {
        const c = S.cfg[Number(sel.dataset.map)];
        if (sel.value === '') delete c.map[sel.dataset.field]; else c.map[sel.dataset.field] = Number(sel.value);
        S.rows = null; render();
      };
    });
    b.querySelector('#imp-back').onclick = () => { S.step = 1; render(); };
    b.querySelector('#imp-next').onclick = async () => {
      const btn = b.querySelector('#imp-next'); btn.disabled = true; btn.textContent = '檢查中…';
      try { await buildRows(); S.step = 3; render(); } catch (e) { U.toast(e.message, 'bad', 6000); btn.disabled = false; btn.textContent = '預覽'; }
    };
  }
  // 選項比對：完全相同 → 同義詞 → 包含（例如「完成」對到「已完成」）
  const OPT_ALIAS = [
    ['完成', '已完成', '完工', '結案', 'done', 'completed', 'complete', 'finished', '100%'],
    ['進行中', '執行中', '處理中', 'inprogress', 'doing', 'ongoing', 'active'],
    ['未開始', '尚未開始', '待辦', '待開始', 'notstarted', 'todo', 'planned'],
    ['取消', '已取消', 'cancelled', 'canceled'],
    ['阻塞', '卡關', '暫停', 'blocked', 'onhold'],
    ['規劃中', '規劃', '企劃中', 'planning', 'draft'],
    ['高', 'high', 'h', '緊急', 'urgent'], ['中', 'medium', 'm', '普通', 'normal'], ['低', 'low', 'l'],
    ['通過', '已通過', 'passed', 'approved'], ['未驗收', '待驗收', 'pending']
  ];
  function matchOption(list, raw) {
    const n = norm(raw);
    const exact = list.find((o) => norm(o) === n);
    if (exact) return exact;
    const group = OPT_ALIAS.find((g) => g.some((a) => norm(a) === n));
    if (group) { const o = list.find((x) => group.some((a) => norm(a) === norm(x))); if (o) return o; }
    if (n.length >= 2) { const o = list.find((x) => norm(x).includes(n) || n.includes(norm(x))); if (o) return o; }
    return null;
  }

  const fmtCell = (v) => (v && typeof v === 'object' && v.serial !== undefined ? toDate(v).v || v.serial : v ?? '');

  // 整理成要寫入的資料＋問題清單
  async function buildRows() {
    const members = API.cache.members || [];
    const findMember = (raw) => {
      const s = String(raw ?? '').trim(); if (!s) return null;
      const n = norm(s);
      return members.find((m) => norm(m.member_id) === n || norm(m.email) === n || norm(m.name) === n)
        || members.find((m) => m.name && (n.includes(norm(m.name)) || norm(m.name).includes(n)) && n.length >= 2);
    };
    // 目標專案既有資料（判斷重複、對應活動）
    let existing = { camps: [], tasks: [], ms: [] };
    if (S.target === 'existing') {
      const [c, t, m] = await Promise.all([API.q.campaigns(), API.q.tasks(), API.q.milestones()]);
      const camps = (c.data || []).filter((x) => x.project_id === S.projectId);
      const ids = new Set(camps.map((x) => x.campaign_id));
      existing = { camps, tasks: (t.data || []).filter((x) => ids.has(x.campaign_id)), ms: (m.data || []).filter((x) => ids.has(x.campaign_id)) };
    }
    const out = { project: [], campaign: [], milestone: [], task: [] };
    S.cfg.forEach((c, si) => {
      if (c.kind === 'skip' || (c.kind === 'project' && S.target === 'existing')) return;
      const sh = S.sheets[si];
      sh.rows.slice(c.headerRow + 1).forEach((r, ri) => {
        if (!r.some((x) => String(x ?? '').trim())) return;
        const row = { kind: c.kind, sheet: sh.name, rowNo: c.headerRow + 2 + ri, data: {}, raw: {}, issues: [], include: true };
        FIELDS[c.kind].forEach((f) => {
          const idx = c.map[f.key]; if (idx === undefined) return;
          let v = r[idx];
          row.raw[f.key] = fmtCell(v);
          if (typeof v === 'string') v = v.trim();
          let res = { v };
          if (f.type === 'date') res = toDate(v);
          else if (f.type === 'money' || f.type === 'num') res = toNum(v, { money: f.type === 'money' });
          else if (f.type === 'pct') res = toPct(v);
          else if (f.type === 'option') {
            const list = API.opts(f.opt, f.optDef);
            const s = String(v ?? '').trim();
            const hit = s && matchOption(list, s);
            if (!s) res = { v: f.def && list.includes(f.def) ? f.def : (f.def ? matchOption(list, f.def) || list[0] : null) };
            else if (hit) res = { v: hit };
            else { res = { v: f.def || null }; row.issues.push({ lv: 'warn', msg: `${f.label}「${s}」不在選項中，改為「${f.def || '空白'}」` }); }
          } else res = { v: v === '' || v === undefined ? null : String(v) };
          if (res.err) row.issues.push({ lv: 'bad', msg: `${f.label}：${res.err}` });
          else row.data[f.key] = res.v;
        });
        if (!row.data.name) row.issues.push({ lv: 'bad', msg: `缺少${FIELDS[c.kind].find((f) => f.key === 'name').label}` });
        if (c.kind === 'milestone' && !row.data.planned_end && !row.issues.some((x) => x.msg.startsWith('預計完成日'))) row.issues.push({ lv: 'bad', msg: '缺少預計完成日' });
        const s = row.data.planned_start || row.data.start_date; const e = row.data.planned_end || row.data.planned_end_date;
        if (s && e && e < s) row.issues.push({ lv: 'bad', msg: `結束日（${e}）早於開始日（${s}）` });
        out[c.kind].push(row);
      });
    });
    // 新專案：沒有專案工作表時用名稱建立一列
    if (S.target === 'new') {
      if (!out.project.length) out.project.push({ kind: 'project', sheet: '—', rowNo: '—', data: { name: S.newName.trim(), status: '進行中' }, raw: {}, issues: [], include: true });
      out.project.forEach((p, i) => { if (i === 0) { p.data.name = S.newName.trim() || p.data.name; p.issues = p.issues.filter((x) => !x.msg.startsWith('缺少')); } else { p.include = false; p.issues.push({ lv: 'warn', msg: '一次只建立一個專案，這列略過' }); } });
    }
    const dupWarn = (list, name) => list.find((x) => norm(x.name) === norm(name));
    // 活動
    const campNames = new Set();
    out.campaign.forEach((r) => {
      if (r.data.owner) { const m = findMember(r.data.owner); if (m) r.data.owner_id = m.member_id; else { r.data.owner_id = me().member_id; r.issues.push({ lv: 'warn', msg: `找不到負責人「${r.data.owner}」，將指派給你` }); } }
      if (r.data.name && campNames.has(norm(r.data.name))) r.issues.push({ lv: 'warn', msg: '檔案中有同名活動' });
      campNames.add(norm(r.data.name));
      if (S.target === 'existing' && r.data.name) { const ex = dupWarn(existing.camps, r.data.name); if (ex) markDup(r, '專案裡已有同名活動', ex); }
    });
    // 任務／里程碑的活動對應
    const resolveCamp = (r) => {
      const key = norm(r.data.campaign);
      if (!key) { r.issues.push({ lv: 'warn', msg: '沒有關聯活動，將放到「一般工作」' }); return { general: true }; }
      const inFile = out.campaign.find((c) => c.include && !hasBad(c) && (norm(c.data.name) === key || norm(c.data.ref) === key));
      if (inFile) return { fileRow: inFile };
      const ex = existing.camps.find((c) => norm(c.name) === key || norm(c.campaign_id) === key);
      if (ex) return { campaignId: ex.campaign_id };
      r.issues.push({ lv: 'warn', msg: `找不到活動「${r.data.campaign}」，將放到「一般工作」` });
      return { general: true };
    };
    out.milestone.forEach((r) => {
      r.link = resolveCamp(r);
      if (S.target === 'existing' && r.data.name) { const ex = dupWarn(existing.ms, r.data.name); if (ex) markDup(r, '專案裡已有同名里程碑', ex); }
    });
    const refs = new Set(out.task.map((t) => norm(t.data.ref)).filter(Boolean));
    out.task.forEach((r) => {
      if (r.data.owner) { const m = findMember(r.data.owner); if (m) r.data.owner_id = m.member_id; else { r.data.owner_id = me().member_id; r.issues.push({ lv: 'warn', msg: `找不到負責人「${r.data.owner}」，將指派給你` }); } }
      else { r.data.owner_id = me().member_id; r.issues.push({ lv: 'warn', msg: '沒有負責人，將指派給你' }); }
      r.link = resolveCamp(r);
      if (r.data.predecessor) {
        const miss = String(r.data.predecessor).split(/[,，、;\s]+/).filter((p) => p && !refs.has(norm(p)));
        if (miss.length) r.issues.push({ lv: 'warn', msg: `前置任務 ${miss.join('、')} 不在檔案中，將略過` });
      }
      if (r.data.status === '完成' && r.data.actual_progress == null) r.data.actual_progress = 1;
      if (S.target === 'existing' && r.data.name) { const ex = dupWarn(existing.tasks, r.data.name); if (ex) markDup(r, '專案裡已有同名任務', ex); }
    });
    // 覆蓋更新的列：沒填的負責人／活動保留原值，不需要「指派給你／一般工作」的提示
    ['campaign', 'milestone', 'task'].forEach((k) => out[k].forEach((r) => {
      if (r.existing) r.issues = r.issues.filter((x) => !/^沒有負責人|^沒有關聯活動/.test(x.msg));
    }));
    ['project', 'campaign', 'milestone', 'task'].forEach((k) => out[k].forEach((r) => { if (hasBad(r)) r.include = false; }));
    S.rows = out;
    S.needGeneral = [...out.milestone, ...out.task].some((r) => r.include && r.link && r.link.general && !(r.existing && !r.data.campaign));
  }
  const hasBad = (r) => r.issues.some((x) => x.lv === 'bad');
  const rawHas = (r, k) => String(r.raw[k] ?? '').trim() !== '';
  function markDup(r, msg, ex) {
    if (S.dup === 'skip') { r.include = false; r.dup = true; r.issues.push({ lv: 'warn', msg: `${msg}，略過` }); }
    else if (S.dup === 'update') { r.existing = ex; r.issues.push({ lv: 'warn', msg: `${msg}（${ex.campaign_id && r.kind === 'campaign' ? ex.campaign_id : ex.task_id || ex.milestone_id || ex.campaign_id}），將覆蓋更新` }); }
    else r.issues.push({ lv: 'warn', msg: `${msg}，仍會新增一筆` });
  }

  // ---------- ④ 預覽 ----------
  function stepPreview() {
    const R = S.rows;
    const all = ['project', 'campaign', 'milestone', 'task'].flatMap((k) => R[k]);
    const cnt = (k) => R[k].filter((r) => r.include).length;
    const bad = all.filter(hasBad).length;
    const warn = all.filter((r) => !hasBad(r) && r.issues.length).length;
    const tab = S.tab && R[S.tab].length ? S.tab : ['task', 'campaign', 'milestone', 'project'].find((k) => R[k].length) || 'task';
    S.tab = tab;
    const cols = { project: ['name', 'owner_name', 'start_date', 'planned_end_date', 'total_budget'], campaign: ['name', 'owner', 'planned_start', 'planned_end', 'approved_budget'],
      milestone: ['name', 'planned_end', 'campaign'], task: ['ref', 'name', 'owner', 'campaign', 'planned_start', 'planned_end', 'actual_progress'] }[tab];
    const label = (k) => FIELDS[tab].find((f) => f.key === k)?.label || k;
    const show = (r, k) => {
      const v = r.data[k];
      if (v === undefined || v === null || v === '') return r.raw[k] ? `<span class="bad-text">${U.esc(r.raw[k])}</span>` : '<span class="muted">—</span>';
      if (k === 'actual_progress') return `${Math.round(v * 100)}%`;
      if (k === 'total_budget' || k === 'approved_budget') return U.money(v);
      if (k === 'owner') return U.esc(API.memberName(r.data.owner_id));
      return U.esc(v);
    };
    frame(`
      <div class="imp-summary">
        <div><b>${S.target === 'new' ? `新專案「${U.esc(S.newName)}」` : `加到「${U.esc(API.projectName(S.projectId))}」`}</b></div>
        <div class="imp-counts">
          ${S.target === 'new' ? '<span class="chip ok">專案 1</span>' : ''}
          <span class="chip ok">活動 ${cnt('campaign')}${S.needGeneral ? ' ＋「一般工作」' : ''}</span>
          <span class="chip ok">里程碑 ${cnt('milestone')}</span>
          <span class="chip ok">任務 ${cnt('task')}</span>
          ${all.filter((r) => r.include && r.existing).length ? `<span class="chip info">更新既有 ${all.filter((r) => r.include && r.existing).length}</span>` : ''}
          ${warn ? `<span class="chip warn">自動處理 ${warn}</span>` : ''}
          ${bad ? `<span class="chip bad">無法匯入 ${bad}</span>` : ''}
        </div>
      </div>
      <div class="seg imp-tabs" role="group" aria-label="切換預覽資料">${['task', 'campaign', 'milestone', 'project'].filter((k) => R[k].length).map((k) =>
        `<button type="button" class="seg-btn" aria-pressed="${k === tab}" data-tab="${k}">${KINDS[k].label}（${R[k].length}）</button>`).join('')}</div>
      <div class="table-wrap imp-preview"><table class="table compact">
        <thead><tr><th style="width:44px">匯入</th><th>列</th>${cols.map((k) => `<th>${U.esc(label(k))}</th>`).join('')}<th>說明</th></tr></thead>
        <tbody>${R[tab].map((r, i) => `<tr class="${hasBad(r) ? 'row-bad' : r.issues.length ? 'row-warn' : ''}">
          <td><input type="checkbox" data-inc="${i}" ${r.include ? 'checked' : ''} ${hasBad(r) ? 'disabled title="有錯誤，無法匯入"' : ''} aria-label="匯入第 ${r.rowNo} 列"></td>
          <td class="muted small">${U.esc(r.sheet === '—' ? '—' : r.rowNo)}</td>
          ${cols.map((k) => `<td>${show(r, k)}</td>`).join('')}
          <td class="small">${r.issues.map((x) => `<div class="${x.lv === 'bad' ? 'bad-text' : 'warn-text'}">${x.lv === 'bad' ? '✖' : '⚠'} ${U.esc(x.msg)}</div>`).join('') || '<span class="ok-text">✓</span>'}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">紅色＝有錯誤，不會匯入（請修正檔案後重新上傳）；黃色＝系統已自動處理，可取消勾選不匯入。</p>`,
      `<button class="btn ghost" id="imp-back">上一步</button><span class="spacer"></span>
       <button class="btn primary" id="imp-go" ${cnt('campaign') + cnt('milestone') + cnt('task') + (S.target === 'new' ? 1 : 0) ? '' : 'disabled'}>開始匯入</button>`);
    const b = box();
    b.querySelectorAll('[data-tab]').forEach((t) => { t.onclick = () => { S.tab = t.dataset.tab; render(); }; });
    b.querySelectorAll('[data-inc]').forEach((cb) => { cb.onchange = () => { R[tab][Number(cb.dataset.inc)].include = cb.checked; render(); }; });
    b.querySelector('#imp-back').onclick = () => { S.step = 2; render(); };
    b.querySelector('#imp-go').onclick = async () => {
      const n = cnt('campaign') + cnt('milestone') + cnt('task');
      if (!(await reconfirm(n))) return;
      S.step = 4; render();
    };
  }
  // confirmBox 會取代目前的對話框，所以用精靈內的確認列
  function reconfirm(n) {
    return new Promise((resolve) => {
      const foot = box().querySelector('.imp-foot');
      const old = foot.innerHTML;
      foot.innerHTML = `<span class="confirm-inline">確定要匯入 ${S.target === 'new' ? '1 個專案、' : ''}${n} 筆資料嗎？</span><span class="spacer"></span>
        <button class="btn ghost" data-r="0">再看看</button><button class="btn primary" data-r="1" data-no-busy>確定匯入</button>`;
      foot.querySelector('[data-r="1"]').focus();
      foot.querySelectorAll('[data-r]').forEach((btn) => { btn.onclick = () => { if (btn.dataset.r === '0') { foot.innerHTML = old; render(); } resolve(btn.dataset.r === '1'); }; });
    });
  }

  // ---------- ⑤ 寫入 ----------
  async function stepRun() {
    const R = S.rows;
    const jobs = [];
    if (S.target === 'new') jobs.push(...R.project.filter((r) => r.include));
    if (S.needGeneral) jobs.push({ kind: 'general' });
    jobs.push(...R.campaign.filter((r) => r.include), ...R.milestone.filter((r) => r.include), ...R.task.filter((r) => r.include));
    const total = jobs.length;
    const res = { ok: { project: 0, campaign: 0, milestone: 0, task: 0 }, updated: 0, fail: [] };
    frame(`<div class="imp-run" aria-live="polite">
        <div class="imp-run-text" id="run-text">準備中…</div>
        <div class="progress big"><div id="run-bar" style="width:0%"></div></div>
        <div class="muted small" id="run-count">0 / ${total}</div>
        <p class="muted small">請不要關閉視窗。</p></div>`, '<span class="spacer"></span><button class="btn primary" disabled>匯入中…</button>');
    S.running = true;
    document.body.dataset.unsaved = '1';
    let projectId = S.target === 'existing' ? S.projectId : null;
    let generalId = null;
    const refMap = {};        // 檔案中的任務ID → 新任務ID
    const done = [];          // [{row, newRow}]
    let n = 0;
    const tick = (label) => {
      n += 1;
      const bar = document.getElementById('run-bar'); if (bar) bar.style.width = `${Math.round((n / total) * 100)}%`;
      const c = document.getElementById('run-count'); if (c) c.textContent = `${n} / ${total}`;
      const t = document.getElementById('run-text'); if (t) t.textContent = label;
    };
    const campId = (link) => (link?.fileRow ? link.fileRow.newId : link?.campaignId) || generalId;
    // 覆蓋更新：只寫入檔案中有值的欄位（空白保留原值）
    const write = async (table, pk, r, patch, action) => {
      if (r.existing) {
        const p = clean(patch);
        const row = await API.updateWithVersion(table, pk, r.existing[pk], r.existing.version, p);
        res.updated += 1;
        return row;
      }
      return API.insert(table, clean(patch), action);
    };
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

    for (const r of jobs) {
      try {
        if (r.kind === 'project') {
          const d = r.data;
          const row = await API.insert('projects', clean({ name: d.name, owner_name: d.owner_name || me().name, start_date: d.start_date || U.today(),
            planned_end_date: d.planned_end_date, total_budget: d.total_budget || 0, status: d.status || '進行中', objective: d.objective }), '建立專案');
          projectId = row.project_id; res.ok.project += 1;
          tick(`已建立專案「${row.name}」`);
        } else if (r.kind === 'general') {
          const row = await API.insert('campaigns', { project_id: projectId, name: '一般工作', status: '進行中', owner_id: me().member_id, applicant_id: me().member_id, approved_budget: 0 }, '建立活動');
          generalId = row.campaign_id;
          tick('已建立「一般工作」');
        } else if (r.kind === 'campaign') {
          const d = r.data;
          const row = await write('campaigns', 'campaign_id', r, r.existing
            ? { name: d.name, campaign_type: d.campaign_type, owner_id: d.owner ? d.owner_id : undefined, status: rawHas(r, 'status') ? d.status : undefined,
              planned_start: d.planned_start, planned_end: d.planned_end, approved_budget: d.approved_budget, target_audience: d.target_audience, objective: d.objective, notes: d.notes }
            : { project_id: projectId, name: d.name, campaign_type: d.campaign_type, owner_id: d.owner_id || me().member_id,
              status: d.status || '規劃中', planned_start: d.planned_start, planned_end: d.planned_end, approved_budget: d.approved_budget ?? 0,
              target_audience: d.target_audience, objective: d.objective, notes: d.notes, applicant_id: me().member_id }, '建立活動');
          r.newId = row.campaign_id; res.ok.campaign += 1;
          tick(`活動「${d.name}」`);
        } else if (r.kind === 'milestone') {
          const d = r.data;
          await write('milestones', 'milestone_id', r, r.existing
            ? { planned_end: d.planned_end, campaign_id: d.campaign ? campId(r.link) : undefined, acceptance_status: rawHas(r, 'acceptance_status') ? d.acceptance_status : undefined,
              acceptor_name: d.acceptor_name, acceptance_criteria: d.acceptance_criteria, description: d.description }
            : { name: d.name, planned_end: d.planned_end, campaign_id: campId(r.link), acceptance_status: d.acceptance_status || '未驗收',
              acceptor_name: d.acceptor_name, acceptance_criteria: d.acceptance_criteria, description: d.description }, '建立里程碑');
          res.ok.milestone += 1;
          tick(`里程碑「${d.name}」`);
        } else if (r.kind === 'task') {
          const d = r.data;
          const row = await write('tasks', 'task_id', r, r.existing
            ? { owner_id: d.owner ? d.owner_id : undefined, campaign_id: d.campaign ? campId(r.link) : undefined, priority: rawHas(r, 'priority') ? d.priority : undefined,
              planned_start: d.planned_start, planned_end: d.planned_end, planned_progress: d.planned_progress, actual_progress: d.actual_progress,
              status: rawHas(r, 'status') ? d.status : undefined, estimated_hours: d.estimated_hours, description: d.description }
            : { name: d.name, owner_id: d.owner_id, campaign_id: campId(r.link), priority: d.priority || '中',
              planned_start: d.planned_start, planned_end: d.planned_end, planned_progress: d.planned_progress ?? 0, actual_progress: d.actual_progress ?? 0,
              status: d.status || '未開始', estimated_hours: d.estimated_hours, description: d.description }, '建立任務');
          if (d.ref) refMap[norm(d.ref)] = row.task_id;
          done.push({ r, row }); res.ok.task += 1;
          tick(`任務「${d.name}」`);
        }
      } catch (e) {
        res.fail.push({ kind: r.kind === 'general' ? 'campaign' : r.kind, sheet: r.sheet || '—', rowNo: r.rowNo || '—', name: r.data?.name || '一般工作', msg: e.message });
        tick(`失敗：${r.data?.name || '一般工作'}`);
        if (r.kind === 'project') break;     // 專案建立失敗就不繼續
      }
    }
    // 前置任務：換成新的任務ID
    for (const { r, row } of done) {
      if (!r.data.predecessor) continue;
      const ids = String(r.data.predecessor).split(/[,，、;\s]+/).map((p) => refMap[norm(p)]).filter(Boolean);
      if (!ids.length) continue;
      try { await API.updateWithVersion('tasks', 'task_id', row.task_id, row.version, { predecessor_ids: ids.join(',') }); } catch (e) { /* 前置任務失敗不影響主要資料 */ }
    }
    S.running = false;
    delete document.body.dataset.unsaved;
    S.result = res;
    if (projectId) API.setProject(projectId);
    await API.loadLookups(true).catch(() => {});
    renderResult(projectId);
  }

  function renderResult(projectId) {
    const { ok, fail } = S.result;
    const okTotal = ok.project + ok.campaign + ok.milestone + ok.task;
    box().innerHTML = `${UX.stepper(STEPS, 5)}<div class="imp-body">
      <div class="imp-done ${fail.length ? 'partial' : ''}">
        <div class="imp-done-icon" aria-hidden="true">${fail.length ? (okTotal ? '⚠' : '✖') : '✅'}</div>
        <h3>${fail.length ? (okTotal ? '部分匯入完成' : '匯入失敗') : '匯入完成'}</h3>
        <p>${ok.project ? '專案 1 個、' : ''}活動 ${ok.campaign} 個、里程碑 ${ok.milestone} 個、任務 ${ok.task} 項${S.result.updated ? `（其中 ${S.result.updated} 筆為覆蓋更新）` : ''}${fail.length ? `；<b class="bad-text">${fail.length} 筆失敗</b>` : ''}</p>
      </div>
      ${fail.length ? `<div class="table-wrap"><table class="table compact"><thead><tr><th>類型</th><th>工作表／列</th><th>名稱</th><th>原因</th></tr></thead>
        <tbody>${fail.map((f) => `<tr><td>${KINDS[f.kind]?.label || f.kind}</td><td>${U.esc(f.sheet)}／${U.esc(f.rowNo)}</td><td>${U.esc(f.name)}</td><td class="bad-text small">${U.esc(f.msg)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div><div class="imp-foot">
      ${fail.length ? '<button class="btn outline" id="imp-errcsv">下載失敗清單</button>' : ''}<span class="spacer"></span>
      <button class="btn ghost" id="imp-close">關閉</button>
      ${projectId && okTotal ? '<button class="btn primary" id="imp-view">查看活動日程</button>' : ''}</div>`;
    const b = box();
    b.querySelector('#imp-close').onclick = () => { U.closeModal(); App.refreshAll(); };
    const v = b.querySelector('#imp-view'); if (v) v.onclick = () => { U.closeModal(); location.hash = '#/schedule'; App.refreshAll(); };
    const ec = b.querySelector('#imp-errcsv');
    if (ec) ec.onclick = () => downloadBlob(new Blob(['﻿' + [['類型', '工作表', '列', '名稱', '原因'], ...fail.map((f) => [KINDS[f.kind]?.label, f.sheet, f.rowNo, f.name, f.msg])]
      .map((r) => r.map((c) => { let s = String(c ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'import_errors.csv');
    U.toast(fail.length ? `匯入完成，${fail.length} 筆失敗` : `已匯入 ${okTotal} 筆資料`, fail.length ? 'warn' : 'ok', 6000);
  }

  // =====================================================================
  // 6. 範本檔（.xlsx，四個工作表）
  // =====================================================================
  function downloadTemplate() {
    const t = U.today();
    const sheets = [
      { name: '專案', rows: [['專案名稱', '專案負責人', '開始日期', '預計結束日期', '專案總預算', '專案狀態', '專案目標'],
        ['2027 春季整合行銷', me().name, t, U.addDays(t, 90), 1200000, '進行中', '提升品牌聲量與會員數']] },
      { name: '行銷活動', rows: [['活動名稱', '活動類型', '活動負責人', '活動狀態', '計畫開始', '計畫結束', '核定預算', '目標受眾', '活動目標'],
        ['春季新品曝光', '品牌曝光', me().name, '規劃中', t, U.addDays(t, 30), 300000, '25–35 歲上班族', '曝光 100 萬次'],
        ['會員募集', '會員招募', me().name, '規劃中', U.addDays(t, 20), U.addDays(t, 60), 200000, '既有顧客', '新增會員 2,000 人']] },
      { name: '里程碑', rows: [['里程碑名稱', '預計完成日', '關聯活動', '驗收負責人', '完成標準'],
        ['素材定稿', U.addDays(t, 10), '春季新品曝光', me().name, '主視覺與文案經主管核可']] },
      { name: '任務', rows: [['任務ID', '任務名稱', '負責人', '關聯活動', '優先級', '預計開始', '預計完成', '實際進度', '任務狀態', '預估工時', '前置任務ID', '任務說明'],
        ['T1', '主視覺設計', me().name, '春季新品曝光', '高', t, U.addDays(t, 7), '0%', '未開始', 24, '', ''],
        ['T2', '社群貼文排程', me().name, '春季新品曝光', '中', U.addDays(t, 8), U.addDays(t, 14), '0%', '未開始', 12, 'T1', '依主視覺延伸 6 篇'],
        ['T3', '會員登錄頁', me().name, '會員募集', '高', U.addDays(t, 20), U.addDays(t, 30), '0%', '未開始', 40, '', '']] }
    ];
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const col = (i) => { let s = ''; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const sheetXml = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols><col min="1" max="${rows[0].length}" width="16" customWidth="1"/></cols><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = `${col(ci)}${ri + 1}`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t>${esc(v)}</t></is></c>`;
    }).join('')}</row>`).join('')}</sheetData></worksheet>`;
    const files = [
      { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE0E7FF"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows) }))
    ];
    downloadBlob(zipStore(files), 'project_import_template.xlsx');
    U.toast('已下載範本檔，照工作表填寫後即可匯入', 'ok');
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  return { open, readFile, parseCsv, toDate, toPct, toNum, readXlsx, readMsProject, downloadTemplate, _zipStore: zipStore };
})();
