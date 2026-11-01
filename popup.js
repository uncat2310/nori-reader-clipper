const statusEl = document.querySelector("#status");
const connectionEl = document.querySelector("#connection");
const connectionDot = document.querySelector(".connection-dot");
const quickLoginBox = document.querySelector("#quick-login-box");
const quickLoginBtn = document.querySelector("#quick-login-btn");
const targetRow = document.querySelector("#target-row");
const popupTargetSelect = document.querySelector("#popup-target");
const reloginLink = document.querySelector("#relogin-link");

function setStatus(message, kind = "", linkUrl = "") {
  statusEl.textContent = "";
  statusEl.className = `status ${kind}`;
  if (!message) return;
  const span = document.createElement("span");
  span.textContent = message;
  statusEl.append(span);
  if (linkUrl) {
    const space = document.createTextNode(" ");
    const a = document.createElement("a");
    a.href = linkUrl;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = "在 Notion 中打开 ↗";
    statusEl.append(space, a);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("当前标签页不可用。");
  return tab;
}

async function sendToPage(message) {
  const tab = await getActiveTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "NORI_PING" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

function populateTargets(targets = [], selectedId = "") {
  popupTargetSelect.replaceChildren();
  if (!targets.length) {
    targetRow.classList.add("hidden");
    return;
  }
  for (const item of targets) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.title;
    opt.dataset.kind = item.kind || "database";
    opt.dataset.collectionId = item.collectionId || "";
    opt.dataset.titleProperty = item.titleProperty || "Name";
    opt.dataset.urlProperty = item.urlProperty || "";
    popupTargetSelect.append(opt);
  }
  if (selectedId && targets.some((t) => t.id === selectedId)) {
    popupTargetSelect.value = selectedId;
  }
  targetRow.classList.remove("hidden");
}

async function readSettings() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "NORI_GET_STATUS",
      autoDetectWeb: true,
      includeTargets: true
    });
    if (res?.ok && res.connected) {
      const ws = res.workspaceName ? ` · ${res.workspaceName}` : "";
      connectionEl.textContent = `已连接 Notion${ws}`;
      connectionDot.classList.add("ready");
      quickLoginBox.classList.add("hidden");
      reloginLink.classList.remove("hidden");
      populateTargets(res.targets || [], res.settings?.databaseId);
      return;
    }
  } catch {
    // Fallback below
  }
  connectionEl.textContent = "尚未连接 Notion";
  connectionDot.classList.remove("ready");
  quickLoginBox.classList.remove("hidden");
  targetRow.classList.add("hidden");
  reloginLink.classList.remove("hidden");
}

popupTargetSelect.addEventListener("change", async () => {
  const opt = popupTargetSelect.selectedOptions[0];
  if (!opt?.value) return;
  const { noriSettings } = await chrome.storage.local.get("noriSettings");
  await chrome.storage.local.set({
    noriSettings: {
      ...(noriSettings || {}),
      databaseId: opt.value,
      targetKind: opt.dataset.kind || "database",
      targetTitle: opt.textContent || "",
      collectionId: opt.dataset.collectionId || "",
      titleProperty: opt.dataset.titleProperty || "Name",
      urlProperty: opt.dataset.urlProperty || ""
    }
  });
  setStatus(`将保存到「${opt.textContent}」`, "success");
});

quickLoginBtn.addEventListener("click", async () => {
  quickLoginBtn.disabled = true;
  setStatus("正在打开 Notion 登录…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "NORI_WEB_LOGIN" });
    if (!res?.ok) throw new Error(res?.error || "Notion 登录未完成。");
    setStatus("Notion 登录成功，可以直接剪藏了！", "success");
    await readSettings();
  } catch (error) {
    setStatus(error.message || "登录失败，也可点右上角 ⚙ 使用密钥连接。", "error");
  } finally {
    quickLoginBtn.disabled = false;
  }
});

document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
reloginLink.addEventListener("click", () => chrome.runtime.openOptionsPage());

document.querySelector("#reader").addEventListener("click", async () => {
  try {
    await sendToPage({ type: "NORI_TOGGLE_READER" });
    window.close();
  } catch (error) {
    setStatus(error.message || "此页面无法打开阅读模式。", "error");
  }
});

async function clip(mode) {
  setStatus(mode === "selection" ? "正在保存选中文本…" : "正在整理正文…");
  try {
    const page = await sendToPage({ type: "NORI_GET_PAGE" });
    let blocks;
    let title = page.title;
    let kind;
    if (mode === "selection") {
      const selected = page.selectionText?.trim();
      if (!selected) throw new Error("请先在网页中选中要保存的文字。");
      blocks = selected.split(/\n{2,}/).map((text) => ({ type: "paragraph", text: text.trim() })).filter((block) => block.text);
      blocks.unshift({ type: "paragraph", text: "选中文本摘录" });
      kind = "selection";
    } else {
      blocks = page.blocks;
      if (!blocks?.length) throw new Error("没有找到可保存的正文内容。");
      kind = "article";
    }
    const result = await chrome.runtime.sendMessage({
      type: "NORI_SAVE_TO_NOTION",
      clip: { title, url: page.url, blocks, kind, byline: page.byline }
    });
    if (!result?.ok) throw new Error(result?.error || "保存失败，请检查 Notion 设置。");
    setStatus("已保存到 Notion ✓", "success", result.url || "");
    await readSettings();
  } catch (error) {
    setStatus(error.message || "保存失败。", "error");
  }
}

document.querySelector("#clip-selection").addEventListener("click", () => clip("selection"));
document.querySelector("#clip-article").addEventListener("click", () => clip("article"));

document.querySelector("#export-md").addEventListener("click", async () => {
  setStatus("正在生成并下载 Markdown 文件…");
  try {
    const res = await sendToPage({ type: "NORI_EXPORT_MARKDOWN", mode: "article" });
    if (res?.error) throw new Error(res.error);
    setStatus(`已导出本地文件：${res?.fileName || "文章.md"} ✓`, "success");
  } catch (error) {
    setStatus(error.message || "导出 Markdown 失败。", "error");
  }
});

document.querySelector("#save-webdav").addEventListener("click", async () => {
  setStatus("正在保存到 WebDAV「网页剪藏」目录…");
  try {
    const page = await sendToPage({ type: "NORI_GET_PAGE" });
    if (!page?.blocks?.length) throw new Error("没有找到可保存的正文内容。");
    const result = await chrome.runtime.sendMessage({
      type: "NORI_SAVE_TO_WEBDAV",
      clip: {
        title: page.title,
        url: page.url,
        byline: page.byline,
        blocks: page.blocks
      }
    });
    if (!result?.ok) {
      if (result?.needConfig) {
        chrome.runtime.openOptionsPage();
      }
      throw new Error(result?.error || "保存到 WebDAV 失败，请检查设置。");
    }
    setStatus(`已存入 WebDAV：${result.displayPath || `/网页剪藏/${result.fileName}`} ✓`, "success");
  } catch (error) {
    setStatus(error.message || "保存到 WebDAV 失败。", "error");
  }
});

readSettings();
