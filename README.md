# HZ Paper Analysis

一个通用的 Codex 文献精读 skill：按 Figure/Result 逐图梳理生物医学或生信论文，区分数据观察、计算推断和实验验证，保存论文原图，并生成 Markdown 笔记与 HTML 阅读版。

## 一键安装到 Codex

先安装 [Node.js](https://nodejs.org/)（建议 20 或更新版本），然后在终端复制运行：

```bash
npx --yes skills add https://github.com/Han-Z02/hz-paper-analysis/tree/main/skills/hz-paper-analysis -g -a codex --copy -y
```

这条命令会从 GitHub 获取 skill，并安装到当前用户的 Codex。Windows PowerShell、macOS 和 Linux 都可以使用。安装后新开一个 Codex 对话即可调用。

更新已安装的 skill：

```bash
npx --yes skills update hz-paper-analysis -g -y
```

## 使用

在 Codex 中附上论文 PDF，或提供 DOI/文章链接，然后输入：

```text
用 $hz-paper-analysis 逐图精读这篇论文，生成 Markdown 和 HTML 阅读版。
```

默认输出到当前项目/工作区下的 `paper-analysis/<论文短标题>/`，包括 Markdown、HTML 和 `images/`。移动或分享分析结果时，请保留整个论文文件夹。

## 包含内容

- `skills/hz-paper-analysis/SKILL.md`：执行流程与验收标准
- `skills/hz-paper-analysis/references/`：精读模板、证据分级规则
- `skills/hz-paper-analysis/scripts/render_note_html.mjs`：随包提供的 HTML 渲染器
- `skills/hz-paper-analysis/scripts/vendor/`：渲染器所需的 Marked；许可见同目录文件

仓库不包含论文、PDF、论文原图、个人知识库路径或账户凭据。skill 只在本机工作区生成阅读材料，不会自动发布分析结果。

## 使用条件与边界

- 生成 HTML 需要 Node.js 20 或更新版本；不需要额外安装 npm 依赖。
- 完整逐图分析需要能读取论文正文和补充材料。
- 获取高分辨率原图需要可用的浏览器或 PDF 工具；付费墙、403 或网络限制可能导致某些图片无法取得。skill 会报告缺口，不会用猜测补齐。
- 本仓库没有为 skill 说明和模板单独指定许可证。随包的 Marked 组件按其独立 MIT 许可证提供。
- 论文原图版权归原权利人。生成的笔记、PDF 和原图不会自动推送到 GitHub。

## 手动安装

也可以克隆仓库，把 `skills/hz-paper-analysis/` 整个文件夹复制到 Codex 个人技能目录：

- Windows：`%USERPROFILE%\.codex\skills\hz-paper-analysis\`
- macOS/Linux：`~/.codex/skills/hz-paper-analysis/`
