const badge = document.querySelector("#connection-badge");
const workspaceEl = document.querySelector("#workspace");
const oauthStatus = document.querySelector("#oauth-status");
const databaseSelect = document.querySelector("#database-select");
const refreshTargetsBtn = document.querySelector("#refresh-targets");
const connectButton = document.querySelector("#connect-button");
const autoCreateButton = document.querySelector("#auto-create-button");
const disconnectButton = document.querySelector("#disconnect-button");
const webdavBadge = document.querySelector("#webdav-badge");
const webdavForm = document.querySelector("#webdav-form");
const webdavUrlInput = document.querySelector("#webdav-url");
const webdavFolderInput = document.querySelector("#webdav-folder");
const webdavUsernameInput = document.querySelector("#webdav-username");
const webdavPasswordInput = document.querySelector("#webdav-password");
const webdavSaveBtn = document.querySelector("#webdav-save-btn");
const webdavClearBtn = document.querySelector("#webdav-clear-btn");
const webdavStatus = document.querySelector("#webdav-status");

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `status ${kind}`;
}

async function getSettings() {
  const { noriSettings } = await chrome.storage.local.get("noriSettings");
  return noriSettings || {};
}

function renderTargetOptions(targets = [], selectedId = "") {
  databaseSelect.replaceChildren();
  if (!targets.length) {
    databaseSelect.append(new Option("暂无可用页面或数据库（可点上方「✨ 自动创建」）", ""));
    databaseSelect.disabled = true;
    return;
  }
  for (const item of targets) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.title;
    option.dataset.kind = item.kind || "database";
    option.dataset.collectionId = item.collectionId || "";
    option.dataset.titleProperty = item.titleProperty || "Name";
    option.dataset.urlProperty = item.urlProperty || "";
    databaseSelect.append(option);
  }
  databaseSelect.disabled = false;
  if (selectedId && targets.some((t) => t.id === selectedId)) {
    databaseSelect.value = selectedId;
  }
}

function renderWebdavSettings(settings = {}) {
  webdavUrlInput.value = settings.webdavUrl || "https://dav.jianguoyun.com/dav/";
  webdavFolderInput.value = settings.webdavFolder || "网页剪藏";
  webdavUsernameInput.value = settings.webdavUsername || "";
  webdavPasswordInput.value = settings.webdavPassword || "";

  if (settings.webdavUrl && settings.webdavUsername && settings.webdavPassword) {
    webdavBadge.textContent = "已配置";
    webdavBadge.classList.add("connected");
    webdavClearBtn.classList.remove("hidden");
  } else {
    webdavBadge.textContent = "未配置";
    webdavBadge.classList.remove("connected");
    webdavClearBtn.classList.add("hidden");
  }
}

async function renderSettings() {
  const statusRes = await chrome.runtime.sendMessage({
    type: "NORI_GET_STATUS",
    autoDetectWeb: true,
    includeTargets: true
  });

  const settings = statusRes?.settings || await getSettings();
  renderWebdavSettings(settings);

  if (statusRes?.ok && statusRes.connected) {
    badge.textContent = "已连接";
    badge.classList.add("connected");

    const userSuffix = statusRes.userName ? `（${statusRes.userName}）` : "";
    workspaceEl.textContent = `🟢 当前工作区：${statusRes.workspaceName || "Notion"}${userSuffix}`;
    workspaceEl.classList.remove("hidden");

    connectButton.textContent = "重新登录 / 切换账号";
    autoCreateButton.classList.remove("hidden");
    disconnectButton.classList.remove("hidden");
    refreshTargetsBtn.disabled = false;

    renderTargetOptions(statusRes.targets || [], settings.databaseId);
    const currentTarget = (statusRes.targets || []).find((t) => t.id === databaseSelect.value);
    if (currentTarget) {
      setStatus(oauthStatus, "", "");
    } else {
      setStatus(oauthStatus, "已连接 Notion！请选择保存位置或点击「✨ 自动创建『网页剪藏』页」。", "success");
    }
  } else {
    badge.textContent = "未连接";
    badge.classList.remove("connected");
    workspaceEl.classList.add("hidden");
    connectButton.textContent = "直接登录 Notion 账号";
    autoCreateButton.classList.add("hidden");
    disconnectButton.classList.add("hidden");
    databaseSelect.replaceChildren(new Option("登录 Notion 后自动加载页面与数据库", ""));
    databaseSelect.disabled = true;
    refreshTargetsBtn.disabled = true;
    setStatus(oauthStatus, "点击上方「直接登录 Notion 账号」即可一键登录并自动绑定。", "");
  }
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  setStatus(oauthStatus, "正在连接 Notion 账号（如未登录会自动弹出登录窗口）…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "NORI_WEB_LOGIN" });
    if (!res?.ok) throw new Error(res?.error || "Notion 登录失败。");
    await renderSettings();
    setStatus(oauthStatus, "🎉 Notion 登录成功！已自动为你选好保存位置。", "success");
  } catch (error) {
    setStatus(oauthStatus, error.message || "Notion 登录失败。", "error");
  } finally {
    connectButton.disabled = false;
  }
});

