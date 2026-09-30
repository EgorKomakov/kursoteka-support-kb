import { appendFileSync } from 'node:fs';
import { marked } from 'marked';

const REQUIRED = ['BOOKSTACK_URL','BOOKSTACK_API_ID','BOOKSTACK_API_SECRET','BOOKSTACK_BOOK_ID'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Не заданы секреты репозитория: ${missing.join(', ')}`);
  process.exit(1);
}

const baseUrl = process.env.BOOKSTACK_URL.replace(/\/+$/, '');
const bookId = Number(process.env.BOOKSTACK_BOOK_ID);

const issue = {
  number: Number(process.env.ISSUE_NUMBER),
  title: (process.env.ISSUE_TITLE || '').trim(),
  body: process.env.ISSUE_BODY || '',
  url: process.env.ISSUE_URL || '',
  state: process.env.ISSUE_STATE || 'open',
  author: process.env.ISSUE_AUTHOR || '',
  updatedAt: process.env.ISSUE_UPDATED_AT || '',
};
const repository = process.env.GITHUB_REPOSITORY || '';
const isClosed = issue.state === 'closed';

const SECTIONS = [
  { title: 'Проблема', aliases: ['проблема', 'краткое описание', 'симптом'] },
  { title: 'Причина', aliases: ['причина', 'диагноз'] },
  { title: 'Решение', aliases: ['решение', 'подробное решение', 'краткий ответ'] },
  { title: 'Ссылки', aliases: ['ссылки', 'связанные статьи'] },
];

function stripComments(md) { return md.replace(/<!--[\s\S]*?-->/g, ''); }
function normalizeHeading(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function splitSections(markdown) {
  const sections = new Map();
  let current = '';
  sections.set(current, []);
  for (const line of stripComments(markdown).replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^#{2,4}\s+(.+)$/.exec(line);
    if (heading) {
      current = normalizeHeading(heading[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }
  const result = new Map();
  for (const [name, lines] of sections) result.set(name, lines.join('\n').trim());
  return result;
}

function pickSection(sections, aliases) {
  for (const alias of aliases) {
    const value = sections.get(alias);
    if (value) return value;
  }
  return '';
}

function parseTopics(sections) {
  const raw = pickSection(sections, ['метки', 'теги', 'ключевые слова']);
  return raw
    .split(/[\n,;]+/)
    .map((item) => item.replace(/[#*\-\s\d.]+$/g, '').replace(/^[#*\-\s\d.]+/g, '').trim())
    .filter((item) => item.length > 0 && item.length <= 255);
}

const HTML_ESCAPES = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]); }
function formatDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(iso));
}

function buildPageName() {
  const title = issue.title.replace(/^\s*\[KCS\]\s*/i, '').trim() || 'Без названия';
  return `${issue.number} — ${title}`;
}

function buildHtml(sections) {
  const parts = [];
  parts.push(`<p><strong>Статус:</strong> ${isClosed ? 'решено' : 'в работе'}&nbsp;|&nbsp; <strong>Автор:</strong> ${escapeHtml(issue.author)} &nbsp;|&nbsp; <strong>Обновлено:</strong> ${formatDate(issue.updatedAt)}</p>`);
  parts.push(`<p><strong>Связанная задача:</strong> <a href="${escapeHtml(issue.url)}">${escapeHtml(repository)}#${issue.number}</a></p>`);
  parts.push('<hr>');
  for (const section of SECTIONS) {
    let content = pickSection(sections, section.aliases);
    if (section.title === 'Ссылки') content += `\n- Задача в GitHub: ${repository}#${issue.number}\n${issue.url}`;
    if (!content.trim()) continue;
    parts.push(`<h2>${section.title}</h2>`);
    parts.push(marked.parse(content));
  }
  return parts.join('\n');
}

function buildTags(topics) {
  const tags = [
    { name: 'github_issue', value: String(issue.number) },
    { name: 'status', value: isClosed ? 'решено' : 'в работе' },
    { name: 'repo', value: repository },
  ];
  for (const topic of topics) tags.push({ name: 'тема', value: topic });
  return tags;
}

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${process.env.BOOKSTACK_API_ID}:${process.env.BOOKSTACK_API_SECRET}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'bypass-tunnel-reminder': 'true',
      'User-Agent': 'kcs-bookstack-sync',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path} — ${response.status} ${response.statusText}\n${text}`);
  return text ? JSON.parse(text) : null;
}

async function findExistingPage() {
  const query = `[github_issue=${issue.number}] {type:page}`;
  const found = await api(`/api/search?query=${encodeURIComponent(query)}&count=5`);
  for (const item of found?.data || []) {
    if (item.type !== 'page') continue;
    const page = await api(`/api/pages/${item.id}`);
    const linked = (page.tags || []).some((tag) => tag.name === 'github_issue' && String(tag.value) === String(issue.number));
    if (linked) return page;
  }
  return null;
}

function writeSummary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

async function main() {
  const sections = splitSections(issue.body);
  const topics = parseTopics(sections);
  const payload = { name: buildPageName(), html: buildHtml(sections), tags: buildTags(topics) };
  console.log(`Событие: issues.${process.env.EVENT_ACTION}, задача #${issue.number}`);
  console.log(`Темы: ${topics.length > 0 ? topics.join(', ') : 'не указаны'}`);

  const existing = await findExistingPage();
  let page, verb;
  if (existing) {
    page = await api(`/api/pages/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    verb = 'обновлена';
  } else {
    page = await api('/api/pages', { method: 'POST', body: JSON.stringify({ book_id: bookId, ...payload }) });
    verb = 'создана';
  }
  console.log(`Статья ${verb}: id=${page.id}, «${page.name}»`);
  writeSummary([
    `## Статья базы знаний ${verb}`,
    '',
    `- Задача: [${repository}#${issue.number}](${issue.url})`,
    `- Статья BookStack: id=${page.id}, «${page.name}»`,
    `- Статус: ${isClosed ? 'решено' : 'в работе'}`,
    `- Темы: ${topics.length > 0 ? topics.join(', ') : '—'}`,
  ]);
}

main().catch((error) => {
  console.error('Синхронизация не выполнена.');
  console.error(error.message);
  process.exit(1);
});