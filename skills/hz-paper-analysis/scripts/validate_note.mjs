#!/usr/bin/env node

// Validates a manually inventoried set of paper figures against a rendered note.
// This checks files and markup; it cannot decide whether a figure is authentic.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { marked } from './vendor/marked.mjs';

const usage = 'Usage: node validate_note.mjs <note.md> --manifest <figures.json> [--report <report.json>] [--force]';

function argumentsFor(argv) {
  const result = { note: null, manifest: null, report: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
    if (arg === '--force') { result.force = true; continue; }
    if (arg === '--manifest' || arg === '--report') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[arg.slice(2)] = argv[++i];
    } else if (!arg.startsWith('-') && !result.note) result.note = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.note || !result.manifest) throw new Error(usage);
  return result;
}

function htmlText(value) {
  return value.replace(/<a\b[^>]*class=["'][^"']*heading-anchor[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (m) => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[m])
    .replace(/\s+/g, ' ').trim();
}

function markdownSections(markdown) {
  const tokens = marked.lexer(markdown);
  return tokens.flatMap((token, i) => {
    if (token.type !== 'heading') return [];
    let end = i + 1;
    while (end < tokens.length && !(tokens[end].type === 'heading' && tokens[end].depth <= token.depth)) end++;
    return [{ heading: htmlText(marked.parseInline(token.text)), depth: token.depth, content: tokens.slice(i + 1, end) }];
  });
}

function htmlSections(html) {
  // Search only the article body, not the table of contents or image viewer.
  const start = html.search(/<div\b[^>]*\bid=["']article-content["'][^>]*>/i);
  if (start < 0) throw new Error('HTML 缺少渲染器的 article-content 正文');
  const article = html.slice(start).split('</main>')[0]
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const matches = [...article.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  return matches.map((match, i) => {
    const depth = Number(match[1]);
    let end = i + 1;
    while (end < matches.length && Number(matches[end][1]) > depth) end++;
    return { heading: htmlText(match[2]), content: article.slice(match.index + match[0].length, matches[end]?.index ?? article.length) };
  });
}

function markdownImages(tokens) {
  const images = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'code' || value.type === 'codespan') return;
    if (value.type === 'image' && typeof value.href === 'string') images.push(value.href);
    for (const child of Object.values(value)) if (typeof child === 'object') {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  tokens.forEach(visit);
  return images;
}

function htmlImages(html) {
  return [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
}

function localPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text;
  try { text = decodeURIComponent(value.trim()); } catch { return null; }
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]|[a-z]:)/i.test(text) || /[?#]/.test(text)) return null;
  const clean = text.replaceAll('\\', '/');
  if (clean.split('/').includes('..')) return null;
  return path.posix.normalize(clean).replace(/^\.\//, '');
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function imageInfo(buffer) {
  if (buffer.length > 60 * 1024 * 1024) throw new Error('图像超过 60 MiB，未自动检查');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.subarray(0, 8).equals(png)) {
    let offset = 8, width = 0, height = 0, end = false;
    const idat = [];
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      if (length > buffer.length - offset - 12) throw new Error('PNG 数据块截断');
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      const data = buffer.subarray(offset + 8, offset + 8 + length);
      if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) throw new Error('PNG 数据块校验失败');
      if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error('PNG 缺少有效 IHDR');
      if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
      if (type === 'IDAT') idat.push(data);
      offset += 12 + length;
      if (type === 'IEND') { end = true; break; }
    }
    if (!width || !height || !idat.length || !end || offset !== buffer.length) throw new Error('PNG 结构不完整');
    try { inflateSync(Buffer.concat(idat), { maxOutputLength: 256 * 1024 * 1024 }); }
    catch { throw new Error('PNG 图像数据无法解压或超过检查上限'); }
    return { format: 'PNG', width, height, bytes: buffer.length };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2, width = 0, height = 0, sawScan = false;
    const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    while (offset + 4 <= buffer.length) {
      if (buffer[offset++] !== 0xff) throw new Error('JPEG 标记无效');
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xda) { sawScan = true; break; }
      if (marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) throw new Error('JPEG 头截断');
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) throw new Error('JPEG 数据段截断');
      if (sof.has(marker)) {
        if (length < 7) throw new Error('JPEG 尺寸信息无效');
        height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5);
      }
      offset += length;
    }
    if (!width || !height || !sawScan || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) throw new Error('JPEG 文件不完整');
    return { format: 'JPEG', width, height, bytes: buffer.length };
  }
  throw new Error('不是受支持的 PNG 或 JPEG；其他格式请转换后检查');
}

