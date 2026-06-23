const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

const RAC_DEFAULT = [
  'RAC 01','RAC 02','RAC 03','RAC 04','RAC 05','RAC 06','RAC 07',
  'RAC 08','RAC 09','RAC 10','RAC 11','RAC 12','RAC 13','N/A'
];

function json(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function cleanText(value, max = 300) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRac(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'N/A') return 'N/A';
  const m = raw.match(/^(?:RAC\s*)?(0?[1-9]|1[0-3])$/);
  return m ? 'RAC ' + String(Number(m[1])).padStart(2, '0') : raw;
}

function allowedRacs(input) {
  const fromClient = Array.isArray(input)
    ? input.map(r => normalizeRac(typeof r === 'string' ? r : (r.codigo || r.id))).filter(Boolean)
    : [];
  const set = new Set([...RAC_DEFAULT, ...fromClient].filter(r => r === 'N/A' || /^RAC (0[1-9]|1[0-3])$/.test(r)));
  set.add('N/A');
  return set;
}

function parsePermissoes(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value).filter(k => value[k]);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsePermissoes(parsed);
    } catch (_) {
      return value.split(/[;,\s]+/).filter(Boolean);
    }
  }
  return [];
}

async function requirePermission(usuarioLogin) {
  const login = normalizeLogin(usuarioLogin);
  const mestre = normalizeLogin(process.env.MESTRE_LOGIN || 'marcelo');
  if (login && login === mestre) return true;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw Object.assign(new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente no Netlify.'), { statusCode: 500 });
  }
  if (!login) {
    throw Object.assign(new Error('Usuario nao informado para validar permissao.'), { statusCode: 403 });
  }

  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/rdo_usuarios?select=login,perfil,role,permissao,permissoes,ia_inspecao,ativo&login=eq.${encodeURIComponent(login)}&limit=1`;
  const resp = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(new Error(text || `Falha ao consultar usuario (${resp.status}).`), { statusCode: 500 });
  }
  const rows = await resp.json();
  const user = Array.isArray(rows) ? rows[0] : null;
  if (!user || user.ativo === false) {
    throw Object.assign(new Error('Usuario sem permissao para IA de inspecao.'), { statusCode: 403 });
  }
  const perfil = String(user.perfil || user.role || user.permissao || '').trim().toLowerCase();
  const perms = parsePermissoes(user.permissoes);
  const ok = perfil === 'mestre' || user.ia_inspecao === true || perms.includes('ia_inspecao') || perms.includes('inspecao_ia') || perms.includes('mestre');
  if (!ok) throw Object.assign(new Error('Usuario sem permissao para IA de inspecao.'), { statusCode: 403 });
  return true;
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if (typeof c.text === 'string') chunks.push(c.text);
      if (typeof c.output_text === 'string') chunks.push(c.output_text);
    }
  }
  return chunks.join('\n').trim();
}

async function callOpenAI({ model, input, instructions }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('OPENAI_API_KEY ausente no Netlify.'), { statusCode: 500 });
  const resp = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      instructions,
      input
    })
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!resp.ok) {
    const message = data?.error?.message || data?.message || text || `OpenAI HTTP ${resp.status}`;
    throw Object.assign(new Error(message), { statusCode: 502 });
  }
  const output = extractOutputText(data || {});
  try { return JSON.parse(output); } catch (_) {
    throw Object.assign(new Error('A IA retornou uma resposta fora do formato JSON esperado.'), { statusCode: 502 });
  }
}

function validateAnalysis(raw, racSet) {
  const rac = racSet.has(normalizeRac(raw.rac_sugerido)) ? normalizeRac(raw.rac_sugerido) : 'N/A';
  const conf = clamp01(raw.confianca ?? raw.confidence, 0);
  const evidencias = Array.isArray(raw.evidencias) ? raw.evidencias.slice(0, 4).map((ev, i) => {
    const evRac = racSet.has(normalizeRac(ev.rac || ev.rac_sugerido)) ? normalizeRac(ev.rac || ev.rac_sugerido) : 'N/A';
    const bbox = ev.bbox && typeof ev.bbox === 'object' ? ev.bbox : null;
    const x = bbox ? clamp01(bbox.x, 0) : 0;
    const y = bbox ? clamp01(bbox.y, 0) : 0;
    const width = bbox ? clamp01(bbox.width ?? bbox.w, 0.1) : 0;
    const height = bbox ? clamp01(bbox.height ?? bbox.h, 0.1) : 0;
    const evConf = clamp01(ev.confianca ?? ev.confidence, 0);
    return {
      id: cleanText(ev.id, 40) || `ev-${i + 1}`,
      texto: cleanText(ev.texto || ev.titulo || ev.descricao, 120),
      rac: evRac,
      fonte: cleanText(ev.fonte || 'imagem', 40),
      confianca: evConf,
      bbox: bbox ? { x, y, width: Math.max(0.01, Math.min(1 - x, width)), height: Math.max(0.01, Math.min(1 - y, height)) } : null
    };
  }) : [];
  return {
    titulo_sugerido: cleanText(raw.titulo_sugerido, 120),
    descricao_sugerida: cleanText(raw.descricao_sugerida, 300),
    rac_sugerido: rac,
    justificativa_rac: cleanText(raw.justificativa_rac, 300),
    confianca: conf,
    requer_revisao_manual: Boolean(raw.requer_revisao_manual || conf < 0.55 || evidencias.some(e => e.confianca < 0.55)),
    evidencias
  };
}

async function analisar(payload) {
  const racSet = allowedRacs(payload.racs);
  const image = String(payload.image || '');
  if (!image) throw Object.assign(new Error('Imagem obrigatoria.'), { statusCode: 400 });
  const dataUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
  const catalog = [...racSet].join(', ');
  const instructions = `Voce e um especialista de seguranca do trabalho em obras civis. Analise a foto e a descricao base. Responda somente JSON valido. Identifique riscos ou boas praticas, sugira RAC apenas dentro deste catalogo: ${catalog}. Nunca use RAC 14. Se nao tiver certeza, use N/A e marque requer_revisao_manual=true. No maximo 4 evidencias. Textos sem HTML. Campos obrigatorios: titulo_sugerido, descricao_sugerida, rac_sugerido, justificativa_rac, confianca, requer_revisao_manual, evidencias. Cada evidencia: id, texto, rac, fonte, confianca, bbox. bbox use x,y,width,height entre 0 e 1 ou null.`;
  const result = await callOpenAI({
    model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    instructions,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: `Descricao base: ${cleanText(payload.descricao, 300)}\nContexto: ${JSON.stringify(payload.contexto || {})}` },
      { type: 'input_image', image_url: dataUrl }
    ] }]
  });
  return validateAnalysis(result, racSet);
}

async function gerarDescricao(payload) {
  const racSet = allowedRacs(payload.racs);
  const rac = racSet.has(normalizeRac(payload.rac)) ? normalizeRac(payload.rac) : 'N/A';
  const evidencias = Array.isArray(payload.evidencias_selecionadas) ? payload.evidencias_selecionadas : (Array.isArray(payload.evidencias) ? payload.evidencias : []);
  if (!evidencias.length) throw Object.assign(new Error('Selecione ao menos uma evidencia.'), { statusCode: 400 });
  const instructions = 'Voce escreve registros curtos de inspecao de seguranca para RDO. Enriqueça a descricao sem inventar fatos, mantendo linguagem tecnica, objetiva e natural. Responda somente JSON valido com descricao_final. Maximo 300 caracteres, sem HTML.';
  const result = await callOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ descricao_original: cleanText(payload.descricao_original, 300), rac, evidencias: evidencias.slice(0, 4).map(e => cleanText(typeof e === 'string' ? e : (e.texto || e.descricao), 120)) }) }] }]
  });
  const descricao = cleanText(result.descricao_final || result.descricao || '', 300);
  if (!descricao) throw Object.assign(new Error('Descricao final vazia.'), { statusCode: 502 });
  return { descricao_final: descricao, caracteres: descricao.length };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Metodo nao permitido.' });
  try {
    const payload = JSON.parse(event.body || '{}');
    await requirePermission(payload.usuario_login);
    if (payload.action === 'analisar_inspecao_seguranca') return json(200, await analisar(payload));
    if (payload.action === 'gerar_descricao_inspecao') return json(200, await gerarDescricao(payload));
    return json(400, { error: 'Acao invalida.' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[inspecao-seguranca]', error);
    return json(statusCode, { error: error.message || 'Erro interno.' });
  }
}
