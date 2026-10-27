#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { marked } from './vendor/marked.mjs';

const WORKING_ROOT = process.cwd();
const GENERATOR_VERSION = '1.2.1';
const SKIP_DIRS = new Set([
  '.git', '.obsidian', '.claude', '.codex', '.agents', '.copilot',
  '.opencode', 'node_modules', 'attachments', 'assets', '__pycache__'
]);
const DISCOVERY_SKIP_DIRS = new Set([
  '.git', '.obsidian', '.claude', '.codex', '.agents', '.copilot',
  '.opencode', 'node_modules', '__pycache__'
]);
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?)$/i;
const localAssetCache = new Map();
let workspaceAssetIndex = null;

function usage() {
  console.log([
    'Usage:',
    '  node tools/kb/render_note_html.mjs <note.md> [--force]',
    '  node tools/kb/render_note_html.mjs <directory> [--index] [--force]',
    '  node tools/kb/render_note_html.mjs --all [--index]',
    '',
    'Options:',
    '  --all        Scan the current working directory. HTML is placed beside each Markdown note.',
    '  --index      Build or refresh index.html for the selected directory.',
    '  --no-index   Render notes without building an index.',
    '  --force      Regenerate HTML even when it is newer than Markdown.',
    '  --quiet      Only print errors and the final summary.'
  ].join('\n'));
}

function parseArgs(argv) {
  const options = { target: null, all: false, force: false, index: null, quiet: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--index') {
      options.index = true;
    } else if (arg === '--no-index') {
      options.index = false;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (!options.target) {
      options.target = arg;
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  if (options.all && !options.target) options.target = WORKING_ROOT;
  if (!options.target) {
    usage();
    process.exit(1);
  }
  return options;
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value) {
  const text = stripQuotes(value);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((item) => stripQuotes(item))
      .filter(Boolean);
  }
  return text;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: {}, body: raw };

  const data = {};
  let currentKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (pair) {
      currentKey = pair[1];
      const value = pair[2].trim();
      data[currentKey] = value === '' ? [] : parseScalar(value);
      continue;
    }
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(parseScalar(item[1]));
    }
  }
  return { data, body: raw.slice(match[0].length) };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stripTags(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function encodeRelativeHref(value) {
  const [pathname, fragment] = value.split('#', 2);
  const encoded = pathname
    .split('/')
    .map((segment) => (segment === '..' || segment === '.' ? segment : encodeURIComponent(segment)))
    .join('/');
  return fragment ? encoded + '#' + encodeURIComponent(fragment) : encoded;
}

function encodeAssetHref(value) {
  if (/^https?:\/\//i.test(value)) return value;
  return encodeRelativeHref(toPosix(value));
}

function collectFiles(directory, skipNames = DISCOVERY_SKIP_DIRS) {
  const files = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipNames.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function getWorkspaceAssetIndex() {
  if (workspaceAssetIndex) return workspaceAssetIndex;
  workspaceAssetIndex = new Map();
  for (const file of collectFiles(WORKING_ROOT)) {
    if (!IMAGE_EXTENSION.test(file)) continue;
    const name = path.basename(file).toLowerCase();
    if (!workspaceAssetIndex.has(name)) workspaceAssetIndex.set(name, []);
    workspaceAssetIndex.get(name).push(file);
  }
  return workspaceAssetIndex;
}

function resolveLocalAsset(sourceFile, rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, '');
  if (!target || /^(https?:|data:|#)/i.test(target)) return null;

  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }
  decoded = decoded.replace(/\\/g, '/').split('?')[0];
  const sourceDirectory = path.dirname(sourceFile);
  const direct = path.isAbsolute(decoded)
    ? decoded
    : path.resolve(sourceDirectory, decoded);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  const basename = path.basename(decoded).toLowerCase();
  if (!localAssetCache.has(sourceDirectory)) {
    const noteAssets = collectFiles(sourceDirectory).filter((file) =>
      IMAGE_EXTENSION.test(file) && path.basename(file).toLowerCase() === basename
    );
    localAssetCache.set(sourceDirectory, {
      name: basename,
      files: noteAssets
    });
  }
  const cache = localAssetCache.get(sourceDirectory);
  if (cache.name === basename && cache.files.length === 1) return cache.files[0];

  const matches = getWorkspaceAssetIndex().get(basename) || [];
  return matches.length === 1 ? matches[0] : null;
}

function resolveObsidianLink(sourceFile, rawTarget) {
  const target = rawTarget.trim();
  if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) return target;

  const [pathPartRaw, fragmentRaw] = target.split('#', 2);
  const pathPart = pathPartRaw.split('^')[0].replace(/\\/g, '/').trim();
  const candidate = path.isAbsolute(pathPart)
    ? pathPart
    : path.resolve(path.dirname(sourceFile), pathPart);
  const candidates = [candidate];
  if (!path.extname(candidate)) {
    candidates.push(candidate + '.md', candidate + '.html');
  }
  const resolved = candidates.find((item) => fs.existsSync(item));
  if (!resolved) {
    return encodeRelativeHref(pathPart) + (fragmentRaw ? '#' + encodeURIComponent(fragmentRaw) : '');
  }

  let hrefTarget = resolved;
  if (resolved.toLowerCase().endsWith('.md')) {
    const htmlSibling = resolved.slice(0, -3) + '.html';
    if (fs.existsSync(htmlSibling)) hrefTarget = htmlSibling;
  }
  const relative = toPosix(path.relative(path.dirname(sourceFile), hrefTarget));
  return encodeRelativeHref(relative) + (fragmentRaw ? '#' + encodeURIComponent(fragmentRaw) : '');
}

function normaliseObsidianSyntax(markdown, sourceFile) {
  let output = markdown;
  output = output.replace(/!\[\[([^\]]+)\]\]/g, (_match, inner) => {
    const parts = inner.split('|');
    const target = parts[0].trim();
    const qualifier = (parts[1] || '').trim();
    const isWidth = /^\d+$/.test(qualifier);
    const alt = isWidth ? path.basename(target) : qualifier || path.basename(target);
    const widthStyle = isWidth ? ' style="max-width:' + Number(qualifier) + 'px"' : '';
    const resolved = resolveLocalAsset(sourceFile, target);
    const href = resolved
      ? encodeAssetHref(toPosix(path.relative(path.dirname(sourceFile), resolved)))
      : encodeAssetHref(target);
    return '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '"' + widthStyle + '>';
  });
  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, targetRaw) => {
    let target = targetRaw.trim();
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1);
    } else {
      target = target.replace(/\s+["'][^"']*["']$/, '');
    }
    const resolved = resolveLocalAsset(sourceFile, target);
    if (!resolved) return match;
    const href = encodeAssetHref(toPosix(path.relative(path.dirname(sourceFile), resolved)));
    return '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '">';
  });
  output = output.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (_match, inner) => {
    const parts = inner.split('|');
    const target = parts[0].trim();
    const label = (parts[1] || target).trim();
    return '<a href="' + escapeHtml(resolveObsidianLink(sourceFile, target)) + '">' + escapeHtml(label) + '</a>';
  });
  return output;
}