function exactlyOne(sections, heading, label, errors) {
  const matches = sections.filter((s) => s.heading === heading);
  if (matches.length !== 1) errors.push(`${label} 中标题「${heading}」出现 ${matches.length} 次，预期 1 次`);
  return matches.length === 1 ? matches[0] : null;
}

function verify(note, html, manifest, root) {
  const errors = [], warnings = [], figures = [];
  if (!manifest || typeof manifest !== 'object' || !['full', 'quick', 'no_figures'].includes(manifest.scope) || !Array.isArray(manifest.figures)) {
    throw new Error('清单必须包含 scope（full/quick/no_figures）和 figures 数组');
  }
  if (typeof manifest.source !== 'string' || !manifest.source.trim()) throw new Error('清单缺少论文来源说明 source');
  if (manifest.scope !== 'no_figures' && manifest.figures.length === 0) throw new Error('带图模式清单不得为空');
  if (manifest.scope === 'no_figures' && (manifest.figures.length || typeof manifest.no_figures_reason !== 'string' || !manifest.no_figures_reason.trim())) throw new Error('no_figures 须为空清单并说明 no_figures_reason');
  const mdSections = markdownSections(note);
  let rendered = [];
  if (!html) errors.push('HTML 文件不存在或为空');
  else {
    const sourceHash = html.match(/<meta\s+name="hz-paper-source-sha256"\s+content="([a-f0-9]{64})"\s*\/?\s*>/i)?.[1];
    if (!sourceHash || sourceHash !== createHash('sha256').update(note.replace(/\r\n/g, '\n'), 'utf8').digest('hex')) errors.push('HTML 与当前 Markdown 不一致或无法验证来源，请重新渲染');
    try { rendered = htmlSections(html); } catch (e) { errors.push(e.message); }
  }
  const seenIds = new Set(), seenHeadings = new Set(), seenImages = new Set(), headingIds = new Map();
  for (const item of manifest.figures) {
    const row = { id: item?.id, heading: item?.heading, image: item?.image ?? null, status: 'pass', errors: [], warnings: [] };
    if (!item || typeof item.id !== 'string' || !item.id.trim() || typeof item.heading !== 'string' || !item.heading.trim()) {
      row.errors.push('图号 id 和章节 heading 均不能为空');
    } else {
      const prefix = item.heading.slice(0, item.id.length).toLocaleLowerCase();
      const next = item.heading[item.id.length] || '';
      if (prefix !== item.id.toLocaleLowerCase() || /[a-z0-9]/i.test(next)) row.errors.push('章节 heading 必须以图号 id 开头');
      if (seenIds.has(item.id)) row.errors.push(`图号重复：${item.id}`);
      if (seenHeadings.has(item.heading)) row.errors.push(`章节重复：${item.heading}`);
      seenIds.add(item.id); seenHeadings.add(item.heading); headingIds.set(item.heading, item.id);
      const md = exactlyOne(mdSections, item.heading, 'Markdown', row.errors);
      const renderedSection = html ? exactlyOne(rendered, item.heading, 'HTML', row.errors) : null;
      if (!html) row.errors.push('HTML 不可用，无法检查该图是否嵌入');
      const expected = localPath(item.image);
      if (!expected) row.errors.push('图片路径为空或不是安全的相对路径');
      else {
        if (seenImages.has(expected)) row.errors.push(`多个图号使用同一文件：${expected}`);
        seenImages.add(expected);
        if (md && !markdownImages(md.content).some((src) => localPath(src) === expected)) row.errors.push('对应 Markdown 章节未嵌入该图片');
        if (renderedSection && !htmlImages(renderedSection.content).some((src) => localPath(src) === expected)) row.errors.push('对应 HTML 章节未嵌入该图片');
        try {
          const target = fs.realpathSync(path.resolve(root, expected));
          const relative = path.relative(fs.realpathSync(root), target);
          if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('图片实际位置超出笔记目录');
          const data = fs.readFileSync(target);
          row.file = { ...imageInfo(data), sha256: createHash('sha256').update(data).digest('hex') };
          if (Math.min(row.file.width, row.file.height) < 1000) row.warnings.push('图片短边小于 1000 px，需人工检查清晰度');
        } catch (e) { row.errors.push(`图片文件不可验证：${e.message}`); }
      }
    }
    if (row.errors.length) row.status = 'fail';
    figures.push(row);
  }
  // Catch figure headings that the inventory accidentally omitted from the note.
  const figureHeading = /^(?:figure|fig\.?|图|supplementary\s+(?:figure|fig\.?))\s*(?:s\s*)?\d+/i;
  const parents = [];
  for (const section of mdSections) {
    while (parents.length && parents[parents.length - 1].depth >= section.depth) parents.pop();
    const parentId = [...parents].reverse().map((parent) => headingIds.get(parent.heading)).find(Boolean);
    const isSameFigureSubheading = parentId && section.heading.slice(0, parentId.length).toLocaleLowerCase() === parentId.toLocaleLowerCase() && !/[a-z0-9]/i.test(section.heading[parentId.length] || '');
    if (figureHeading.test(section.heading) && !seenHeadings.has(section.heading) && !isSameFigureSubheading) errors.push(`Markdown 中图章节未列入清单：${section.heading}`);
    parents.push(section);
  }
  const failed = figures.filter((item) => item.status !== 'pass').length;
  if (figures.some((item) => item.warnings.length)) warnings.push('部分图片分辨率需要人工核查');
  return {
    status: errors.length || failed ? 'fail' : 'pass',
    scope: manifest.scope,
    source: manifest.source,
    no_figures_reason: manifest.scope === 'no_figures' ? manifest.no_figures_reason : undefined,
    note_sha256: createHash('sha256').update(note.replace(/\r\n/g, '\n'), 'utf8').digest('hex'),
    expected: figures.length,
    passed: figures.length - failed,
    failed,
    errors,
    warnings,
    limitations: ['清单须人工对照原论文；本工具不能确认图号清单完整、原图来源或图像科学内容。', '自动检查不等于浏览器实际加载和人工视觉检查；JPEG 仅检查文件结构。'],
    figures
  };
}

