# 用 Codex 精读论文

把论文交给 Codex，就能按图精读，并生成 Markdown 笔记、HTML 阅读版和配套图片。

## 第一次安装

1. 安装 [Node.js](https://nodejs.org/) 20 或更新版本，选择 LTS 版即可。
2. 打开终端：Windows 同时按下 `Win + R`，输入 `PowerShell` 并按回车；Mac 打开“终端”。然后复制下面整行，粘贴后按回车：

```bash
npx --yes skills add https://github.com/Han-Z02/hz-paper-analysis/tree/main/skills/hz-paper-analysis -g -a codex --copy -y
```

3. 等安装完成后，新开一个 Codex 对话。

安装只需做一次。

## 开始读论文

在 Codex 对话中上传论文 PDF，或粘贴 DOI/文章链接，然后发送：

```text
$hz-paper-analysis 请逐图精读这篇论文，生成 Markdown 笔记和 HTML 阅读版。
```

## 结果在哪里

结果会保存在当前 Codex 项目下的 `paper-analysis` 文件夹中。每篇论文包含 Markdown、HTML 和 `images` 图片文件夹。打开 HTML 阅读；移动文件时请把整篇论文的文件夹一起移动。

如果论文全文或原图受访问限制，Codex 会说明哪些内容没能获取，不会猜测补齐。

## 更新

以后想安装新版时，在终端运行：

```bash
npx --yes skills update hz-paper-analysis -g -y
```

## 许可

Skill 文档目前没有单独的开放许可证；随附的 Marked 渲染组件使用 MIT 许可证。