function buildHeadingIds(html) {
  const headings = [];
  let index = 0;
  const rendered = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_match, level, inner) => {
    index += 1;
    const text = stripTags(inner);
    const id = 'section-' + index;
    headings.push({ level: Number(level), text, id });
    return '<h' + level + ' id="' + id + '">' + inner +
      '<a class="heading-anchor" href="#' + id + '" aria-label="链接到本节">#</a></h' + level + '>';
  });
  return { html: rendered, headings };
}

function transformCallouts(html) {
  const labels = {
    summary: '摘要', note: '说明', tip: '提示', important: '重点',
    warning: '注意', caution: '谨慎', danger: '警告', quote: '引用'
  };
  return html.replace(
    /<blockquote>\s*<p>\[!(summary|note|tip|important|warning|caution|danger|quote)\](?:\s*)([\s\S]*?)<\/p>/gi,
    (_match, typeRaw, titleRaw) => {
      const type = typeRaw.toLowerCase();
      const title = titleRaw.trim() || escapeHtml(labels[type]);
      return '<blockquote class="callout callout-' + type + '">' +
        '<p class="callout-title"><span class="callout-label">' + escapeHtml(labels[type]) +
        '</span>' + title + '</p>';
    }
  );
}

function renderMarkdown(raw, sourceFile) {
  const parsed = parseFrontmatter(raw);
  let markdown = parsed.body;
  markdown = markdown.replace(/^\s*#\s+.+(?:\r?\n)+/, '');
  markdown = normaliseObsidianSyntax(markdown, sourceFile);
  let html = marked.parse(markdown, { gfm: true, breaks: false });
  html = transformCallouts(html);
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  html = html.replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener noreferrer"');
  const withHeadings = buildHeadingIds(html);
  return { frontmatter: parsed.data, html: withHeadings.html, headings: withHeadings.headings };
}

function pickTitle(frontmatter, body) {
  if (frontmatter.title_zh) {
    return { primary: String(frontmatter.title_zh), secondary: frontmatter.title ? String(frontmatter.title) : '' };
  }
  if (frontmatter.title) return { primary: String(frontmatter.title), secondary: '' };
  const heading = body.match(/^\s*#\s+(.+)$/m);
  return { primary: heading ? heading[1].trim() : '未命名笔记', secondary: '' };
}

function normaliseTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).filter(Boolean);
  if (typeof tags === 'string') {
    return tags.replace(/^\[|\]$/g, '').split(',').map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

function safeUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

function buildActionLinks(frontmatter) {
  const links = [];
  const sourceUrl = safeUrl(frontmatter.source_url);
  const secondaryUrl = safeUrl(frontmatter.secondary_source_url);
  const codeUrl = safeUrl(frontmatter.code_url);
  const doi = String(frontmatter.doi || '').trim();
  if (sourceUrl) links.push({ label: '原文', href: sourceUrl });
  if (doi) links.push({ label: 'DOI', href: 'https://doi.org/' + doi });
  if (secondaryUrl) links.push({ label: '导航文章', href: secondaryUrl });
  if (codeUrl) links.push({ label: '代码', href: codeUrl });
  return links;
}

function buildToc(headings) {
  if (!headings.length) return '<p class="toc-empty">正文暂无二级标题。</p>';
  return headings.map((heading) =>
    '<a class="toc-link toc-h' + heading.level + '" href="#' + heading.id + '">' +
    escapeHtml(heading.text) + '</a>'
  ).join('\n');
}

function buildMetaBadges(frontmatter) {
  const badges = [];
  if (frontmatter.kb_id) badges.push({ css: 'badge-note-id', text: '笔记编号 ' + String(frontmatter.kb_id) });
  if (frontmatter.journal) badges.push({ css: '', text: String(frontmatter.journal) });
  if (frontmatter.year || frontmatter.date) {
    badges.push({ css: '', text: String(frontmatter.year || frontmatter.date) });
  }
  if (frontmatter.status) badges.push({ css: 'badge-status', text: String(frontmatter.status) });
  const sourceStatus = String(frontmatter.source_status || '');
  if (sourceStatus) {
    const map = {
      primary: '仅原文', mixed: '原文 + 二手材料', secondary: '仅二手材料', unverified: '待核对'
    };
    badges.push({ css: sourceStatus === 'mixed' ? 'badge-mixed' : 'badge-source', text: map[sourceStatus] || sourceStatus });
  }
  return badges.map((badge) =>
    '<span class="badge ' + badge.css + '">' + escapeHtml(badge.text) + '</span>'
  ).join('');
}

function buildTagList(frontmatter, limit = 20) {
  const tags = normaliseTags(frontmatter.tags).slice(0, limit);
  return tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
}

function estimateReadingMinutes(markdown) {
  const text = markdown
    .replace(/\x60{3}[\s\S]*?\x60{3}/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_-]/g, ' ');
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z0-9]+/g) || []).length;
  return Math.max(1, Math.ceil(chinese / 500 + latinWords / 220));
}

