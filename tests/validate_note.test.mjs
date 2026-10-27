import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const render = path.join(repo, 'skills/hz-paper-analysis/scripts/render_note_html.mjs');
const validate = path.join(repo, 'skills/hz-paper-analysis/scripts/validate_note.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC', 'base64');

function fixture() {
  const tmp = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tmp, 'hz-validation-test-'));
  fs.mkdirSync(path.join(dir, 'images'));
  fs.writeFileSync(path.join(dir, 'images/one.png'), png);
  fs.writeFileSync(path.join(dir, 'note.md'), '# 标题\n\n### Figure 1｜实验\n\n[![图](images/one.png)](images/one.png)\n');
  const manifest = { scope: 'full', source: '人工清点的示例论文', figures: [{ id: 'Figure 1', heading: 'Figure 1｜实验', image: 'images/one.png' }] };
  const saveManifest = () => fs.writeFileSync(path.join(dir, 'figures.json'), JSON.stringify(manifest));
  saveManifest();
  const rendered = spawnSync(process.execPath, [render, path.join(dir, 'note.md'), '--force'], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const run = () => spawnSync(process.execPath, [validate, path.join(dir, 'note.md'), '--manifest', path.join(dir, 'figures.json')], { encoding: 'utf8' });
  const cleanup = () => {
    const resolved = fs.realpathSync(dir);
    const relative = path.relative(tmp, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith('hz-validation-test-')) throw new Error('临时目录路径校验失败');
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  return { dir, manifest, saveManifest, run, cleanup };
}

test('验证有效图像，并把低分辨率列为警告', () => {
  const f = fixture();
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'pass'); assert.equal(report.passed, 1);
    assert.match(report.figures[0].warnings[0], /1000/);
  } finally { f.cleanup(); }
});

test('缺失图像不能通过', () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.dir, 'images/one.png'));
    const result = f.run(); assert.equal(result.status, 1);
    assert.match(result.stdout, /图片文件不可验证/);
  } finally { f.cleanup(); }
});

test('图片存在但对应 HTML 章节没有嵌入时失败', () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'note.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/<img src="images\/one\.png"[^>]*>/, ''));
    const result = f.run(); assert.equal(result.status, 1);
    assert.match(result.stdout, /对应 HTML 章节未嵌入/);
  } finally { f.cleanup(); }
});

test('HTML 图片出现在其他章节时失败', () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.dir, 'note.md'), '\n## 其他章节\n其他内容。\n');
    const rendered = spawnSync(process.execPath, [render, path.join(f.dir, 'note.md'), '--force'], { encoding: 'utf8' });
    assert.equal(rendered.status, 0);
    const file = path.join(f.dir, 'note.html');
    const html = fs.readFileSync(file, 'utf8');
    const image = html.match(/<img src="images\/one\.png"[^>]*>/)?.[0];
    assert.ok(image);
    fs.writeFileSync(file, html.replace(image, '').replace('其他内容。', '其他内容。' + image));
    const result = f.run(); assert.equal(result.status, 1);
    assert.match(result.stdout, /对应 HTML 章节未嵌入/);
  } finally { f.cleanup(); }
});

test('Markdown 更新后旧 HTML 不得通过', () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.dir, 'note.md'), '\n新内容\n');
    const result = f.run(); assert.equal(result.status, 1);
    assert.match(result.stdout, /HTML 与当前 Markdown 不一致/);
  } finally { f.cleanup(); }
});

test('Windows 换行符变化不导致 HTML 过期误报', () => {
  const f = fixture();
  try {
    const note = path.join(f.dir, 'note.md');
    fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace(/\r?\n/g, '\r\n'));
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { f.cleanup(); }
});

test('图片损坏不得通过', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, 'images/one.png'), 'not an image');
    const result = f.run(); assert.equal(result.status, 1);
    assert.match(result.stdout, /不是受支持的 PNG 或 JPEG/);
  } finally { f.cleanup(); }
});

test('笔记中的图章节未列入清单时失败', () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.dir, 'note.md'), '\n### Figure 2｜另一图\n');
    const rendered = spawnSync(process.execPath, [render, path.join(f.dir, 'note.md'), '--force'], { encoding: 'utf8' });
    assert.equal(rendered.status, 0);
    const result = f.run(); assert.equal(result.status, 1);
    assert.match(result.stdout, /图章节未列入清单/);
  } finally { f.cleanup(); }
});

test('同一图的“一句话”子标题不会被误认为漏图', () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.dir, 'note.md'), '\n#### Figure 1 一句话\n总结。\n');
    const rendered = spawnSync(process.execPath, [render, path.join(f.dir, 'note.md'), '--force'], { encoding: 'utf8' });
    assert.equal(rendered.status, 0);
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { f.cleanup(); }
});

test('图号与章节不对应时失败', () => {
  const f = fixture();
  try {
    f.manifest.figures[0].id = 'Figure 2'; f.saveManifest();
    const result = f.run(); assert.equal(result.status, 1);
    assert.match(result.stdout, /章节 heading 必须以图号 id 开头/);
  } finally { f.cleanup(); }
});

test('不允许报告覆盖原始笔记，即使指定 --force', () => {
  const f = fixture();
  try {
    const note = path.join(f.dir, 'note.md');
    const before = fs.readFileSync(note, 'utf8');
    const result = spawnSync(process.execPath, [validate, note, '--manifest', path.join(f.dir, 'figures.json'), '--report', note, '--force'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /报告路径不能覆盖/);
    assert.equal(fs.readFileSync(note, 'utf8'), before);
  } finally { f.cleanup(); }
});

test('图片清单中缺失图片路径时失败', () => {
  const f = fixture();
  try {
    f.manifest.figures[0].image = null; f.saveManifest();
    const result = f.run(); assert.equal(result.status, 1);
    assert.match(result.stdout, /图片路径为空/);
  } finally { f.cleanup(); }
});
