# 带图交付的自动验证

## 先独立清点论文图片

从论文正文、图注及本次纳入的补充材料建立图号清单，不要仅根据已经写好的笔记生成清单。完整精读清点所有主 Figure；快速了解清点选入的 Figure。将清单保存为笔记目录下的 `figures.json`：

```json
{
  "scope": "full",
  "source": "论文标题、DOI 或用户提供的 PDF 版本；已清点正文主图",
  "figures": [
    {
      "id": "Figure 1",
      "heading": "Figure 1｜研究设计",
      "image": "images/figure-1.png"
    },
    {
      "id": "Figure 2",
      "heading": "Figure 2｜主要结果",
      "image": null
    }
  ]
}
```

`scope` 为 `full` 或 `quick`；`id` 是图号，`heading` 必须完整匹配 Markdown 中对应图章节标题并以 `id` 开头，`image` 是相对于笔记目录的实际图片路径。未取得图片仍需保留条目并将 `image` 写为 `null`，验证将失败；在笔记及最终交付中解释原因和补图方式。纳入补充图时也列出其图号，如 `Supplementary Figure S1`。

只有核对论文后确认**没有任何 Figure**，才可用 `"scope": "no_figures"`、`"figures": []` 和 `"no_figures_reason": "依据及原因"`。没有取得论文或尚未清点时不得使用此模式，也不能以空清单通过。

## 渲染后运行检查

```bash
node "<skill-dir>/scripts/render_note_html.mjs" "<note.md>" --force
node "<skill-dir>/scripts/validate_note.mjs" "<note.md>" --manifest "<figures.json>" --report "<validation-report.json>"
```

报告默认不会覆盖现有文件；确认目标是先前生成的报告时，再追加 `--force`。渲染器记录 Markdown 内容指纹，笔记变动后旧 HTML 会验证失败，须重新渲染。

退出码 `0` 和报告 `status: "pass"` 表示清单所列项目的自动检查通过；非零或 `status: "fail"` 表示未通过。逐项修复缺图、错章节、损坏文件或过期 HTML 后重新渲染并验证。低于 1000 px 的短边列为警告并人工检查；不得把警告当成已验证清晰。报告、清单及图片路径随笔记交付。

自动检查包括：图号及章节唯一性、是否有漏入清单的笔记图章节、Markdown/HTML 对应章节是否嵌图、图片路径及文件结构、尺寸、HTML 与 Markdown 的内容指纹。当前支持 PNG 和 JPEG；其他格式保留原始来源并转换成可在浏览器阅读的 PNG/JPEG 后再验证。PNG 检查数据块校验和及压缩数据；JPEG 检查头部、尺寸和结束标记，这些检查不能替代实际解码或视觉检查。

**验证边界：**工具不能读取论文并判断清单是否完整，不能判断图片是否属于指定 Figure、是否包含所有 panel、来源和授权是否正确，也不代替浏览器实际加载测试。须由执行者对照论文检查清单及图像内容；有浏览器时检查图片加载和放大，无法检查时在交付中明确说明。无论工具结果如何，缺图或无法核对的图都不得报告为完整带图精读。