function baseCss() {
  return [
    ':root{--bg:#f2f4f2;--paper:#fff;--fg:#192126;--muted:#667178;--line:#d9dfdc;--accent:#0b6b61;--accent-2:#0b5e9d;--amber:#9a6700;--danger:#a33a3a;--code-bg:#17211f;--code-fg:#e9f5f1;--soft:#eef4f2;--shadow:0 10px 30px rgba(22,40,36,.07)}',
    'html[data-theme="dark"]{--bg:#111616;--paper:#182020;--fg:#e8efec;--muted:#a4b1ac;--line:#34413d;--accent:#5bc4b4;--accent-2:#79b9eb;--amber:#e1b34b;--danger:#ef8c8c;--code-bg:#0b1010;--code-fg:#e8f3ef;--soft:#202c2a;--shadow:0 12px 34px rgba(0,0,0,.28)}',
    '*{box-sizing:border-box}html{scroll-behavior:smooth;font-size:16px}',
    'body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.78}',
    'a{color:var(--accent-2);text-decoration:none}a:hover{text-decoration:underline}',
    '.reading-progress{position:fixed;inset:0 auto auto 0;height:3px;width:0;background:var(--accent);z-index:100;transition:width .1s linear}',
    '.topbar{position:sticky;top:0;z-index:40;border-bottom:1px solid color-mix(in srgb,var(--line) 82%,transparent);background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(12px)}',
    '.topbar-inner{max-width:1220px;margin:0 auto;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}',
    '.topbar-title{font-size:.9rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}',
    '.toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
    '.tool-button{border:1px solid var(--line);background:var(--paper);color:var(--fg);border-radius:6px;padding:5px 10px;font:inherit;font-size:.8rem;cursor:pointer}',
    '.tool-button:hover{border-color:var(--accent);color:var(--accent)}',
    '.layout{max-width:1220px;margin:0 auto;padding:28px 24px 72px;display:grid;grid-template-columns:238px minmax(0,1fr);gap:28px;align-items:start}',
    '.toc{position:sticky;top:72px;max-height:calc(100vh - 94px);overflow:auto;padding:18px 16px;background:var(--paper);border:1px solid var(--line);border-radius:8px}',
    '.toc-title{font-size:.78rem;text-transform:uppercase;font-weight:700;color:var(--muted);margin:0 0 12px}',
    '.sidebar-section-nav{margin:0 0 4px}.sidebar-nav-title{font-size:.8rem;font-weight:780;color:var(--fg);margin:0 0 9px}',
    '.sidebar-link{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 7px;border-radius:4px;color:var(--muted);font-size:.8rem;line-height:1.45}',
    '.sidebar-link:hover{background:var(--soft);color:var(--fg);text-decoration:none}.sidebar-link.active{background:var(--soft);color:var(--accent);font-weight:700}',
    '.sidebar-count{font-size:.68rem;color:var(--muted);background:var(--paper);border:1px solid var(--line);border-radius:999px;padding:0 5px;min-width:20px;text-align:center}',
    '.sidebar-divider{border-top:1px solid var(--line);margin:12px 0 14px}',
    '.toc-link{display:block;padding:5px 7px;border-left:2px solid transparent;color:var(--muted);font-size:.82rem;line-height:1.45;border-radius:0 4px 4px 0}',
    '.toc-link:hover{background:var(--soft);color:var(--fg);text-decoration:none}',
    '.toc-link.active{border-left-color:var(--accent);color:var(--accent);background:var(--soft);font-weight:650}',
    '.toc-h3{padding-left:20px;font-size:.78rem}.toc-empty{font-size:.82rem;color:var(--muted)}',
    '.article{min-width:0;background:var(--paper);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);overflow:hidden}',
    '.hero{padding:38px 44px 30px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,color-mix(in srgb,var(--soft) 58%,var(--paper)),var(--paper))}',
    '.eyebrow{font-size:.76rem;font-weight:750;text-transform:uppercase;color:var(--accent);margin-bottom:12px}',
    '.hero h1{font-family:"Noto Serif CJK SC","Source Han Serif SC","Songti SC",Georgia,serif;font-size:2.05rem;line-height:1.35;margin:0;font-weight:760}',
    '.subtitle{font-size:1rem;color:var(--muted);line-height:1.5;margin:11px 0 0;max-width:900px}',
    '.meta-badges,.tags,.actions{display:flex;gap:7px;flex-wrap:wrap}.meta-badges{margin-top:18px}',
    '.badge{display:inline-flex;align-items:center;border:1px solid var(--line);background:var(--paper);color:var(--muted);border-radius:999px;padding:3px 9px;font-size:.76rem}',
    '.badge-note-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--accent);background:var(--soft)}',
    '.badge-status{border-color:color-mix(in srgb,var(--amber) 45%,var(--line));color:var(--amber)}',
    '.badge-mixed{border-color:color-mix(in srgb,var(--accent) 40%,var(--line));color:var(--accent)}',
    '.tag{display:inline-flex;background:var(--soft);color:var(--muted);border-radius:4px;padding:2px 7px;font-size:.74rem}',
    '.tags{margin-top:10px}.actions{margin-top:18px}',
    '.action-link{border:1px solid var(--line);border-radius:6px;padding:6px 11px;color:var(--fg);font-size:.82rem;font-weight:650}',
    '.action-link:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}',
    '.content{padding:8px 44px 44px;max-width:960px}',
    '.content h2,.content h3,.content h4{font-family:"Noto Serif CJK SC","Source Han Serif SC","Songti SC",Georgia,serif;line-height:1.42;scroll-margin-top:82px}',
    '.content h2{font-size:1.55rem;margin:2.2em 0 .75em;padding-bottom:.45em;border-bottom:1px solid var(--line)}',
    '.content h3{font-size:1.18rem;margin:1.8em 0 .55em;color:var(--accent)}',
    '.content h4{font-size:1.02rem;margin:1.4em 0 .45em}',
    '.heading-anchor{margin-left:8px;color:var(--line);font-weight:400;opacity:0;transition:opacity .15s}.content h2:hover .heading-anchor,.content h3:hover .heading-anchor,.content h4:hover .heading-anchor{opacity:1}',
    '.content p{margin:.8em 0}.content ul,.content ol{padding-left:1.45em}.content li{margin:.32em 0}',
    '.content blockquote{margin:1.2em 0;padding:1px 18px;border-left:3px solid var(--line);background:var(--soft);color:var(--fg)}',
    '.callout{padding:15px 17px 14px!important;border:1px solid var(--line);border-left-width:5px!important;border-radius:6px}',
    '.callout-title{display:flex;gap:9px;align-items:center;font-weight:750;margin:0 0 7px!important}',
    '.callout-label{font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;background:var(--paper);border:1px solid var(--line);border-radius:4px;padding:1px 6px;color:var(--muted)}',
    '.callout-summary,.callout-note,.callout-tip{border-left-color:var(--accent)!important}.callout-warning,.callout-caution{border-left-color:var(--amber)!important}.callout-danger{border-left-color:var(--danger)!important}',
    '.content code{background:var(--soft);border-radius:4px;padding:.12em .34em;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:.9em}',
    '.content pre{background:var(--code-bg);color:var(--code-fg);padding:16px 18px;border-radius:6px;overflow:auto;line-height:1.55}.content pre code{background:none;color:inherit;padding:0}',
    '.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:6px;margin:1.2em 0}',
    '.content table{width:100%;border-collapse:collapse;min-width:640px;font-size:.9rem}',
    '.content th,.content td{padding:9px 11px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.content th{background:var(--soft);font-weight:700}.content tr:last-child td{border-bottom:0}',
    '.content img{display:block;max-width:100%;height:auto;margin:1.4em auto;border-radius:4px;border:1px solid var(--line);background:var(--paper)}',
    '.content a>img{cursor:zoom-in}',
    '.image-viewer{position:fixed;inset:0;z-index:200;display:grid;grid-template-rows:auto 1fr;background:#0b1010ee;backdrop-filter:blur(6px)}',
    '.image-viewer[hidden]{display:none}.image-viewer-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 16px;background:#101818f2;color:#f2f7f5;border-bottom:1px solid #52605b}',
    '.image-viewer-title{font-size:.84rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.image-viewer-actions{display:flex;gap:7px;flex-wrap:wrap}',
    '.image-viewer-action{border:1px solid #6b7a74;background:#fff;color:#17211f;border-radius:5px;padding:4px 9px;font:inherit;font-size:.8rem;cursor:pointer;text-decoration:none}',
    '.image-viewer-action:hover,.image-viewer-action:focus-visible{border-color:#68c8b9;outline:2px solid #68c8b9;outline-offset:1px;color:#0b5e57;text-decoration:none}',
    '.image-viewer-stage{overflow:auto;text-align:center;padding:20px;cursor:grab}.image-viewer-stage[data-zoomed="true"]{cursor:zoom-out}.image-viewer-stage img{display:block;max-width:none!important;height:auto!important;margin:0 auto!important;border:0!important;background:#fff;border-radius:0!important}',
    'body.image-viewer-open{overflow:hidden}',
    '.content hr{border:0;border-top:1px solid var(--line);margin:2em 0}',
    '.content .task-list-item{list-style:none}.content input[type="checkbox"]{margin-right:.45em}',
    '.doc-footer{margin-top:42px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.76rem;line-height:1.65}.doc-footer code{font-size:.72rem}',
    '.mobile-toc{display:none;margin:18px 24px 0;padding:12px 14px;background:var(--paper);border:1px solid var(--line);border-radius:6px}.mobile-toc summary{cursor:pointer;font-weight:700}',
    '@media(max-width:980px){.layout{grid-template-columns:1fr;padding:20px 16px 56px}.toc{display:none}.mobile-toc{display:block}.hero{padding:28px 24px 24px}.content{padding:4px 24px 32px}.topbar-inner{padding:9px 16px}.topbar-title{display:none}}',
    '@media(max-width:620px){.hero h1{font-size:1.58rem}.subtitle{font-size:.92rem}.meta-badges,.tags,.actions{gap:5px}.content{line-height:1.72}.content h2{font-size:1.32rem}.content h3{font-size:1.08rem}}',
    '@media(max-width:620px){.image-viewer-bar{padding:8px 10px}.image-viewer-stage{padding:10px}.image-viewer-action{padding:5px 8px}}',
    '@media print{.reading-progress,.topbar,.toc,.mobile-toc,.toolbar,.heading-anchor,.image-viewer{display:none!important}body{background:#fff;color:#000}.layout{display:block;max-width:none;padding:0}.article{border:0;box-shadow:none}.hero{padding:0 0 18px;background:#fff}.content{padding:0;max-width:none}a{color:#000}.table-wrap{overflow:visible}.content table{min-width:0}}'
  ].join('\n');
}

