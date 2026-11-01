(() => {
  if (window.__noriReaderMessageHandler) {
    try {
      chrome.runtime.onMessage.removeListener(window.__noriReaderMessageHandler);
    } catch {}
  }

  const ignoredTagSet = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "IFRAME",
    "NAV", "FOOTER", "HEADER", "FORM", "BUTTON", "ASIDE", "DIALOG", "MENU"
  ]);
  const blockTagSet = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "MAIN", "BLOCKQUOTE",
    "PRE", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6",
    "FIGCAPTION", "TABLE", "TR"
  ]);
  const noisePattern = /(^|[-_ ])(advert|ads|promo|subscribe|newsletter|cookie|social|share|related|comment|comments|recommend|sidebar|toolbar|navbar|footer|header|pagination|breadcrumb|author-card)([-_ ]|$)/i;
  const chapterTitlePattern = /^([#＃]\s*\d+\s*.*|第[零一二三四五六七八九十百千万0-9]+[章节回卷集部篇幕](\s+.*|$)|Chapter\s+\d+.*|序[章言幕]?(\s+.*|$)|楔子(\s+.*|$)|尾声(\s+.*|$)|番外(\s*.*|$)|[一二三四五六七八九十]+[、.．]\s*\S+.*)$/i;
  const dividerLinePattern = /^(\*{3,}|-{3,}|={3,}|_{3,}|─{3,}|…{4,}|·{5,}|•{3,}|\*\s*\*\s*\*)$/;

  function isElementHidden(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return true;
    return false;
  }

  function isNoiseElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    if (ignoredTagSet.has(el.tagName)) return true;
    const label = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("role") || ""}`;
    return noisePattern.test(label);
  }

  function extractTextPreservingLines(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.nodeValue || "").replace(/\u00a0/g, " ").replace(/[ \t\f\v]+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (ignoredTagSet.has(node.tagName) || isElementHidden(node) || isNoiseElement(node)) return "";
    if (node.tagName === "BR") return "\n";

    let out = "";
    for (const child of node.childNodes) {
      out += extractTextPreservingLines(child);
    }
    if (blockTagSet.has(node.tagName)) {
      return `\n${out}\n`;
    }
    return out;
  }

  function textOf(element) {
    return extractTextPreservingLines(element)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function scoreCandidate(element) {
    if (!element || isElementHidden(element) || isNoiseElement(element)) return 0;
    const text = textOf(element);
    if (text.length < 120) return 0;
    const paragraphs = element.querySelectorAll("p").length;
    const lineBreaks = (text.match(/\n/g) || []).length;
    const linkText = Array.from(element.querySelectorAll("a")).reduce((sum, link) => sum + textOf(link).length, 0);
    const linkRatio = linkText / Math.max(1, text.length);
    if (linkRatio > 0.55) return 0;
    return Math.min(text.length, 45000) + paragraphs * 160 + Math.min(lineBreaks, 300) * 65 - linkText * 0.45;
  }

  function findArticleRoot() {
    const specificSelectors = [
      "main article",
      "article",
      "[itemprop='articleBody']",
      ".novel-main",
      ".gtm-novel-work-detail-page",
      ".rich_media_content",
      ".Post-RichText",
      ".article-content",
      ".post-content",
      ".entry-content",
      "main",
      "[role='main']"
    ];
    for (const sel of specificSelectors) {
      const found = document.querySelectorAll(sel);
      let bestInSel = null;
      let bestInSelScore = 0;
      for (const el of found) {
        const s = scoreCandidate(el);
        if (s > bestInSelScore) {
          bestInSel = el;
          bestInSelScore = s;
        }
      }
      if (bestInSel && bestInSelScore >= 400) return bestInSel;
    }

    const candidates = [
      ...document.querySelectorAll("article, main, [role='main'], [itemprop='articleBody'], section, div")
    ];
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = scoreCandidate(candidate);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return best || document.body;
  }

  function hasNestedBlockElements(el) {
    for (const child of el.children) {
      if (ignoredTagSet.has(child.tagName) || child.tagName === "BR" || child.tagName === "IMG") continue;
      if (blockTagSet.has(child.tagName)) return true;
    }
    return false;
  }

  function cleanParagraphLine(raw) {
    return String(raw || "")
      .replace(/^[\s\u3000]+/, "")
      .replace(/[\s\u3000]+$/, "")
      .replace(/[ \t]{2,}/g, " ");
  }

  function extractLinesWithRanges(rootNode) {
    const lines = [];
    let currentSegments = [];

    const flushLine = () => {
      if (!currentSegments.length) return;
      const rawText = currentSegments.map((s) => s.text).join("");
      const cleaned = cleanParagraphLine(rawText);
      if (cleaned) {
        // 找到第一个非空白片段和最后一个非空白片段来构建精确 Range
        const first = currentSegments[0];
        const last = currentSegments[currentSegments.length - 1];
        let range = null;
        try {
          range = document.createRange();
          range.setStart(first.node, first.start);
          range.setEnd(last.node, last.end);
        } catch {}
        lines.push({ text: cleaned, range, fallbackNode: rootNode });
      }
      currentSegments = [];
    };

    const traverse = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const val = node.nodeValue || "";
        const regex = /[^\r\n]+|\r?\n/g;
        let match;
        while ((match = regex.exec(val)) !== null) {
          const token = match[0];
          if (token === "\n" || token === "\r\n") {
            flushLine();
          } else if (token.trim() || currentSegments.length > 0) {
            currentSegments.push({
              node,
              start: match.index,
              end: match.index + token.length,
              text: token.replace(/\u00a0/g, " ")
            });
          }
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (ignoredTagSet.has(node.tagName) || isElementHidden(node) || isNoiseElement(node)) return;
      if (node.tagName === "BR") {
        flushLine();
        return;
      }
      const isBlock = blockTagSet.has(node.tagName);
      if (isBlock) flushLine();
      for (const child of node.childNodes) {
        traverse(child);
      }
      if (isBlock) flushLine();
    };

    traverse(rootNode);
    flushLine();
    return lines;
  }

  function getItemViewportRect(item) {
    if (!item) return null;
    if (item.range) {
      try {
        const r = item.range.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0)) return r;
      } catch {}
    }
    if (item.sourceNode?.getBoundingClientRect) {
      try {
        const r = item.sourceNode.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0)) return r;
      } catch {}
    }
    return null;
  }

  // 在一个文本节点区间 [start, end] 内，通过二分查找找到屏幕纵坐标 targetY 所在行的字符比例 charRatio 与该行精确 top
  function findCharLineAtY(textNode, startOffset, endOffset, targetY) {
    const len = endOffset - startOffset;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE || len <= 0) return null;
    const r = document.createRange();
    let lo = startOffset;
    let hi = endOffset - 1;
    let bestOffset = startOffset;
    let bestRect = null;
    let bestDist = Infinity;

    for (let step = 0; step < 9 && lo <= hi; step += 1) {
      const mid = (lo + hi) >> 1;
      try {
        r.setStart(textNode, mid);
        r.setEnd(textNode, Math.min(endOffset, mid + 1));
        const rect = r.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) break;
        const dist = targetY < rect.top ? (rect.top - targetY) : (targetY > rect.bottom ? (targetY - rect.bottom) : 0);
        if (dist < bestDist) {
          bestDist = dist;
          bestOffset = mid;
          bestRect = rect;
        }
        if (rect.top <= targetY && rect.bottom >= targetY) {
          lo = mid + 1;
          break;
        }
        if (rect.bottom < targetY) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      } catch {
        break;
      }
    }
    if (!bestRect) return null;
    return {
      charRatio: (bestOffset - startOffset) / Math.max(1, len),
      lineTop: bestRect.top
    };
  }

  // 给定文本节点区间 [start, end] 和字符比例 charRatio，测量该字符当前在屏幕上的精确 top
  function measureCharTopAtRatio(textNode, startOffset, endOffset, charRatio) {
    const len = endOffset - startOffset;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE || len <= 0) return null;
    const offset = Math.min(endOffset - 1, Math.max(startOffset, startOffset + Math.floor(charRatio * len)));
    try {
      const r = document.createRange();
      r.setStart(textNode, offset);
      r.setEnd(textNode, Math.min(endOffset, offset + 1));
      const rect = r.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) return rect.top;
    } catch {}
    return null;
  }

  function extractBlocks(root) {
    const blocks = [];

    const pushMultiline = (baseType, rawText, sourceNode) => {
      if (baseType === "code") {
        const codeText = String(rawText || "").replace(/^\n+|\n+$/g, "");
        if (codeText.trim()) {
          blocks.push({
            type: "code",
            text: codeText,
            range: null,
            sourceNode: sourceNode || null
          });
        }
        return;
      }

      const lineItems = sourceNode
        ? extractLinesWithRanges(sourceNode)
        : String(rawText || "")
            .split(/\r?\n+/)
            .map(cleanParagraphLine)
            .filter(Boolean)
            .map((text) => ({ text, range: null, fallbackNode: null }));

      if (!lineItems.length) return;

      lineItems.forEach((item) => {
        const line = item.text;
        if (dividerLinePattern.test(line)) {
          blocks.push({ type: "divider", range: item.range, sourceNode: item.fallbackNode || sourceNode || null });
          return;
        }

        let finalType = baseType;
        if (baseType === "paragraph" && line.length <= 42 && chapterTitlePattern.test(line)) {
          finalType = "heading_2";
        }

        const prev = blocks[blocks.length - 1];
        if (prev && prev.type === finalType && prev.text === line) return;

        blocks.push({
          type: finalType,
          text: line,
          range: item.range,
          sourceNode: item.fallbackNode || sourceNode || null
        });
      });
    };

    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const val = node.nodeValue || "";
        if (!cleanParagraphLine(val)) return;
        const regex = /[^\r\n]+/g;
        let match;
        while ((match = regex.exec(val)) !== null) {
          const line = cleanParagraphLine(match[0]);
          if (!line) continue;
          let range = null;
          try {
            range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
          } catch {}
          const finalType = line.length <= 42 && chapterTitlePattern.test(line) ? "heading_2" : "paragraph";
          const prev = blocks[blocks.length - 1];
          if (prev && prev.type === finalType && prev.text === line) continue;
          blocks.push({
            type: finalType,
            text: line,
            range,
            sourceNode: node.parentElement
          });
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (ignoredTagSet.has(node.tagName) || isElementHidden(node) || isNoiseElement(node)) return;

      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        pushMultiline(`heading_${Math.min(Number(tag[1]), 3)}`, textOf(node), node);
      } else if (tag === "p") {
        node.querySelectorAll("img").forEach((img) => walk(img));
        pushMultiline("paragraph", textOf(node), node);
      } else if (tag === "blockquote") {
        pushMultiline("quote", textOf(node), node);
      } else if (tag === "pre") {
        pushMultiline("code", node.innerText || node.textContent || "", node);
      } else if (tag === "li") {
        const list = node.closest("ol, ul");
        pushMultiline(list?.tagName.toLowerCase() === "ol" ? "numbered_list_item" : "bulleted_list_item", "", node);
        node.querySelectorAll(":scope > ul, :scope > ol").forEach((nested) => walk(nested));
        return;
      } else if (tag === "img") {
        const src = node.currentSrc || node.src || node.getAttribute("data-src") || node.getAttribute("data-original") || node.getAttribute("src") || "";
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 48 && rect.height > 0 && rect.height < 48) return;
        if (/^https?:\/\//i.test(src)) {
          blocks.push({ type: "image", url: src, text: node.alt || "", range: null, sourceNode: node });
        }
        return;
      } else if (tag === "hr") {
        blocks.push({ type: "divider", range: null, sourceNode: node });
        return;
      } else if (tag === "figure") {
        const img = node.querySelector("img");
        if (img) walk(img);
        const caption = node.querySelector("figcaption");
        if (caption) pushMultiline("paragraph", textOf(caption), caption);
        return;
      } else if (!hasNestedBlockElements(node)) {
        node.querySelectorAll("img").forEach((img) => walk(img));
        pushMultiline("paragraph", textOf(node), node);
      } else {
        for (const child of node.childNodes) walk(child);
      }
    };
    walk(root);

    return blocks.slice(0, 3000);
  }

  function captureReadingAnchor(items) {
    if (window.scrollY <= 24 || !items.length) {
      return { isAtTop: true, blockIndex: 0 };
    }
    // 视线参考线：距视口顶部 116px 处（位于 56px 顶栏下方第一行舒适阅读区）
    const probeY = 116;
    let bestIdx = 0;
    let bestDist = Infinity;
    let bestRect = null;

    for (let i = 0; i < items.length; i += 1) {
      const r = getItemViewportRect(items[i]);
      if (!r) continue;
      if (r.top <= probeY && r.bottom >= probeY) {
        bestIdx = i;
        bestRect = r;
        bestDist = 0;
        break;
      }
      if (r.bottom >= 56) {
        const dist = Math.abs(r.top - probeY);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
          bestRect = r;
        }
      }
    }

    if (!bestRect) {
      return { isAtTop: false, blockIndex: bestIdx, charRatio: 0, lineTop: probeY };
    }

    const matchedItem = items[bestIdx];
    const itemRange = matchedItem?.range;
    if (itemRange && itemRange.startContainer === itemRange.endContainer && itemRange.startContainer.nodeType === Node.TEXT_NODE) {
      const charHit = findCharLineAtY(
        itemRange.startContainer,
        itemRange.startOffset,
        itemRange.endOffset,
        Math.max(probeY, bestRect.top + 4)
      );
      if (charHit) {
        const clampedLineTop = Math.max(76, Math.min(window.innerHeight * 0.5, charHit.lineTop));
        return {
          isAtTop: false,
          blockIndex: bestIdx,
          charRatio: charHit.charRatio,
          lineTop: clampedLineTop
        };
      }
    }

    const charRatio = bestRect.top < 72 && bestRect.height > 0
      ? Math.min(1, Math.max(0, (probeY - bestRect.top) / bestRect.height))
      : 0;
    const lineTop = bestRect.top >= 72 && bestRect.top <= window.innerHeight * 0.5
      ? bestRect.top
      : probeY;
    return {
      isAtTop: false,
      blockIndex: bestIdx,
      charRatio,
      lineTop
    };
  }

  function getPageData(withSources = false) {
    const root = findArticleRoot();
    let rawItems = extractBlocks(root);
    if (!rawItems.some((block) => block.type === "paragraph" || block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3")) {
      const fallbackLines = extractLinesWithRanges(root);
      rawItems = fallbackLines.map((item) => ({
        type: item.text.length <= 42 && chapterTitlePattern.test(item.text) ? "heading_2" : "paragraph",
        text: item.text,
        range: item.range,
        sourceNode: item.fallbackNode || root
      })).slice(0, 3000);
    }

    const rawTitle = (
      document.querySelector("h1")?.textContent?.trim() ||
      document.querySelector("meta[property='og:title']")?.content?.trim() ||
      document.title ||
      "未命名网页"
    );

    if (rawItems.length > 1 && rawItems[0].text && (rawItems[0].text === rawTitle || rawTitle.startsWith(rawItems[0].text))) {
      rawItems.shift();
    }

    const author = document.querySelector("[rel='author'], [itemprop='author'], .author, .byline")?.textContent?.trim() || "";
    if (author && rawItems.length > 1 && rawItems[0].text === author) {
      rawItems.shift();
    }

    const anchor = captureReadingAnchor(rawItems);
    const cleanBlocks = rawItems.map(({ type, text, url }) => ({
      type,
      ...(text ? { text } : {}),
      ...(url ? { url } : {})
    }));

    return {
      title: rawTitle,
      url: location.href,
      byline: author.slice(0, 300),
      selectionText: String(window.getSelection()?.toString() || "").trim(),
      blocks: cleanBlocks,
      anchor,
      ...(withSources ? { rawItems } : {})
    };
  }

  function appendTextBlock(parent, block, index) {
    const tag = /^heading_/.test(block.type) ? `h${Math.min(Number(block.type.slice(-1)), 3) + 1}`
      : block.type === "quote" ? "blockquote"
      : block.type === "code" ? "pre"
      : block.type === "bulleted_list_item" || block.type === "numbered_list_item" ? "li" : "p";
    const el = document.createElement(tag);
    el.dataset.blockIndex = String(index);
    el.textContent = block.text || "";
    parent.append(el);
    return el;
  }

  function sanitizeFilename(rawTitle) {
    const cleaned = String(rawTitle || "未命名文章")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 96);
    return cleaned || "未命名文章";
  }

  function formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function buildMarkdownContent(article) {
    const title = String(article.title || "未命名网页").trim();
    const url = String(article.url || location.href).trim();
    const byline = String(article.byline || "").trim();
    const clippedAt = formatTimestamp();
    const escYaml = (str) => String(str || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const lines = [
      "---",
      `title: "${escYaml(title)}"`,
      `source: "${escYaml(url)}"`,
      ...(byline ? [`author: "${escYaml(byline)}"`] : []),
      `date: "${clippedAt}"`,
      "---",
      "",
      `# ${title}`,
      "",
      `> 原文链接：[${url}](${url})${byline ? ` · 作者：${byline}` : ""} · 剪藏时间：${clippedAt}`,
      ""
    ];

    let numIndex = 1;
    for (const block of article.blocks || []) {
      if (block.type !== "numbered_list_item") numIndex = 1;
      const text = String(block.text || "").trim();
      if (block.type === "divider") {
        lines.push("---", "");
      } else if (block.type === "image" && block.url) {
        lines.push(`![${text || "图片"}](${block.url})`, "");
      } else if (block.type === "heading_1" && text) {
        lines.push(`## ${text}`, "");
      } else if (block.type === "heading_2" && text) {
        lines.push(`## ${text}`, "");
      } else if (block.type === "heading_3" && text) {
        lines.push(`### ${text}`, "");
      } else if (block.type === "quote" && text) {
        lines.push(
          text.split(/\r?\n/).map((l) => `> ${l}`).join("\n"),
          ""
        );
      } else if (block.type === "code" && text) {
        lines.push("```", block.text, "```", "");
      } else if (block.type === "bulleted_list_item" && text) {
        lines.push(`- ${text}`);
      } else if (block.type === "numbered_list_item" && text) {
        lines.push(`${numIndex++}. ${text}`);
      } else if (text) {
        lines.push(text, "");
      }
    }

    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function triggerMarkdownDownload(article) {
    const markdown = buildMarkdownContent(article);
    const fileName = `${sanitizeFilename(article.title)}.md`;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    a.style.display = "none";
    document.body.append(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(blobUrl);
    }, 1200);
    return { ok: true, fileName };
  }

  function ensureCustomFontsInjected() {
    if (document.querySelector("#nori-reader-font-faces")) return;
    const fontStyle = document.createElement("style");
    fontStyle.id = "nori-reader-font-faces";
    fontStyle.textContent = `
      @font-face {
        font-family: "NoriLXGWWenKai";
        src: local("LXGW WenKai"), local("LXGWWenKai-Regular"), local("霞鹜文楷"), local("霞鶩文楷"), local("LXGW WenKai Screen"),
             url("https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/files/lxgwwenkai-regular.woff2") format("woff2");
        font-display: swap;
      }
      @font-face {
        font-family: "NoriTsangerJinKai";
        src: local("TsangerJinKai03"), local("TsangerJinKai03 W03"), local("TsangerJinKai03-W03"),
             local("仓耳今楷03"), local("仓耳今楷03 W03"),
             local("TsangerJinKai02"), local("TsangerJinKai02 W03"), local("TsangerJinKai02-W03"),
             local("仓耳今楷02"), local("仓耳今楷02 W03"),
             local("TsangerJinKai04"), local("TsangerJinKai04 W03"), local("TsangerJinKai01"), local("仓耳今楷");
        font-display: swap;
      }
    `;
    (document.head || document.documentElement).append(fontStyle);
  }

  async function saveToWebdavFromReader(article, button, state) {
    button.disabled = true;
    const origLabel = button.textContent;
    button.textContent = "上传中…";
    state.textContent = "正在保存到 WebDAV「网页剪藏」文件夹…";
    try {
      const markdown = buildMarkdownContent(article);
      const fileName = `${sanitizeFilename(article.title)}.md`;
      const result = await chrome.runtime.sendMessage({
        type: "NORI_SAVE_TO_WEBDAV",
        clip: {
          title: article.title,
          url: article.url,
          byline: article.byline,
          fileName,
          markdown
        }
      });
      if (!result?.ok) {
        if (result?.needConfig) {
          chrome.runtime.sendMessage({ type: "NORI_OPEN_OPTIONS" });
        }
        throw new Error(result?.error || "WebDAV 保存失败，请检查设置。");
      }
      button.textContent = "已存 WebDAV ✓";
      state.textContent = `已保存到 WebDAV：${result.displayPath || `/网页剪藏/${fileName}`} ✓`;
    } catch (error) {
      button.textContent = origLabel;
      state.textContent = error.message || "WebDAV 保存失败。";
    } finally {
      button.disabled = false;
    }
  }

  async function saveFromReader(article, button, state) {
    if (button.dataset.notionUrl) {
      window.open(button.dataset.notionUrl, "_blank", "noopener,noreferrer");
      return;
    }
    button.disabled = true;
    state.textContent = "正在保存到 Notion…";
    try {
      let result = await chrome.runtime.sendMessage({
        type: "NORI_SAVE_TO_NOTION",
        clip: { title: article.title, url: article.url, blocks: article.blocks, kind: "article", byline: article.byline }
      });
      if (!result?.ok && /登录|连接/.test(result?.error || "")) {
        state.textContent = "正在打开 Notion 登录窗口…";
        const loginRes = await chrome.runtime.sendMessage({ type: "NORI_WEB_LOGIN" });
        if (loginRes?.ok) {
          state.textContent = "已登录 Notion，正在保存正文…";
          result = await chrome.runtime.sendMessage({
            type: "NORI_SAVE_TO_NOTION",
            clip: { title: article.title, url: article.url, blocks: article.blocks, kind: "article", byline: article.byline }
          });
        } else {
          throw new Error(loginRes?.error || "Notion 登录未完成。");
        }
      }
      if (!result?.ok) throw new Error(result?.error || "保存失败，请检查设置。");
      state.textContent = "已保存到 Notion ✓";
      if (result.url) {
        button.dataset.notionUrl = result.url;
        button.textContent = "在 Notion 中打开 ↗";
      } else {
        button.textContent = "已保存到 Notion ✓";
      }
    } catch (error) {
      state.textContent = error.message || "保存失败，请检查 Notion 设置。";
    } finally {
      button.disabled = false;
    }
  }

  function openReader() {
    const existing = document.querySelector("#nori-reader-host");
    if (existing) {
      if (typeof existing.__closeReader === "function") existing.__closeReader();
      else existing.remove();
      return;
    }

    ensureCustomFontsInjected();
    const article = getPageData(true);
    const host = document.createElement("div");
    host.id = "nori-reader-host";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; color: #262521; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
      * { box-sizing: border-box; }
      .screen {
        --bg: #f6f1e4;
        --fg: #26241f;
        --muted: #827e73;
        --border: #e5decb;
        --btn-bg: #fcf9f2;
        --btn-fg: #4a4840;
        --quote-bg: #eee7d5;
        --accent: #385341;
        position: fixed; z-index: 2147483647; inset: 0; overflow-y: auto;
        background: var(--bg); color: var(--fg);
      }
      .screen.theme-green {
        --bg: #dfeee0; --fg: #1e2d22; --muted: #5c7461; --border: #c8dec9; --btn-bg: #ebf5ec; --btn-fg: #2b4230; --quote-bg: #d3e6d5;
      }
      .screen.theme-almond {
        --bg: #f3e8d2; --fg: #2c261d; --muted: #847765; --border: #e2d4b9; --btn-bg: #f9f2e4; --btn-fg: #4d4335; --quote-bg: #eadbc0;
      }
      .screen.theme-sky {
        --bg: #e3eef2; --fg: #1d2a30; --muted: #607680; --border: #cbdce3; --btn-bg: #eef5f8; --btn-fg: #2e424b; --quote-bg: #d6e5eb;
      }
      .screen.theme-rose {
        --bg: #f4eae8; --fg: #2b2221; --muted: #857270; --border: #e4d5d2; --btn-bg: #faf3f2; --btn-fg: #4f3f3d; --quote-bg: #ebdcd9;
      }
      .screen.theme-white {
        --bg: #ffffff; --fg: #1f201d; --muted: #82847c; --border: #eceae4; --btn-bg: #f8f8f6; --btn-fg: #44463f; --quote-bg: #f6f6f3;
      }
      .screen.theme-gray {
        --bg: #eceee9; --fg: #252723; --muted: #767972; --border: #dadcd5; --btn-bg: #f5f6f3; --btn-fg: #434640; --quote-bg: #e2e5de;
      }
      .screen.theme-dark {
        --bg: #1c1d1b; --fg: #dcd9cf; --muted: #949389; --border: #31322e; --btn-bg: #272825; --btn-fg: #d6d3c9; --quote-bg: #242622;
      }
      .progress-track { position: fixed; top: 0; left: 0; right: 0; z-index: 4; height: 2.5px; background: transparent; pointer-events: none; }
      .progress-fill { width: 0%; height: 100%; background: #4b7256; transition: width .08s linear; }
      .bar {
        position: sticky; top: 0; z-index: 3;
        height: 56px;
        border-bottom: 1px solid var(--border);
        background: var(--bg);
      }
      .bar-inner {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        width: min(100% - 48px, 880px); height: 100%; margin: 0 auto;
      }
      .brand { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; color: var(--fg); font: 600 14.5px/1 "Songti SC", Georgia, serif; }
      .brandmark { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: #e3ebde; color: #35513e; font-size: 15px; font-weight: 700; line-height: 1; }
      .brand-text { display: inline-flex; align-items: center; line-height: 1; }
      .progress-label {
        display: inline-flex; align-items: center; justify-content: center;
        height: 22px; min-width: 38px; margin-left: 2px; padding: 0 7px;
        border-radius: 999px; background: var(--quote-bg); color: var(--muted);
        font: 600 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
        font-variant-numeric: tabular-nums;
      }
      .tools { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
      button {
        display: inline-flex; align-items: center; justify-content: center;
        height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px;
        background: var(--btn-bg); color: var(--btn-fg); cursor: pointer;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        white-space: nowrap;
      }
      button:hover { border-color: #9fb29e; }
      button.active { border-color: #4f7058; background: #e6efe3; color: #294331; font-weight: 600; }
      .screen.theme-dark button.active { background: #314436; color: #e2ede4; border-color: #567a60; }
      button:disabled { opacity: .6; cursor: wait; }
      .font-select {
        height: 32px; padding: 0 25px 0 10px; border: 1px solid var(--border); border-radius: 8px;
        appearance: none; -webkit-appearance: none;
        background-color: var(--btn-bg);
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 12 12' fill='none' stroke='%236c6a60' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 4.5L6 8L9.5 4.5'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 8px center;
        color: var(--btn-fg); cursor: pointer;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        outline: none;
      }
      .font-select:hover, .font-select:focus { border-color: #9fb29e; }
      .theme-dots {
        display: inline-flex; align-items: center; gap: 6px;
        height: 32px; padding: 0 9px;
        border: 1px solid var(--border); border-radius: 8px; background: var(--btn-bg);
      }
      .theme-dot { width: 14px; height: 14px; padding: 0; border-radius: 50%; border: 1.5px solid #c5c2b8; cursor: pointer; flex-shrink: 0; }
      .theme-dot.active { border-color: #385341; box-shadow: 0 0 0 1.5px var(--btn-bg), 0 0 0 2.5px #496b53; }
      .dot-sepia { background: #f5efe0; }
      .dot-green { background: #cce6ce; border-color: #9ec0a1; }
      .dot-almond { background: #efe0c1; border-color: #cbb894; }
      .dot-sky { background: #d5e7ee; border-color: #a7c2cd; }
      .dot-rose { background: #f0dedb; border-color: #cfb5b1; }
      .dot-white { background: #ffffff; }
      .dot-gray { background: #dfe3dc; }
      .dot-dark { background: #252623; border-color: #555; }
      .tool-divider { width: 1px; height: 16px; background: var(--border); margin: 0 2px; flex-shrink: 0; }
      .action-btn { padding: 0 10px; font-weight: 550; }
      .save { padding: 0 12px; border-color: #385341; background: #385341; color: #fff; font-weight: 600; }
      .save:hover { background: #2c4534; color: #fff; }
      .close { width: 32px; height: 32px; padding: 0; flex-shrink: 0; }
      .wrap { width: min(100% - 48px, 880px); margin: 0 auto; padding: 48px 0 112px; }
      .article-header { margin-bottom: 38px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
      h1 {
        margin: 0 0 16px; color: inherit;
        font: 600 clamp(26px, 3.4vw, 36px)/1.38 "NoriLXGWWenKai", "LXGW WenKai", "TsangerJinKai03", "Songti SC", "STSong", "Noto Serif CJK SC", Georgia, serif;
        letter-spacing: -.3px;
      }
      .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; color: var(--muted); font: 12px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; }
      .meta a { color: var(--muted); text-decoration: none; border-bottom: 1px dashed var(--border); }
      .meta a:hover { color: var(--fg); }
      .source { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; }
      .body {
        color: var(--fg);
        font-family: "Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif;
        font-size: 19px;
        line-height: 1.95;
        letter-spacing: .02em;
        text-align: justify;
        overflow-wrap: anywhere;
      }
      .body.font-wenkai {
        font-family: "NoriLXGWWenKai", "LXGW WenKai", "LXGWWenKai-Regular", "霞鹜文楷", "霞鶩文楷", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", serif;
      }
      .body.font-jinkai {
        font-family: "NoriTsangerJinKai", "TsangerJinKai03", "TsangerJinKai03 W03", "TsangerJinKai03-W03", "仓耳今楷03", "仓耳今楷03 W03", "TsangerJinKai02", "TsangerJinKai04", "仓耳今楷", "Kaiti SC", "STKaiti", serif;
      }
      .body.font-serif {
        font-family: "Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif;
      }
      .body.font-sans {
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }
      .body p { margin: 0 0 1.05em; }
      .body.indent-on p { text-indent: 2em; }
      .body h2, .body h3, .body h4 {
        margin: 2.1em 0 .9em; padding-left: 12px; border-left: 3.5px solid #597c63;
        color: inherit; font: 600 1.28em/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        text-indent: 0;
      }
      .body h3, .body h4 { font-size: 1.12em; border-left-width: 2.5px; }
      .body blockquote {
        margin: 1.4em 0; padding: 12px 18px; border-left: 3px solid #8ea68b;
        border-radius: 0 8px 8px 0; background: var(--quote-bg); color: var(--muted);
      }
      .body pre {
        overflow-x: auto; margin: 1.4em 0; padding: 15px 17px;
        border: 1px solid var(--border); border-radius: 9px; background: var(--quote-bg);
        font: 13.5px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap;
      }
      .body li { margin: .45em 0 .45em 1.4em; padding-left: .25em; }
      .body img { display: block; max-width: 100%; height: auto; margin: 1.8em auto; border-radius: 8px; }
      .body hr { width: 72px; margin: 2.4em auto; border: 0; border-top: 1.5px solid var(--border); }
      .anchor-flash {
        border-radius: 6px;
        animation: noriAnchorPulse 1.8s ease-out;
      }
      @keyframes noriAnchorPulse {
        0% { background: rgba(105, 148, 114, 0.25); }
        100% { background: transparent; }
      }
      .state { min-height: 22px; margin-top: 24px; color: var(--muted); font: 12px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; }
      .state:empty { display: none; }
      @media (max-width: 680px) {
        .bar { height: 52px; }
        .bar-inner { width: calc(100% - 24px); }
        .brand-text, .indent-btn { display: none; }
        .tools { gap: 4px; }
        .wrap { width: min(100% - 32px, 880px); padding-top: 36px; }
      }
    `;

    let prefs = { theme: "sepia", font: "wenkai", indent: true, fontSize: 19 };
    try {
      const saved = JSON.parse(localStorage.getItem("__nori_reader_prefs__") || "{}");
      prefs = { ...prefs, ...saved };
      if (!["wenkai", "jinkai", "serif", "sans"].includes(prefs.font)) {
        prefs.font = "wenkai";
      }
    } catch {}
    const savePrefs = () => {
      try { localStorage.setItem("__nori_reader_prefs__", JSON.stringify(prefs)); } catch {}
    };

    const screen = document.createElement("div");
    screen.className = `screen theme-${prefs.theme}`;

    const progressTrack = document.createElement("div");
    progressTrack.className = "progress-track";
    const progressFill = document.createElement("div");
    progressFill.className = "progress-fill";
    progressTrack.append(progressFill);

    const bar = document.createElement("header");
    bar.className = "bar";
    const barInner = document.createElement("div");
    barInner.className = "bar-inner";
    const brand = document.createElement("div");
    brand.className = "brand";
    const progressLabel = document.createElement("span");
    progressLabel.className = "progress-label";
    progressLabel.textContent = "0%";
    brand.innerHTML = '<span class="brandmark">阅</span><span class="brand-text">简阅</span>';
    brand.append(progressLabel);

    const tools = document.createElement("div");
    tools.className = "tools";

    const themeDots = document.createElement("div");
    themeDots.className = "theme-dots";
    const themes = [
      { id: "sepia", title: "羊皮暖纸（护眼）", cls: "dot-sepia" },
      { id: "green", title: "豆沙绿（经典护眼）", cls: "dot-green" },
      { id: "almond", title: "杏仁米黄（温和抗疲劳）", cls: "dot-almond" },
      { id: "sky", title: "海天青蓝（清爽护眼）", cls: "dot-sky" },
      { id: "rose", title: "浅粉藕荷（柔和暖调）", cls: "dot-rose" },
      { id: "gray", title: "晨雾静灰（墨水屏）", cls: "dot-gray" },
      { id: "white", title: "纯白日间", cls: "dot-white" },
      { id: "dark", title: "夜间深色", cls: "dot-dark" }
    ];
    const dotButtons = themes.map((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `theme-dot ${t.cls} ${prefs.theme === t.id ? "active" : ""}`;
      btn.title = t.title;
      btn.addEventListener("click", () => {
        prefs.theme = t.id;
        screen.className = `screen theme-${prefs.theme}`;
        dotButtons.forEach((b, i) => b.classList.toggle("active", themes[i].id === prefs.theme));
        savePrefs();
      });
      themeDots.append(btn);
      return btn;
    });

    const fontSelect = document.createElement("select");
    fontSelect.className = "font-select";
    fontSelect.title = "选择阅读字体";
    const fontOptions = [
      { id: "wenkai", label: "霞鹜文楷" },
      { id: "jinkai", label: "仓耳今楷" },
      { id: "serif", label: "经典宋体" },
      { id: "sans", label: "苹果黑体" }
    ];
    fontOptions.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.label;
      if (prefs.font === f.id) opt.selected = true;
      fontSelect.append(opt);
    });

    const indentBtn = document.createElement("button");
    indentBtn.className = `indent-btn ${prefs.indent ? "active" : ""}`;
    indentBtn.textContent = "缩进";
    indentBtn.title = "切换段落首行缩进";

    const fontDown = document.createElement("button"); fontDown.textContent = "A−"; fontDown.title = "缩小字号";
    const fontUp = document.createElement("button"); fontUp.textContent = "A+"; fontUp.title = "放大字号";

    const sep = document.createElement("span");
    sep.className = "tool-divider";

    const exportMdBtn = document.createElement("button");
    exportMdBtn.className = "action-btn";
    exportMdBtn.textContent = "导出 MD";
    exportMdBtn.title = "直接将当前文章导出为本地 Markdown (.md) 文件";

    const webdavBtn = document.createElement("button");
    webdavBtn.className = "action-btn";
    webdavBtn.textContent = "存 WebDAV";
    webdavBtn.title = "将当前文章以 Markdown 格式保存到 WebDAV「网页剪藏」目录";

    const save = document.createElement("button"); save.className = "save"; save.textContent = "保存到 Notion";
    const close = document.createElement("button");
    close.className = "close";
    close.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    close.title = "退出阅读模式 (Esc)";
    tools.append(themeDots, fontSelect, indentBtn, fontDown, fontUp, sep, exportMdBtn, webdavBtn, save, close);
    barInner.append(brand, tools);
    bar.append(barInner);

    const wrap = document.createElement("main"); wrap.className = "wrap";
    const headerBox = document.createElement("div"); headerBox.className = "article-header";
    const title = document.createElement("h1"); title.textContent = article.title;
    const meta = document.createElement("div"); meta.className = "meta";
    if (article.byline) { const author = document.createElement("span"); author.textContent = `✍️ ${article.byline}`; meta.append(author); }
    let hostLabel = "";
    try {
      hostLabel = new URL(article.url).hostname;
    } catch {}
    if (hostLabel) {
      const sourceLink = document.createElement("a");
      sourceLink.className = "source";
      sourceLink.href = article.url;
      sourceLink.target = "_blank";
      sourceLink.textContent = `🔗 ${hostLabel}`;
      meta.append(sourceLink);
    }
    const countSpan = document.createElement("span");
    const totalChars = article.blocks.reduce((sum, b) => sum + (b.text ? b.text.length : 0), 0);
    countSpan.textContent = `📖 约 ${totalChars.toLocaleString()} 字`;
    meta.append(countSpan);
    headerBox.append(title, meta);

    const body = document.createElement("article");
    const applyBodyClasses = () => {
      body.className = `body font-${prefs.font} ${prefs.indent ? "indent-on" : ""}`;
    };
    applyBodyClasses();
    body.style.fontSize = `${prefs.fontSize}px`;

    article.blocks.forEach((block, index) => {
      if (block.type === "image") {
        const img = document.createElement("img");
        img.src = block.url;
        img.alt = block.text || "";
        img.loading = "lazy";
        img.dataset.blockIndex = String(index);
        body.append(img);
      } else if (block.type === "divider") {
        const hr = document.createElement("hr");
        hr.dataset.blockIndex = String(index);
        body.append(hr);
      } else {
        appendTextBlock(body, block, index);
      }
    });

    const state = document.createElement("div"); state.className = "state";
    wrap.append(headerBox, body, state);
    screen.append(progressTrack, bar, wrap);
    shadow.append(style, screen);
    document.documentElement.append(host);

    const updateProgress = () => {
      const max = Math.max(1, screen.scrollHeight - screen.clientHeight);
      const pct = Math.min(100, Math.max(0, Math.round((screen.scrollTop / max) * 100)));
      progressFill.style.width = `${pct}%`;
      progressLabel.textContent = `${pct}%`;
    };
    screen.addEventListener("scroll", updateProgress, { passive: true });

    const applyInitialAlignment = () => {
      const anchor = article.anchor;
      if (!anchor || anchor.isAtTop) {
        screen.scrollTop = 0;
        updateProgress();
        return;
      }
      const targetEl = body.querySelector(`[data-block-index="${anchor.blockIndex}"]`);
      if (targetEl) {
        const desiredLineTop = anchor.lineTop || 116;
        const textChild = targetEl.firstChild;
        if (textChild && textChild.nodeType === Node.TEXT_NODE && (textChild.nodeValue || "").length > 0) {
          const charTop = measureCharTopAtRatio(
            textChild,
            0,
            textChild.nodeValue.length,
            anchor.charRatio || 0
          );
          if (typeof charTop === "number") {
            screen.scrollTop += (charTop - desiredLineTop);
            updateProgress();
            return;
          }
        }
        const readerRect = targetEl.getBoundingClientRect();
        const fallbackTop = desiredLineTop - (anchor.charRatio || 0) * readerRect.height;
        screen.scrollTop += (readerRect.top - fallbackTop);
      }
      updateProgress();
    };

    // 在同一渲染帧同步完成位置对齐，杜绝先跳页首再跳回的闪烁
    applyInitialAlignment();
    let initialReaderScrollTop = screen.scrollTop;
    requestAnimationFrame(() => {
      applyInitialAlignment();
      initialReaderScrollTop = screen.scrollTop;
    });

    const closeReaderAndSync = () => {
      const userScrolledDistance = Math.abs(screen.scrollTop - initialReaderScrollTop);
      const isReaderAtTop = screen.scrollTop <= 20;

      // 如果用户在阅读模式里没有滚动过，直接移除阅读层，原网页保持原位 1 像素不动
      if (userScrolledDistance < 12) {
        document.removeEventListener("keydown", keyHandler, true);
        host.remove();
        return;
      }

      if (isReaderAtTop) {
        document.removeEventListener("keydown", keyHandler, true);
        host.remove();
        window.scrollTo({ top: 0, behavior: "instant" });
        return;
      }

      // 在移除阅读层前，先精确定位阅读模式当前视口上方正在读的那一行字 (matchedIdx + charRatio + lineTop)
      const probeY = 116;
      const rendered = body.querySelectorAll("[data-block-index]");
      let matchedIdx = -1;
      let charRatio = 0;
      let desiredLineTop = probeY;

      for (const el of rendered) {
        const r = el.getBoundingClientRect();
        if (r.bottom >= 64) {
          matchedIdx = Number(el.dataset.blockIndex);
          const textChild = el.firstChild;
          if (textChild && textChild.nodeType === Node.TEXT_NODE && (textChild.nodeValue || "").length > 0) {
            const hit = findCharLineAtY(
              textChild,
              0,
              textChild.nodeValue.length,
              Math.max(probeY, r.top + 4)
            );
            if (hit) {
              charRatio = hit.charRatio;
              desiredLineTop = Math.max(76, Math.min(window.innerHeight * 0.5, hit.lineTop));
              break;
            }
          }
          if (r.top >= 72 && r.top <= window.innerHeight * 0.5) {
            charRatio = 0;
            desiredLineTop = r.top;
          } else {
            charRatio = r.height > 0 ? Math.min(1, Math.max(0, (probeY - r.top) / r.height)) : 0;
            desiredLineTop = probeY;
          }
          break;
        }
      }

      document.removeEventListener("keydown", keyHandler, true);
      host.remove();

      if (matchedIdx >= 0 && article.rawItems?.[matchedIdx]) {
        const rawItem = article.rawItems[matchedIdx];
        const itemRange = rawItem?.range;
        if (itemRange && itemRange.startContainer === itemRange.endContainer && itemRange.startContainer.nodeType === Node.TEXT_NODE) {
          const origCharTop = measureCharTopAtRatio(
            itemRange.startContainer,
            itemRange.startOffset,
            itemRange.endOffset,
            charRatio
          );
          if (typeof origCharTop === "number") {
            window.scrollBy({ top: origCharTop - desiredLineTop, behavior: "instant" });
            return;
          }
        }
        const origRect = getItemViewportRect(rawItem);
        if (origRect) {
          const targetTop = desiredLineTop - charRatio * origRect.height;
          window.scrollBy({ top: origRect.top - targetTop, behavior: "instant" });
        }
      }
    };

    host.__closeReader = closeReaderAndSync;
    const keyHandler = (event) => { if (event.key === "Escape") close.click(); };
    close.addEventListener("click", closeReaderAndSync);
    exportMdBtn.addEventListener("click", () => {
      const res = triggerMarkdownDownload(article);
      exportMdBtn.textContent = "已导出 MD ✓";
      state.textContent = `已导出本地文件：${res.fileName} ✓`;
      setTimeout(() => { exportMdBtn.textContent = "导出 MD"; }, 2200);
    });
    webdavBtn.addEventListener("click", () => saveToWebdavFromReader(article, webdavBtn, state));
    save.addEventListener("click", () => saveFromReader(article, save, state));
    fontSelect.addEventListener("change", () => {
      prefs.font = fontSelect.value;
      applyBodyClasses();
      savePrefs();
    });
    indentBtn.addEventListener("click", () => {
      prefs.indent = !prefs.indent;
      indentBtn.classList.toggle("active", prefs.indent);
      body.classList.toggle("indent-on", prefs.indent);
      savePrefs();
    });
    fontDown.addEventListener("click", () => {
      prefs.fontSize = Math.max(15, prefs.fontSize - 1);
      body.style.fontSize = `${prefs.fontSize}px`;
      savePrefs();
    });
    fontUp.addEventListener("click", () => {
      prefs.fontSize = Math.min(28, prefs.fontSize + 1);
      body.style.fontSize = `${prefs.fontSize}px`;
      savePrefs();
    });
    document.addEventListener("keydown", keyHandler, true);
  }

  function handle(message) {
    if (message?.type === "NORI_PING") return { ok: true };
    if (message?.type === "NORI_GET_PAGE") return getPageData();
    if (message?.type === "NORI_EXPORT_MARKDOWN") {
      const page = getPageData();
      if (message.mode === "selection") {
        const selected = page.selectionText?.trim();
        if (!selected) throw new Error("请先在网页中选中要导出的文字。");
        page.blocks = selected.split(/\n{2,}/).map((text) => ({ type: "paragraph", text: text.trim() })).filter((b) => b.text);
      }
      if (!page.blocks?.length) throw new Error("没有找到可导出的正文内容。");
      return triggerMarkdownDownload(page);
    }
    if (message?.type === "NORI_TOGGLE_READER") { openReader(); return { ok: true }; }
    return undefined;
  }

  window.__noriReaderMessageHandler = (message, _sender, sendResponse) => {
    try { sendResponse(handle(message)); }
    catch (error) { sendResponse({ error: error.message || "页面内容读取失败。" }); }
  };
  chrome.runtime.onMessage.addListener(window.__noriReaderMessageHandler);
  window.__noriReader = true;
})();