try {
  const args = argumentsFor(process.argv.slice(2));
  const notePath = path.resolve(args.note);
  const htmlPath = notePath.replace(/\.md$/i, '.html');
  if (htmlPath === notePath) throw new Error('笔记必须是 .md 文件');
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const note = fs.readFileSync(notePath, 'utf8');
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
  const result = verify(note, html, manifest, path.dirname(notePath));
  const output = JSON.stringify(result, null, 2) + '\n';
  if (args.report) {
    const target = path.resolve(args.report);
    const identity = (p) => fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
    const protectedFiles = [notePath, htmlPath, path.resolve(args.manifest), ...manifest.figures.map((figure) => {
      const value = localPath(figure?.image);
      return value ? path.resolve(path.dirname(notePath), value) : null;
    }).filter(Boolean)];
    if (protectedFiles.some((p) => identity(p) === identity(target))) throw new Error('报告路径不能覆盖笔记、HTML、清单或图片');
    if (fs.existsSync(target) && !args.force) throw new Error('报告文件已存在；确认是生成的报告后使用 --force');
    fs.writeFileSync(target, output, 'utf8');
  }
  console.log(output);
  if (result.status !== 'pass') process.exitCode = 1;
} catch (e) {
  console.error(`验证无法完成：${e.message}`);
  process.exitCode = 1;
}