function buildHtml({ sourceFile, html, headings, frontmatter, raw }) {
  const title = pickTitle(frontmatter, raw);
  const actions = buildActionLinks(frontmatter);
  const tags = buildTagList(frontmatter);
  const metaBadges = buildMetaBadges(frontmatter);
  const readingMinutes = estimateReadingMinutes(raw);
  const markdownHref = encodeURIComponent(path.basename(sourceFile));
  const sourceLabel = path.basename(sourceFile);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const toc = buildToc(headings);
  const actionHtml = actions.map((link) =>
    '<a class="action-link" href="' + escapeHtml(link.href) + '" target="_blank" rel="noopener noreferrer">' +
    escapeHtml(link.label) + '</a>'
  ).join('');

  return [
    '<!doctype html>',
    '<html lang="zh-CN" data-theme="light">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<link rel="icon" href="data:,">',
    '<meta name="generator" content="hz-paper-analysis-html ' + GENERATOR_VERSION + '">',
    '<meta name="hz-paper-source-sha256" content="' + createHash('sha256').update(raw.replace(/\r\n/g, '\n'), 'utf8').digest('hex') + '">',
    '<title>' + escapeHtml(title.primary) + '</title>',
    '<style>' + baseCss() + '</style>',
    '</head>',
    '<body>',
    '<div class="reading-progress" id="reading-progress"></div>',
    '<header class="topbar"><div class="topbar-inner">',
    '<div class="topbar-title">' + escapeHtml(title.primary) + '</div>',
    '<div class="toolbar">',
    '<button class="tool-button" id="font-minus" type="button">A-</button>',
    '<button class="tool-button" id="font-plus" type="button">A+</button>',
    '<button class="tool-button" id="theme-toggle" type="button">深色</button>',
    '<button class="tool-button" id="print-page" type="button">打印</button>',
    '<a class="tool-button" href="' + markdownHref + '">Markdown</a>',
    '</div></div></header>',
    '<main class="layout">',
    '<aside class="toc"><p class="toc-title">阅读导航</p><nav id="toc-nav">' + toc + '</nav></aside>',
    '<article class="article">',
    '<header class="hero">',
    '<div class="eyebrow">Paper Analysis · ' + readingMinutes + ' 分钟阅读</div>',
    '<h1>' + escapeHtml(title.primary) + '</h1>',
    title.secondary ? '<p class="subtitle">' + escapeHtml(title.secondary) + '</p>' : '',
    '<div class="meta-badges">' + metaBadges + '</div>',
    tags ? '<div class="tags">' + tags + '</div>' : '',
    actionHtml ? '<div class="actions">' + actionHtml + '</div>' : '',
    '</header>',
    '<details class="mobile-toc"><summary>阅读导航</summary><nav>' + toc + '</nav></details>',
    '<div class="content" id="article-content">' + html,
    '<footer class="doc-footer">',
    '<div>源文件：<code>' + escapeHtml(sourceLabel) + '</code></div>',
    '<div>HTML 生成：' + escapeHtml(generatedAt) + ' · 生成器 v' + GENERATOR_VERSION + ' · Markdown 是内容源，重新渲染即可更新本页。</div>',
    '</footer>',
    '</div></article></main>',
    '<div class="image-viewer" id="image-viewer" hidden role="dialog" aria-modal="true" aria-labelledby="image-viewer-title">',
    '<div class="image-viewer-bar">',
    '<div class="image-viewer-title" id="image-viewer-title">论文原图</div>',
    '<div class="image-viewer-actions">',
    '<button class="image-viewer-action" id="image-zoom-toggle" type="button" aria-pressed="false">原始尺寸</button>',
    '<a class="image-viewer-action" id="image-open-original" href="#" target="_blank" rel="noopener noreferrer">新标签打开</a>',
    '<button class="image-viewer-action" id="image-viewer-close" type="button" aria-label="关闭图片查看器">关闭</button>',
    '</div></div>',
    '<div class="image-viewer-stage" id="image-viewer-stage"><img id="image-viewer-img" alt=""></div>',
    '</div>',
    '<script>',
    '(function(){',
    'var root=document.documentElement;',
    'function readSetting(key){try{return localStorage.getItem(key);}catch(_){return null;}}function saveSetting(key,value){try{localStorage.setItem(key,value);}catch(_){}}',
    'var saved=readSetting("paper-analysis-theme");',
    'if(saved){root.dataset.theme=saved;}',
    'var theme=document.getElementById("theme-toggle");',
    'function syncTheme(){theme.textContent=root.dataset.theme==="dark"?"浅色":"深色";}',
    'syncTheme();',
    'theme.addEventListener("click",function(){root.dataset.theme=root.dataset.theme==="dark"?"light":"dark";saveSetting("paper-analysis-theme",root.dataset.theme);syncTheme();});',
    'var size=Math.max(13,Math.min(21,Number(readSetting("kb-font-size"))||16));',
    'function applySize(){root.style.fontSize=size+"px";saveSetting("kb-font-size",String(size));}',
    'applySize();',
    'document.getElementById("font-minus").addEventListener("click",function(){size=Math.max(13,size-1);applySize();});',
    'document.getElementById("font-plus").addEventListener("click",function(){size=Math.min(21,size+1);applySize();});',
    'document.getElementById("print-page").addEventListener("click",function(){window.print();});',
    'var progress=document.getElementById("reading-progress");',
    'function updateProgress(){var h=document.documentElement.scrollHeight-window.innerHeight;progress.style.width=(h>0?Math.min(100,window.scrollY/h*100):0)+"%";}',
    'window.addEventListener("scroll",updateProgress,{passive:true});updateProgress();',
    'var links=Array.from(document.querySelectorAll("#toc-nav .toc-link"));',
    'var targets=links.map(function(a){var id=a.getAttribute("href").slice(1);try{id=decodeURIComponent(id);}catch(_){}return document.getElementById(id);});',
    'if("IntersectionObserver" in window){var observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){links.forEach(function(a){a.classList.remove("active");});var index=targets.indexOf(entry.target);if(index>=0){links[index].classList.add("active");}}});},{rootMargin:"-15% 0px -72% 0px",threshold:0});targets.forEach(function(t){if(t)observer.observe(t);});}',
    'var viewer=document.getElementById("image-viewer");',
    'var viewerImage=document.getElementById("image-viewer-img");',
    'var viewerTitle=document.getElementById("image-viewer-title");',
    'var viewerStage=document.getElementById("image-viewer-stage");',
    'var zoomToggle=document.getElementById("image-zoom-toggle");',
    'var openOriginal=document.getElementById("image-open-original");',
    'var closeViewer=document.getElementById("image-viewer-close");',
    'var lastTrigger=null;var zoomed=false;',
    'function setZoom(value){zoomed=value;viewerStage.dataset.zoomed=value?"true":"false";zoomToggle.setAttribute("aria-pressed",value?"true":"false");zoomToggle.textContent=value?"适应屏幕":"原始尺寸";if(value){viewerImage.style.width=viewerImage.naturalWidth+"px";}else{viewerImage.style.width="";}viewerStage.scrollTop=0;viewerStage.scrollLeft=0;}',
    'function openViewer(trigger){lastTrigger=trigger;var image=trigger.querySelector("img");if(!image)return;var title=image.getAttribute("alt")||image.getAttribute("src")||"论文原图";viewerImage.src=trigger.getAttribute("href")||image.getAttribute("src");viewerImage.alt=title;viewerTitle.textContent=title;openOriginal.href=trigger.getAttribute("href")||image.getAttribute("src");setZoom(false);viewer.hidden=false;document.body.classList.add("image-viewer-open");closeViewer.focus();}',
    'function dismissViewer(){viewer.hidden=true;document.body.classList.remove("image-viewer-open");viewerImage.removeAttribute("src");if(lastTrigger){lastTrigger.focus();lastTrigger=null;}}',
    'Array.from(document.querySelectorAll("#article-content a")).forEach(function(link){var href=link.getAttribute("href")||"";if(link.querySelector("img")&&!link.hasAttribute("target")&&!\/^(https?:|mailto:|#|javascript:)/i.test(href)){link.setAttribute("data-image-viewer","true");link.addEventListener("click",function(event){event.preventDefault();openViewer(link);});}});',
    'zoomToggle.addEventListener("click",function(){setZoom(!zoomed);});',
    'viewerStage.addEventListener("click",function(){setZoom(!zoomed);});',
    'closeViewer.addEventListener("click",dismissViewer);',
    'viewer.addEventListener("click",function(event){if(event.target===viewer)dismissViewer();});',
    'document.addEventListener("keydown",function(event){if(viewer.hidden)return;if(event.key==="Escape"){dismissViewer();}else if(event.key==="+"||event.key==="="){setZoom(true);}else if(event.key==="-"){setZoom(false);}});',
    '})();',
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');
}

function ensureDirectoryExists(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function outputPathForMarkdown(markdownFile) {
  return markdownFile.slice(0, -3) + '.html';
}

function readEntry(markdownFile) {
  const raw = fs.readFileSync(markdownFile, 'utf8');
  const frontmatter = parseFrontmatter(raw).data;
  return {
    markdownFile,
    htmlFile: outputPathForMarkdown(markdownFile),
    raw,
    frontmatter,
    title: pickTitle(frontmatter, raw)
  };
}

function renderFile(markdownFile, options = {}) {
  const outputFile = outputPathForMarkdown(markdownFile);
  const markdownMtime = fs.statSync(markdownFile).mtimeMs;
  if (
    !options.force &&
    fs.existsSync(outputFile) &&
    fs.statSync(outputFile).mtimeMs >= markdownMtime
  ) {
    if (!options.quiet) console.log('[skip] ' + toPosix(path.relative(WORKING_ROOT, outputFile)));
    return { ...readEntry(markdownFile), skipped: true };
  }

  const raw = fs.readFileSync(markdownFile, 'utf8');
  const rendered = renderMarkdown(raw, markdownFile);
  const html = buildHtml({
    sourceFile: markdownFile,
    html: rendered.html,
    headings: rendered.headings,
    frontmatter: rendered.frontmatter,
    raw
  });
  ensureDirectoryExists(path.dirname(outputFile));
  fs.writeFileSync(outputFile, html, 'utf8');
  if (!options.quiet) console.log('[html] ' + toPosix(path.relative(WORKING_ROOT, outputFile)));
  return {
    markdownFile,
    htmlFile: outputFile,
    raw,
    frontmatter: rendered.frontmatter,
    title: pickTitle(rendered.frontmatter, raw),
    skipped: false
  };
}

function walkMarkdown(directory) {
  const files = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        if (path.basename(full).toLowerCase() !== 'index.md') files.push(full);
      }
    }
  }
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function formatDate(stat) {
  return new Date(stat.mtimeMs).toLocaleDateString('zh-CN');
}