autoCreateButton.addEventListener("click", async () => {
  autoCreateButton.disabled = true;
  setStatus(oauthStatus, "正在 Notion 中为你自动创建「📚 网页剪藏」…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "NORI_CREATE_CLIP_DATABASE" });
    if (!res?.ok) throw new Error(res?.error || "创建失败。");
    renderTargetOptions(res.targets || [], res.databaseId);
    setStatus(oauthStatus, `✨ 已自动创建并选中「${res.title}」！现在可以直接去网页剪藏了。`, "success");
  } catch (error) {
    setStatus(oauthStatus, error.message || "自动创建失败。", "error");
  } finally {
    autoCreateButton.disabled = false;
  }
});

databaseSelect.addEventListener("change", async () => {
  const selected = databaseSelect.selectedOptions[0];
  if (!selected?.value) return;
  const settings = await getSettings();
  await chrome.storage.local.set({
    noriSettings: {
      ...settings,
      databaseId: selected.value,
      targetKind: selected.dataset.kind || "database",
      targetTitle: selected.textContent || "",
      collectionId: selected.dataset.collectionId || "",
      titleProperty: selected.dataset.titleProperty || "Name",
      urlProperty: selected.dataset.urlProperty || ""
    }
  });
  setStatus(oauthStatus, `已将剪藏位置设为「${selected.textContent}」。`, "success");
});

refreshTargetsBtn.addEventListener("click", async () => {
  refreshTargetsBtn.disabled = true;
  setStatus(oauthStatus, "正在刷新 Notion 页面与数据库列表…");
  try {
    await renderSettings();
    const currentTarget = databaseSelect.selectedOptions[0];
    if (currentTarget?.value) {
      setStatus(oauthStatus, `列表已刷新，当前保存到「${currentTarget.textContent}」。`, "success");
    }
  } finally {
    refreshTargetsBtn.disabled = false;
  }
});

disconnectButton.addEventListener("click", async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({
    noriSettings: {
      webdavUrl: settings.webdavUrl || "",
      webdavUsername: settings.webdavUsername || "",
      webdavPassword: settings.webdavPassword || "",
      webdavFolder: settings.webdavFolder || "网页剪藏",
      webdavConnected: Boolean(settings.webdavConnected)
    }
  });
  databaseSelect.replaceChildren(new Option("登录 Notion 后自动加载页面与数据库", ""));
  databaseSelect.disabled = true;
  refreshTargetsBtn.disabled = true;
  badge.textContent = "未连接";
  badge.classList.remove("connected");
  workspaceEl.classList.add("hidden");
  autoCreateButton.classList.add("hidden");
  disconnectButton.classList.add("hidden");
  connectButton.textContent = "直接登录 Notion 账号";
  setStatus(oauthStatus, "已断开 Notion 连接。", "success");
});

webdavForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  webdavSaveBtn.disabled = true;
  const config = {
    webdavUrl: webdavUrlInput.value.trim(),
    webdavFolder: webdavFolderInput.value.trim() || "网页剪藏",
    webdavUsername: webdavUsernameInput.value.trim(),
    webdavPassword: webdavPasswordInput.value.trim()
  };
  setStatus(webdavStatus, `正在连接 WebDAV 并检查/创建「${config.webdavFolder}」文件夹…`);
  try {
    const res = await chrome.runtime.sendMessage({
      type: "NORI_TEST_WEBDAV",
      config
    });
    if (!res?.ok) throw new Error(res?.error || "WebDAV 连接失败。");
    webdavBadge.textContent = "已连接";
    webdavBadge.classList.add("connected");
    webdavClearBtn.classList.remove("hidden");
    setStatus(webdavStatus, `🎉 WebDAV 连接成功！已备好目录「${res.displayPath || `/${config.webdavFolder}`}」，可随时一键存入。`, "success");
  } catch (error) {
    setStatus(webdavStatus, error.message || "WebDAV 连接测试失败。", "error");
  } finally {
    webdavSaveBtn.disabled = false;
  }
});

webdavClearBtn.addEventListener("click", async () => {
  const settings = await getSettings();
  const next = { ...settings };
  delete next.webdavUrl;
  delete next.webdavUsername;
  delete next.webdavPassword;
  delete next.webdavFolder;
  delete next.webdavConnected;
  await chrome.storage.local.set({ noriSettings: next });
  webdavPasswordInput.value = "";
  webdavBadge.textContent = "未配置";
  webdavBadge.classList.remove("connected");
  webdavClearBtn.classList.add("hidden");
  setStatus(webdavStatus, "已清除 WebDAV 配置。", "success");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.noriSettings) {
    const next = changes.noriSettings.newValue;
    const prev = changes.noriSettings.oldValue;
    if (next?.workspaceId && next?.workspaceId !== prev?.workspaceId) {
      renderSettings();
    }
  }
});

renderSettings();