function noteEntryForIndex(entry, rootDirectory) {
  const stat = fs.statSync(entry.markdownFile);
  const relativeHtml = toPosix(path.relative(rootDirectory, entry.htmlFile));
  return {
    title: entry.title.primary,
    subtitle: entry.title.secondary,
    href: encodeRelativeHref(relativeHtml),
    journal: String(entry.frontmatter.journal || ''),
    year: String(entry.frontmatter.year || entry.frontmatter.date || ''),
    status: String(entry.frontmatter.status || ''),
    sourceStatus: String(entry.frontmatter.source_status || ''),
    tags: normaliseTags(entry.frontmatter.tags),
    mtime: stat.mtimeMs,
    date: formatDate(stat),
    summary: String(entry.frontmatter.classification_reason || entry.frontmatter.description || '')
  };
}

function buildIndexHtml(rootDirectory, entries) {
  const title = '论文精读总览';
  const sorted = entries.slice().sort((a, b) => b.mtime - a.mtime);
  const journals = new Set(sorted.map((item) => item.journal).filter(Boolean));
  const tags = Array.from(
    sorted.reduce((map, item) => {
      item.tags.forEach((tag) => map.set(tag, (map.get(tag) || 0) + 1));
      return map;
    }, new Map()).entries()
  ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).slice(0, 18);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const rootRelative = toPosix(path.relative(WORKING_ROOT, rootDirectory)) || '.';

  const cards = sorted.map((item) => {
    const meta = [item.journal, item.year].filter(Boolean).join(' · ');
    const badges = [
      item.status ? '<span class="index-badge badge-status">' + escapeHtml(item.status) + '</span>' : '',
      item.sourceStatus === 'mixed' ? '<span class="index-badge">原文 + 二手</span>' : ''
    ].join('');
    const tagHtml = item.tags.slice(0, 6).map((tag) => '<span class="index-tag">' + escapeHtml(tag) + '</span>').join('');
    const search = [item.title, item.subtitle, item.journal, item.year, item.tags.join(' '), item.summary]
      .join(' ').toLocaleLowerCase('zh-CN');
    return [
      '<article class="note-card" data-search="' + escapeHtml(search) + '">',
      '<div class="card-top"><span class="card-date">' + escapeHtml(item.date) + '</span>' + badges + '</div>',
      '<h2><a href="' + escapeHtml(item.href) + '">' + escapeHtml(item.title) + '</a></h2>',
      item.subtitle ? '<p class="card-subtitle">' + escapeHtml(item.subtitle) + '</p>' : '',
      meta ? '<p class="card-meta">' + escapeHtml(meta) + '</p>' : '',
      item.summary ? '<p class="card-summary">' + escapeHtml(item.summary) + '</p>' : '',
      tagHtml ? '<div class="index-tags">' + tagHtml + '</div>' : '',
      '<a class="card-open" href="' + escapeHtml(item.href) + '">打开精读笔记</a>',
      '</article>'
    ].join('');
  }).join('\n');

  const tagFilters = tags.map(([tag, count]) =>
    '<button type="button" class="filter-tag" data-tag="' + escapeHtml(tag.toLocaleLowerCase('zh-CN')) + '">' +
    escapeHtml(tag) + ' <span>' + count + '</span></button>'
  ).join('');

  return [
    '<!doctype html>',
    '<html lang="zh-CN" data-theme="light">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<link rel="icon" href="data:,">',
    '<meta name="generator" content="hz-paper-analysis-html ' + GENERATOR_VERSION + '">',
    '<title>' + title + '</title>',
    '<style>',
    baseCss(),
    '.index-shell{max-width:1220px;margin:0 auto;padding:42px 24px 72px}',
    '.index-head{display:flex;justify-content:space-between;gap:28px;align-items:flex-end;margin-bottom:26px}',
    '.index-head h1{font-family:"Noto Serif CJK SC","Source Han Serif SC","Songti SC",Georgia,serif;font-size:2.3rem;line-height:1.25;margin:0}',
    '.index-kicker{font-size:.78rem;font-weight:750;text-transform:uppercase;color:var(--accent);margin-bottom:9px}',
    '.index-intro{color:var(--muted);max-width:720px;margin:10px 0 0}',
    '.index-stats{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}',
    '.stat{border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:12px 15px;min-width:96px}',
    '.stat b{display:block;font-size:1.25rem}.stat span{font-size:.72rem;color:var(--muted)}',
    '.index-controls{position:sticky;top:0;z-index:20;padding:13px 0;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);margin-bottom:22px}',
    '.search{width:100%;border:1px solid var(--line);background:var(--paper);color:var(--fg);border-radius:6px;padding:11px 13px;font:inherit;font-size:.92rem;outline:none}',
    '.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 15%,transparent)}',
    '.filter-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}',
    '.filter-tag{border:1px solid var(--line);background:var(--paper);color:var(--muted);border-radius:999px;padding:3px 9px;font:inherit;font-size:.75rem;cursor:pointer}',
    '.filter-tag span{opacity:.65}.filter-tag.active{border-color:var(--accent);color:var(--accent);background:var(--soft)}',
    '.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}',
    '.note-card{border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:20px 21px 18px;box-shadow:var(--shadow);display:flex;flex-direction:column;min-height:230px}',
    '.card-top{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:11px}.card-date{font-size:.73rem;color:var(--muted)}',
    '.index-badge{font-size:.68rem;border:1px solid var(--line);border-radius:999px;padding:2px 7px;color:var(--muted)}.badge-status{border-color:color-mix(in srgb,var(--amber) 45%,var(--line));color:var(--amber)}',
    '.note-card h2{font-family:"Noto Serif CJK SC","Source Han Serif SC","Songti SC",Georgia,serif;font-size:1.16rem;line-height:1.45;margin:0 0 8px}',
    '.note-card h2 a{color:var(--fg)}.note-card h2 a:hover{color:var(--accent);text-decoration:none}',
    '.card-subtitle{font-size:.8rem;line-height:1.45;color:var(--muted);margin:0 0 9px}',
    '.card-meta{font-size:.76rem;color:var(--accent);margin:0 0 8px}',
    '.card-summary{font-size:.82rem;line-height:1.6;color:var(--muted);margin:0 0 12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
    '.index-tags{display:flex;gap:4px;flex-wrap:wrap;margin:auto 0 13px}.index-tag{background:var(--soft);color:var(--muted);border-radius:4px;padding:2px 6px;font-size:.68rem}',
    '.card-open{margin-top:auto;font-size:.8rem;font-weight:700;color:var(--accent)}',
    '.empty{border:1px dashed var(--line);border-radius:8px;padding:44px;text-align:center;color:var(--muted);display:none}',
    '.index-footer{margin-top:30px;padding-top:15px;border-top:1px solid var(--line);color:var(--muted);font-size:.76rem}',
    '@media(max-width:860px){.index-head{align-items:flex-start;flex-direction:column}.index-stats{justify-content:flex-start}.cards{grid-template-columns:1fr}}',
    '@media(max-width:620px){.index-shell{padding:28px 14px 52px}.index-head h1{font-size:1.72rem}.note-card{min-height:0}.stat{padding:9px 12px;min-width:82px}}',
    '@media print{.index-controls,.topbar{display:none!important}.index-shell{padding:0}.note-card{break-inside:avoid;box-shadow:none}}',
    '</style>',
    '</head>',
    '<body>',
    '<header class="topbar"><div class="topbar-inner"><div class="topbar-title">' + title + '</div><div class="toolbar"><button class="tool-button" id="theme-toggle" type="button">深色</button></div></div></header>',
    '<main class="index-shell">',
    '<section class="index-head">',
    '<div><div class="index-kicker">Paper Analysis</div><h1>' + title + '</h1><p class="index-intro">按修改时间浏览精读笔记。搜索标题、期刊、标签或摘要，再进入单篇阅读版。</p></div>',
    '<div class="index-stats"><div class="stat"><b>' + sorted.length + '</b><span>笔记</span></div><div class="stat"><b>' + journals.size + '</b><span>期刊</span></div><div class="stat"><b>' + tags.length + '</b><span>高频标签</span></div></div>',
    '</section>',
    '<section class="index-controls"><input class="search" id="note-search" type="search" placeholder="搜索标题、期刊、标签或摘要" aria-label="搜索笔记"><div class="filter-row">' + tagFilters + '</div></section>',
    '<section class="cards" id="note-cards">' + cards + '</section>',
    '<div class="empty" id="empty-state">没有匹配的笔记。</div>',
    '<footer class="index-footer">目录：<code>' + escapeHtml(rootRelative) + '</code> · 生成时间：' + escapeHtml(generatedAt) + ' · 重新生成：<code>node render_note_html.mjs &lt;folder&gt; --index --force</code></footer>',
    '</main>',
    '<script>',
    '(function(){',
    'var root=document.documentElement;var saved;try{saved=localStorage.getItem("paper-analysis-theme");}catch(_){}if(saved){root.dataset.theme=saved;}',
    'var theme=document.getElementById("theme-toggle");function sync(){theme.textContent=root.dataset.theme==="dark"?"浅色":"深色";}sync();',
    'theme.addEventListener("click",function(){root.dataset.theme=root.dataset.theme==="dark"?"light":"dark";try{localStorage.setItem("paper-analysis-theme",root.dataset.theme);}catch(_){}sync();});',
    'var search=document.getElementById("note-search");var cards=Array.from(document.querySelectorAll(".note-card"));var tagButtons=Array.from(document.querySelectorAll(".filter-tag"));var activeTag="";',
    'function apply(){var query=search.value.trim().toLocaleLowerCase("zh-CN");var visible=0;cards.forEach(function(card){var text=card.dataset.search||"";var ok=(!query||text.indexOf(query)>=0)&&(!activeTag||text.indexOf(activeTag)>=0);card.hidden=!ok;if(ok)visible++;});document.getElementById("empty-state").style.display=visible?"none":"block";}',
    'search.addEventListener("input",apply);tagButtons.forEach(function(button){button.addEventListener("click",function(){var next=button.dataset.tag;activeTag=activeTag===next?"":next;tagButtons.forEach(function(b){b.classList.toggle("active",b.dataset.tag===activeTag);});apply();});});',
    '})();',
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');
}

function buildIndex(rootDirectory, noteEntries) {
  const indexPath = path.join(rootDirectory, 'index.html');
  const entries = noteEntries.map((entry) => noteEntryForIndex(entry, rootDirectory));
  fs.writeFileSync(indexPath, buildIndexHtml(rootDirectory, entries), 'utf8');
  return indexPath;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = path.resolve(process.cwd(), options.target);
  if (!fs.existsSync(target)) throw new Error('Path does not exist: ' + target);
  const stat = fs.statSync(target);

  if (stat.isFile()) {
    if (path.extname(target).toLowerCase() !== '.md') throw new Error('Expected a Markdown file: ' + target);
    const entry = renderFile(target, options);
    console.log('Rendered: ' + entry.htmlFile);
    return;
  }

  const files = walkMarkdown(target);
  const entries = [];
  for (const file of files) entries.push(renderFile(file, options));
  const shouldBuildIndex = options.index ?? true;
  if (shouldBuildIndex) {
    const indexPath = buildIndex(target, entries);
    console.log('Index: ' + indexPath);
  }
  const written = entries.filter((entry) => !entry.skipped).length;
  console.log('Summary: ' + entries.length + ' Markdown, ' + written + ' HTML written, ' + (entries.length - written) + ' skipped.');
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export {
  WORKING_ROOT,
  GENERATOR_VERSION,
  DISCOVERY_SKIP_DIRS,
  parseFrontmatter,
  renderMarkdown,
  buildHtml,
  buildIndexHtml,
  pickTitle,
  normaliseTags,
  escapeHtml,
  stripTags,
  toPosix,
  encodeRelativeHref,
  baseCss,
  collectFiles,
  resolveLocalAsset,
  estimateReadingMinutes
};
