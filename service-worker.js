const NOTION_VERSION = "2022-06-28";
const AUTO_TARGET_ID = "__auto_create__";
const DNR_COOKIE_RULE_ID = 1001;
const DNR_WEBDAV_RULE_ID = 1002;

function splitText(text, limit = 1800) {
  const chars = Array.from(String(text || ""));
  const parts = [];
  for (let i = 0; i < chars.length; i += limit) parts.push(chars.slice(i, i + limit).join(""));
  return parts.length ? parts : [""];
}

function richText(text, link) {
  return splitText(text).map((content) => ({
    type: "text",
    text: { content, ...(link ? { link: { url: link } } : {}) }
  }));
}

function toNotionBlocks(blocks, url, byline) {
  const result = [{
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [...richText("原文："), ...richText(url, url)] }
  }];
  if (byline) result.push({ object: "block", type: "paragraph", paragraph: { rich_text: richText(`作者：${byline}`) } });

  for (const item of blocks || []) {
    if (item.type === "image" && /^https?:\/\//i.test(item.url || "")) {
      result.push({ object: "block", type: "image", image: {
        type: "external", external: { url: item.url },
        ...(item.text ? { caption: richText(item.text) } : {})
      } });
      continue;
    }
    if (item.type === "divider") {
      result.push({ object: "block", type: "divider", divider: {} });
      continue;
    }
    const type = ["heading_1", "heading_2", "heading_3", "quote", "bulleted_list_item", "numbered_list_item", "code"].includes(item.type)
      ? item.type : "paragraph";
    splitText(item.text || "").forEach((part, index) => {
      const blockType = index > 0 && type.startsWith("heading_") ? "paragraph" : type;
      result.push({
        object: "block",
        type: blockType,
        [blockType]: { rich_text: richText(part), ...(blockType === "code" ? { language: "plain text" } : {}) }
      });
    });
  }
  return result;
}

async function getStoredSettings() {
  const { noriSettings } = await chrome.storage.local.get("noriSettings");
  return noriSettings || {};
}

async function saveStoredSettings(patch) {
  const current = await getStoredSettings();
  const updated = { ...current, ...patch };
  await chrome.storage.local.set({ noriSettings: updated });
  return updated;
}

// ============================================================================
// 1. Notion Web Session 直连模式（免 Token / 免 Worker，直接复用浏览器 Notion 登录）
// ============================================================================

function unwrapRecord(record) {
  if (!record) return null;
  let val = record.value ?? record;
  if (val && typeof val === "object" && "value" in val && val.value && typeof val.value === "object") {
    if (val.value.id || val.value.type || val.value.name || val.value.schema || val.value.email || val.value.properties) {
      val = val.value;
    }
  }
  return val;
}

function readWebTextProp(prop) {
  if (!Array.isArray(prop)) return "";
  return prop.map((seg) => (Array.isArray(seg) ? seg[0] || "" : "")).join("").trim();
}

function formatUuid(raw) {
  const clean = String(raw || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  if (clean.length !== 32) return "";
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20, 32)}`;
}

function extractBlockIdFromNotionUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const pParam = u.searchParams.get("p");
    if (pParam) {
      const id = formatUuid(pParam.slice(-32));
      if (id) return id;
    }
    const segs = u.pathname.split("/").filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const match = segs[i].match(/([0-9a-f]{32})$/i);
      if (match) return formatUuid(match[1]);
    }
  } catch {}
  return "";
}

function cleanNotionTabTitle(rawTitle) {
  let t = String(rawTitle || "").trim();
  t = t.replace(/^\(\d+\)\s*/, "");
  t = t.replace(/\s*[|–—-]\s*Notion$/i, "");
  if (t.includes(" | ")) {
    t = t.split(" | ")[0].trim();
  }
  return t || "当前打开的 Notion 页面";
}

async function getNotionWebCookies() {
  try {
    const allBasic = await chrome.cookies.getAll({}).catch(() => []);
    const storeCookies = [];
    if (chrome.cookies.getAllCookieStores) {
      const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
      for (const s of stores) {
        const list = await chrome.cookies.getAll({ storeId: s.id }).catch(() => []);
        storeCookies.push(...list);
      }
    }
    const allCookies = [...allBasic, ...storeCookies].filter(
      (c) => c?.domain && (c.domain.includes("notion.so") || c.domain.includes("notion.com"))
    );
    if (!allCookies.length) return null;
    const tokenCookie = allCookies.find((c) => c.name === "token_v2" && c.value);
    const userCookie = allCookies.find((c) => c.name === "notion_user_id" && c.value);
    const dedup = new Map();
    for (const c of allCookies) {
      if (c.name && c.value && !dedup.has(c.name)) dedup.set(c.name, c.value);
    }
    const cookieHeader = Array.from(dedup.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    return {
      tokenV2: tokenCookie?.value || "",
      userId: userCookie?.value || "",
      cookieHeader
    };
  } catch {
    return null;
  }
}

async function ensureWebCookieRule(cookieHeader, userId) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const requestHeaders = [
    { header: "Origin", operation: "set", value: "https://www.notion.so" },
    { header: "Referer", operation: "set", value: "https://www.notion.so/" }
  ];
  if (cookieHeader) {
    requestHeaders.push({ header: "Cookie", operation: "set", value: cookieHeader });
  }
  if (userId) {
    requestHeaders.push({ header: "x-notion-active-user-header", operation: "set", value: userId });
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_COOKIE_RULE_ID],
    addRules: [{
      id: DNR_COOKIE_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders
      },
      condition: {
        urlFilter: "/api/v3/",
        requestDomains: ["notion.so", "www.notion.so", "notion.com", "www.notion.com", "app.notion.com"],
        resourceTypes: ["xmlhttprequest", "other"]
      }
    }]
  });
}

async function executeInNotionTab(tabId, endpoint, body, userId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (ep, reqBody, activeUid) => {
      try {
        const headers = { "Content-Type": "application/json" };
        if (activeUid) headers["x-notion-active-user-header"] = activeUid;
        const apiOrigin = location.hostname === "notion.so" ? "https://www.notion.so" : location.origin;
        const response = await fetch(`${apiOrigin}/api/v3/${ep}`, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(reqBody || {})
        });
        const payload = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, payload };
      } catch (err) {
        return { ok: false, status: 0, error: err?.message || "fetch failed" };
      }
    },
    args: [endpoint, body, userId || ""]
  });
  return results?.[0]?.result || null;
}

async function findOpenNotionTabs() {
  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const notionTabs = [];
  for (const t of allTabs) {
    const url = t.url || "";
    if (/^https:\/\/([a-z0-9-]+\.)?notion\.(so|com)\/robots\.txt/i.test(url)) {
      // 自动关掉之前遗留的 robots.txt 标签页
      if (t.id) chrome.tabs.remove(t.id).catch(() => {});
      continue;
    }
    if (t.id && /^https:\/\/([a-z0-9-]+\.)?notion\.(so|com)\//i.test(url)) {
      notionTabs.push(t);
    }
  }
  notionTabs.sort((a, b) => {
    const aLogin = /\/login|\/signup/i.test(a.url || "") ? 1 : 0;
    const bLogin = /\/login|\/signup/i.test(b.url || "") ? 1 : 0;
    return aLogin - bLogin;
  });
  return notionTabs;
}

async function notionWebRequest(endpoint, body = {}, activeUserId = "") {
  const cookieInfo = await getNotionWebCookies();
  const userId = activeUserId || cookieInfo?.userId || "";

  // 1. 优先复用已打开的 Notion 标签页执行 100% 同源请求
  const notionTabs = await findOpenNotionTabs();
  for (const tab of notionTabs) {
    const tabRes = await executeInNotionTab(tab.id, endpoint, body, userId).catch(() => null);
    if (tabRes?.ok && tabRes.payload && (endpoint !== "getSpaces" || Object.keys(tabRes.payload).length > 0)) {
      return tabRes.payload;
    }
  }

  // 2. 后台直连（始终注入 Origin/Referer 与检测到的 Cookie）
  await ensureWebCookieRule(cookieInfo?.cookieHeader || "", userId);
  const directRes = await fetch(`https://www.notion.so/api/v3/${endpoint}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(userId ? { "x-notion-active-user-header": userId } : {})
    },
    body: JSON.stringify(body)
  }).catch(() => null);
  if (directRes?.ok) {
    const payload = await directRes.json().catch(() => null);
    if (payload && (endpoint !== "getSpaces" || Object.keys(payload).length > 0)) {
      return payload;
    }
  }

  throw new Error("未检测到 Notion 网页登录状态，请先在浏览器登录 Notion。");
}

async function syncWebSession(preferredSpaceId = "") {
  let spacesPayload = await notionWebRequest("getSpaces", {}).catch(() => null);
  if (!spacesPayload || !Object.keys(spacesPayload).length) {
    spacesPayload = await notionWebRequest("loadUserContent", {}).catch(() => null);
  }
  const spaces = [];
  const embeddedBlocks = {};
  const embeddedCollections = {};
  let detectedUserId = "";
  let detectedUserName = "";

  const scanRecordBundle = (bundle, fallbackUserKey = "") => {
    if (!bundle || typeof bundle !== "object") return;
    if (fallbackUserKey && !detectedUserId && /^[0-9a-f-]{32,36}$/i.test(fallbackUserKey)) {
      detectedUserId = fallbackUserKey;
    }
    const userMap = bundle.notion_user || {};
    for (const [uid, uEntry] of Object.entries(userMap)) {
      const uVal = unwrapRecord(uEntry);
      if (uVal) {
        detectedUserId = uVal.id || uid || detectedUserId;
        detectedUserName = uVal.name || uVal.given_name || uVal.email || detectedUserName;
      }
    }
    const spaceMap = bundle.space || {};
    for (const [sid, sEntry] of Object.entries(spaceMap)) {
      const sVal = unwrapRecord(sEntry);
      const resolvedId = sVal?.id || sid;
      if (resolvedId && !spaces.some((s) => s.id === resolvedId)) {
        spaces.push({
          id: resolvedId,
          name: sVal?.name || "我的 Notion 工作区",
          pages: Array.isArray(sVal?.pages) ? sVal.pages : []
        });
      }
    }
    Object.assign(embeddedBlocks, bundle.block || {});
    Object.assign(embeddedCollections, bundle.collection || {});
  };

  if (spacesPayload?.recordMap) {
    scanRecordBundle(spacesPayload.recordMap);
  }
  for (const [userKey, userBundle] of Object.entries(spacesPayload || {})) {
    if (userKey === "recordMap") continue;
    scanRecordBundle(userBundle, userKey);
    if (userBundle?.recordMap) scanRecordBundle(userBundle.recordMap, userKey);
  }

  // 保底：如果用户当前已经打开了 Notion 页面标签页，直接从该标签页恢复会话信息
  const openNotionTabs = await findOpenNotionTabs();
  for (const tab of openNotionTabs) {
    const tabBlockId = extractBlockIdFromNotionUrl(tab.url || "");
    if (!tabBlockId) continue;
    if (!spaces.length) {
      const chunkRes = await notionWebRequest("getPageChunk", {
        pageId: tabBlockId,
        limit: 5,
        cursor: { stack: [] },
        chunkNumber: 0,
        verticalColumns: false
      }, detectedUserId).catch(() => null);
      if (chunkRes?.recordMap) {
        scanRecordBundle(chunkRes.recordMap);
      }
      const bVal = unwrapRecord(chunkRes?.recordMap?.block?.[tabBlockId]);
      if (bVal?.space_id) {
        detectedUserId = detectedUserId || bVal.created_by_id || bVal.last_edited_by_id || "";
        if (!spaces.some((s) => s.id === bVal.space_id)) {
          spaces.push({
            id: bVal.space_id,
            name: "我的 Notion 工作区",
            pages: [tabBlockId]
          });
        }
      } else {
        spaces.push({
          id: "active_notion_tab",
          name: "已打开的 Notion",
          pages: [tabBlockId]
        });
      }
    }
  }

  if (!spaces.length) {
    throw new Error("未找到可用的 Notion 工作区，请确认已在浏览器登录 Notion。");
  }

  const chosenSpace = spaces.find((s) => s.id === preferredSpaceId) || spaces[0];
  return {
    userId: detectedUserId,
    userName: detectedUserName,
    spaceId: chosenSpace.id,
    workspaceName: chosenSpace.name,
    rootPages: chosenSpace.pages,
    embeddedBlocks,
    embeddedCollections,
    spaces
  };
}

async function listWebTargets(settings) {
  const session = await syncWebSession(settings.workspaceId);
  const targets = [];
  const seen = new Set();

  const addTarget = (item) => {
    if (!item?.id || seen.has(item.id)) return;
    seen.add(item.id);
    targets.push(item);
  };

  // 0. 优先把用户浏览器里当前已经打开的 Notion 页面/数据库（如「网页剪藏」）排在第一位！
  const openNotionTabs = await findOpenNotionTabs();
  for (const tab of openNotionTabs) {
    const tabBlockId = extractBlockIdFromNotionUrl(tab.url || "");
    if (!tabBlockId) continue;
    const fallbackTitle = cleanNotionTabTitle(tab.title);
    let kind = "web_page";
    let collectionId = "";
    let finalTitle = fallbackTitle;
    try {
      const chunkRes = await notionWebRequest("getPageChunk", {
        pageId: tabBlockId,
        limit: 5,
        cursor: { stack: [] },
        chunkNumber: 0,
        verticalColumns: false
      }, session.userId);
      const blockMap = chunkRes?.recordMap?.block || {};
      const collectionMap = chunkRes?.recordMap?.collection || {};
      const bVal = unwrapRecord(blockMap[tabBlockId]);
      if (bVal) {
        if (bVal.space_id && session.spaceId === "active_notion_tab") {
          session.spaceId = bVal.space_id;
        }
        if (!session.userId) {
          session.userId = bVal.last_edited_by_id || bVal.created_by_id || "";
        }
        if (bVal.type === "collection_view_page" || bVal.type === "collection_view") {
          kind = "web_database";
          collectionId = bVal.collection_id || bVal.format?.collection_pointer?.id || "";
          const colVal = collectionId ? unwrapRecord(collectionMap[collectionId]) : null;
          const colName = readWebTextProp(colVal?.name);
          if (colName) finalTitle = colName;
        }
        const propTitle = readWebTextProp(bVal.properties?.title);
        if (propTitle) finalTitle = propTitle;
      }
    } catch {}
    addTarget({
      id: tabBlockId,
      collectionId,
      title: `📍 ${finalTitle}（当前打开的 Notion 页）`,
      rawTitle: finalTitle,
      kind,
      titleProperty: "title"
    });
  }

  const extractFromMaps = (blockMap = {}, collectionMap = {}) => {
    for (const rawId of Object.keys(blockMap)) {
      const bVal = unwrapRecord(blockMap[rawId]);
      if (!bVal || bVal.alive === false) continue;
      if (bVal.space_id && session.spaceId !== "active_notion_tab" && bVal.space_id !== session.spaceId) continue;

      if (bVal.type === "collection_view_page" || bVal.type === "collection_view") {
        const colId = bVal.collection_id || bVal.format?.collection_pointer?.id;
        const colVal = colId ? unwrapRecord(collectionMap[colId]) : null;
        const title = readWebTextProp(colVal?.name) || readWebTextProp(bVal.properties?.title);
        if (!title) continue;
        addTarget({
          id: bVal.id || rawId,
          collectionId: colId || "",
          title: `🗂️ ${title}`,
          rawTitle: title,
          kind: "web_database",
          titleProperty: "title"
        });
      } else if (bVal.type === "page") {
        const title = readWebTextProp(bVal.properties?.title);
        if (!title) continue;
        addTarget({
          id: bVal.id || rawId,
          title: `📄 ${title}`,
          rawTitle: title,
          kind: "web_page",
          titleProperty: "title"
        });
      }
    }
  };

  extractFromMaps(session.embeddedBlocks, session.embeddedCollections);

  try {
    const searchRes = await notionWebRequest("search", {
      type: "BlocksInSpace",
      query: "",
      spaceId: session.spaceId,
      limit: 50,
      filters: {
        isDeletedOnly: false,
        excludeTemplates: true,
        navigableBlockContentOnly: true,
        requireEditPermissions: true,
        ancestors: [],
        createdBy: [],
        editedBy: [],
        lastEditedTime: {},
        createdTime: {}
      },
      sort: { field: "lastEdited", direction: "desc" },
      source: "quick_find_input_change"
    }, session.userId);

    extractFromMaps(searchRes?.recordMap?.block || {}, searchRes?.recordMap?.collection || {});
  } catch {
    // Search fallback: load root pages below
  }

  if (session.rootPages?.length && targets.length < 10) {
    try {
      const requests = session.rootPages.slice(0, 25).map((id) => ({ table: "block", id }));
      const recRes = await notionWebRequest("getRecordValues", { requests }, session.userId);
      for (const entry of recRes?.results || []) {
        const bVal = unwrapRecord(entry);
        if (!bVal || bVal.alive === false) continue;
        if (bVal.type === "page" || bVal.type === "collection_view_page") {
          const title = readWebTextProp(bVal.properties?.title) || "工作区页面";
          addTarget({
            id: bVal.id,
            collectionId: bVal.collection_id || "",
            title: `${bVal.type === "collection_view_page" ? "🗂️" : "📄"} ${title}`,
            rawTitle: title,
            kind: bVal.type === "collection_view_page" ? "web_database" : "web_page",
            titleProperty: "title"
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  addTarget({
    id: AUTO_TARGET_ID,
    title: "✨ 自动创建「📚 网页剪藏」页面",
    rawTitle: "📚 网页剪藏",
    kind: "web_auto",
    titleProperty: "title"
  });

  return { session, targets };
}

async function loginViaNotionWebWindow() {
  const current = await getStoredSettings();

  // 第一步：直接检测当前浏览器是否已登录 Notion（若已登录则直接秒连，绝不弹新窗口！）
  try {
    const { session, targets } = await listWebTargets(current);
    if (session?.spaceId) {
      const preferred = targets.find((t) => t.id === current.databaseId) || targets[0];
      const updated = await saveStoredSettings({
        authMode: "web",
        webUserId: session.userId,
        userName: session.userName,
        workspaceId: session.spaceId,
        workspaceName: session.workspaceName,
        databaseId: preferred?.id || AUTO_TARGET_ID,
        targetKind: preferred?.kind || "web_auto",
        targetTitle: preferred?.title || "✨ 自动创建「📚 网页剪藏」页面",
        collectionId: preferred?.collectionId || "",
        titleProperty: preferred?.titleProperty || "title"
      });
      return { settings: updated, targets };
    }
  } catch {
    // 确实未登录，才打开登录窗口
  }

  const loginWin = await chrome.windows.create({
    url: "https://www.notion.so/login",
    type: "popup",
    width: 540,
    height: 720,
    focused: true
  });
  const loginTabId = loginWin?.tabs?.[0]?.id;

  await new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("登录等待超时，请完成 Notion 登录后再点一次连接。"));
    }, 180000);

    const intervalId = setInterval(async () => {
      if (checking || settled) return;
      checking = true;
      try {
        const { session } = await listWebTargets(current);
        if (session?.spaceId) {
          settled = true;
          cleanup();
          if (loginTabId) {
            await chrome.scripting.executeScript({
              target: { tabId: loginTabId },
              func: (wsName) => {
          const banner = document.createElement("div");
          banner.textContent = `✓ 简阅已成功连接 Notion（${wsName}），正在返回…`;
                banner.style.cssText = "position:fixed;z-index:2147483647;top:18px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:999px;background:#385341;color:#fff;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18);";
                document.body?.append(banner);
              },
              args: [session.workspaceName || "Notion"]
            }).catch(() => {});
          }
          setTimeout(() => {
            if (loginWin?.id) chrome.windows.remove(loginWin.id).catch(() => {});
          }, 700);
          resolve();
        }
      } catch {
        // Keep waiting until login completes
      } finally {
        checking = false;
      }
    }, 1200);

    const onWindowRemoved = (winId) => {
      if (winId === loginWin?.id && !settled) {
        setTimeout(async () => {
          if (settled) return;
          cleanup();
          try {
            const { session } = await listWebTargets(current);
            if (session?.spaceId) {
              resolve();
              return;
            }
          } catch {}
          reject(new Error("登录窗口已关闭，尚未检测到 Notion 登录状态。"));
        }, 300);
      }
    };

    function cleanup() {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
      chrome.windows.onRemoved.removeListener(onWindowRemoved);
    }

    chrome.windows.onRemoved.addListener(onWindowRemoved);
  });

  const { session, targets } = await listWebTargets(current);
  const preferred = targets.find((t) => t.id === current.databaseId) || targets[0];
  const updated = await saveStoredSettings({
    authMode: "web",
    webUserId: session.userId,
    userName: session.userName,
    workspaceId: session.spaceId,
    workspaceName: session.workspaceName,
    databaseId: preferred?.id || AUTO_TARGET_ID,
    targetKind: preferred?.kind || "web_auto",
    targetTitle: preferred?.title || "✨ 自动创建「📚 网页剪藏」页面",
    collectionId: preferred?.collectionId || "",
    titleProperty: preferred?.titleProperty || "title"
  });
  return { settings: updated, targets };
}

async function ensureWebContainerPage(session, settings) {
  if (settings.autoContainerPageId) {
    return settings.autoContainerPageId;
  }
  const containerId = crypto.randomUUID();
  const now = Date.now();
  const operations = [
    {
      id: containerId,
      table: "block",
      path: [],
      command: "set",
      args: {
        id: containerId,
        version: 1,
        type: "page",
        properties: { title: [["📚 网页剪藏"]] },
        format: { page_icon: "📚" },
        parent_id: session.spaceId,
        parent_table: "space",
        alive: true,
        space_id: session.spaceId,
        created_time: now,
        last_edited_time: now,
        created_by_id: session.userId,
        created_by_table: "notion_user",
        last_edited_by_id: session.userId,
        last_edited_by_table: "notion_user"
      }
    },
    {
      id: session.spaceId,
      table: "space",
      path: ["pages"],
      command: "listAfter",
      args: { id: containerId }
    }
  ];
  await notionWebRequest("saveTransactions", {
    requestId: crypto.randomUUID(),
    transactions: [{
      id: crypto.randomUUID(),
      spaceId: session.spaceId,
      operations
    }]
  }, session.userId);
  await saveStoredSettings({
    autoContainerPageId: containerId,
    databaseId: containerId,
    targetKind: "web_page",
    targetTitle: "📄 📚 网页剪藏"
  });
  return containerId;
}

function buildWebBlockOperations(pageId, spaceId, userId, clip) {
  const now = Date.now();
  const blockEntries = [];

  const pushBlock = (type, properties, format) => {
    const blockId = crypto.randomUUID();
    const setOp = {
      id: blockId,
      table: "block",
      path: [],
      command: "set",
      args: {
        id: blockId,
        version: 1,
        type,
        ...(properties ? { properties } : {}),
        ...(format ? { format } : {}),
        parent_id: pageId,
        parent_table: "block",
        alive: true,
        space_id: spaceId,
        created_time: now,
        last_edited_time: now,
        ...(userId ? {
          created_by_id: userId,
          created_by_table: "notion_user",
          last_edited_by_id: userId,
          last_edited_by_table: "notion_user"
        } : {})
      }
    };
    const listOp = {
      id: pageId,
      table: "block",
      path: ["content"],
      command: "listAfter",
      args: { id: blockId }
    };
    blockEntries.push([setOp, listOp]);
  };

  // 顶部精美 Callout 元信息卡片
  const metaRichText = [];
  if (clip.url) {
    metaRichText.push(["🔗 原文链接："], [clip.url, [["a", clip.url]]]);
  }
  if (clip.byline) {
    if (metaRichText.length) metaRichText.push(["\n"]);
    metaRichText.push([`✍️ 作者：${clip.byline}`]);
  }
  const timeStr = new Date().toLocaleString("zh-CN", { hour12: false });
  if (metaRichText.length) metaRichText.push(["\n"]);
  metaRichText.push([`📅 剪藏时间：${timeStr}`]);

  pushBlock(
    "callout",
    { title: metaRichText },
    { page_icon: "🔖", block_color: "gray_background" }
  );
  pushBlock("divider");

  const typeMap = {
    heading_1: "header",
    heading_2: "sub_header",
    heading_3: "sub_sub_header",
    quote: "quote",
    bulleted_list_item: "bulleted_list",
    numbered_list_item: "numbered_list",
    code: "code"
  };

  const chapterTitleRegex = /^([#＃]\s*\d+\s*.*|第[零一二三四五六七八九十百千万0-9]+[章节回卷集部篇幕](\s+.*|$)|Chapter\s+\d+.*|序[章言幕]?(\s+.*|$)|楔子(\s+.*|$)|尾声(\s+.*|$)|番外(\s*.*|$)|[一二三四五六七八九十]+[、.．]\s*\S+.*)$/i;

  for (const item of (clip.blocks || []).slice(0, 2500)) {
    if (item.type === "image" && /^https?:\/\//i.test(item.url || "")) {
      pushBlock(
        "image",
        {
          source: [[item.url]],
          ...(item.text ? { caption: [[item.text]] } : {})
        },
        { display_source: item.url }
      );
      continue;
    }
    if (item.type === "divider") {
      pushBlock("divider");
      continue;
    }
    if (item.type === "code") {
      for (const part of splitText(item.text || "", 1800)) {
        if (!part.trim()) continue;
        pushBlock("code", {
          title: [[part]],
          language: [["Plain Text"]]
        });
      }
      continue;
    }

    // 将含换行的文本彻底拆分为独立自然段，确保在 Notion 中每段独立成块
    const lines = String(item.text || "")
      .split(/\r?\n+/)
      .map((l) => l.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ""))
      .filter(Boolean);

    for (const line of lines) {
      let webType = typeMap[item.type] || "text";
      if (webType === "text" && line.length <= 42 && chapterTitleRegex.test(line)) {
        webType = "sub_header";
      }
      for (const part of splitText(line, 1800)) {
        if (!part.trim()) continue;
        pushBlock(webType, { title: [[part]] });
      }
    }
  }

  return blockEntries;
}

async function saveClipViaWebSession(clip, settings) {
  const session = await syncWebSession(settings.workspaceId);
  const title = Array.from(String(clip.title || "未命名网页").trim()).slice(0, 200).join("") || "未命名网页";

  let targetId = settings.databaseId;
  let targetKind = settings.targetKind || "web_page";
  let collectionId = settings.collectionId || "";
  let realSpaceId = session.spaceId;
  let realUserId = session.userId;
  let urlPropKey = "";
  let statusPropKey = "";
  let statusDefaultVal = "未读";
  let datePropKey = "";
  let sourcePropKey = "";

  if (!targetId || targetId === AUTO_TARGET_ID || targetKind === "web_auto") {
    targetId = await ensureWebContainerPage(session, settings);
    targetKind = "web_page";
  }

  // 通过 getPageChunk 精确获取目标容器的真实 space_id、type、collection_id 和 schema
  try {
    const chunkRes = await notionWebRequest("getPageChunk", {
      pageId: targetId,
      limit: 5,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false
    }, realUserId);
    const bVal = unwrapRecord(chunkRes?.recordMap?.block?.[targetId]);
    if (bVal) {
      if (bVal.space_id) realSpaceId = bVal.space_id;
      if (!realUserId) realUserId = bVal.last_edited_by_id || bVal.created_by_id || "";
      if (bVal.type === "collection_view_page" || bVal.type === "collection_view") {
        targetKind = "web_database";
        collectionId = bVal.collection_id || bVal.format?.collection_pointer?.id || collectionId;
      } else if (bVal.type === "page") {
        targetKind = "web_page";
      }
    }
    if (collectionId && chunkRes?.recordMap?.collection?.[collectionId]) {
      const colVal = unwrapRecord(chunkRes.recordMap.collection[collectionId]);
      const schema = colVal?.schema || {};
      for (const [k, v] of Object.entries(schema)) {
        if (v?.type === "url" && !urlPropKey) {
          urlPropKey = k;
        } else if (v?.type === "date" && !datePropKey) {
          datePropKey = k;
        } else if (v?.type === "select" && !statusPropKey) {
          const unreadOpt = (v.options || []).find((o) => o?.value === "未读" || o?.value === "Unread" || o?.value === "待读");
          if (unreadOpt || (v.name && /状态|status/i.test(v.name))) {
            statusPropKey = k;
            if (unreadOpt?.value) statusDefaultVal = unreadOpt.value;
          }
        } else if (v?.type === "text" && !sourcePropKey && v.name && /来源|source|站点/i.test(v.name)) {
          sourcePropKey = k;
        }
      }
    }
  } catch {}

  const openTabs = await findOpenNotionTabs();
  let notionOrigin = "https://www.notion.so";
  if (openTabs[0]?.url) {
    try { notionOrigin = new URL(openTabs[0].url).origin; } catch {}
  }

  const newPageId = crypto.randomUUID();
  const now = Date.now();
  const isCollectionParent = Boolean(targetKind === "web_database" && collectionId);
  const parentId = isCollectionParent ? collectionId : targetId;
  const parentTable = isCollectionParent ? "collection" : "block";
  const todayStr = new Date().toISOString().slice(0, 10);
  const sourceLabel = clip.siteName ? `${clip.siteName} / 简阅` : "简阅";

  const pageProperties = {
    title: [[title]],
    ...(isCollectionParent && urlPropKey && clip.url ? { [urlPropKey]: [[clip.url, [["a", clip.url]]]] } : {}),
    ...(isCollectionParent && statusPropKey ? { [statusPropKey]: [[statusDefaultVal]] } : {}),
    ...(isCollectionParent && datePropKey ? { [datePropKey]: [["‣", [["d", { type: "date", start_date: todayStr }]]]] } : {}),
    ...(isCollectionParent && sourcePropKey ? { [sourcePropKey]: [[sourceLabel]] } : {})
  };

  const createPageOps = [
    {
      id: newPageId,
      table: "block",
      path: [],
      command: "set",
      args: {
        id: newPageId,
        version: 1,
        type: "page",
        properties: pageProperties,
        format: { page_icon: clip.kind === "selection" ? "✂️" : "📄" },
        parent_id: parentId,
        parent_table: parentTable,
        alive: true,
        space_id: realSpaceId,
        created_time: now,
        last_edited_time: now,
        ...(realUserId ? {
          created_by_id: realUserId,
          created_by_table: "notion_user",
          last_edited_by_id: realUserId,
          last_edited_by_table: "notion_user"
        } : {})
      }
    }
  ];

  if (!isCollectionParent) {
    createPageOps.push({
      id: parentId,
      table: "block",
      path: ["content"],
      command: "listAfter",
      args: { id: newPageId }
    });
  }

  const blockEntries = buildWebBlockOperations(newPageId, realSpaceId, realUserId, clip);
  const BATCH_SIZE = 100;
  const firstBatchOps = [...createPageOps, ...blockEntries.slice(0, BATCH_SIZE).flat()];

  await notionWebRequest("saveTransactions", {
    requestId: crypto.randomUUID(),
    transactions: [{
      id: crypto.randomUUID(),
      spaceId: realSpaceId,
      operations: firstBatchOps
    }]
  }, realUserId);

  for (let offset = BATCH_SIZE; offset < blockEntries.length; offset += BATCH_SIZE) {
    const batchOps = blockEntries.slice(offset, offset + BATCH_SIZE).flat();
    await notionWebRequest("saveTransactions", {
      requestId: crypto.randomUUID(),
      transactions: [{
        id: crypto.randomUUID(),
        spaceId: realSpaceId,
        operations: batchOps
      }]
    }, realUserId);
  }

  return {
    url: `${notionOrigin}/${newPageId.replace(/-/g, "")}`,
    title
  };
}

// ============================================================================
// 2. Notion 官方 API 模式（支持 Token 一键自动识别 / 自动建库 + 本地直连 OAuth）
// ============================================================================

async function rawNotionRequest(path, token, body, method = "POST") {
  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.message || payload.code || `HTTP ${response.status}`;
    const error = new Error(`Notion 返回错误：${detail}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function refreshAccessToken(settings) {
  if (settings.refreshToken && settings.oauthClientId && settings.oauthClientSecret) {
    const basic = btoa(`${settings.oauthClientId}:${settings.oauthClientSecret}`);
    const response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: settings.refreshToken
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.access_token) {
      const updated = await saveStoredSettings({
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token || settings.refreshToken,
        workspaceName: payload.workspace_name || settings.workspaceName,
        workspaceId: payload.workspace_id || settings.workspaceId
      });
      return updated.accessToken;
    }
  }
  if (!settings.refreshToken || !settings.oauthWorkerUrl) throw new Error("Notion 授权已过期，请重新连接。");
  const response = await fetch(`${settings.oauthWorkerUrl.replace(/\/$/, "")}/oauth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: settings.refreshToken })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error("Notion 授权已过期，请重新连接。");
  const updated = await saveStoredSettings({
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || settings.refreshToken,
    workspaceName: payload.workspace_name || settings.workspaceName,
    workspaceId: payload.workspace_id || settings.workspaceId
  });
  return updated.accessToken;
}

async function notionRequest(path, settings, body, method = "POST", canRefresh = true) {
  const token = settings.accessToken || settings.token;
  if (!token) throw new Error("请先连接 Notion。");
  try {
    return await rawNotionRequest(path, token, body, method);
  } catch (error) {
    if (error.status === 401 && settings.accessToken && canRefresh) {
      const freshToken = await refreshAccessToken(settings);
      return notionRequest(path, { ...settings, accessToken: freshToken }, body, method, false);
    }
    throw error;
  }
}

function readTitle(database) {
  if (Array.isArray(database.title)) {
    const text = database.title.map((item) => item.plain_text || item.text?.content || "").join("").trim();
    if (text) return text;
  }
  if (typeof database.title === "string" && database.title.trim()) return database.title.trim();
  return "未命名数据库";
}

function readPageTitle(page) {
  const props = page?.properties || {};
  for (const prop of Object.values(props)) {
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title.map((item) => item.plain_text || item.text?.content || "").join("").trim();
      if (text) return text;
    }
  }
  return "未命名页面";
}

function titlePropertyName(database) {
  return Object.entries(database.properties || {}).find(([, property]) => property.type === "title")?.[0] || "Name";
}

function urlPropertyName(database) {
  return Object.entries(database.properties || {}).find(([, property]) => property.type === "url")?.[0] || "";
}

async function listApiTargets(settingsOverride) {
  const settings = settingsOverride || await getStoredSettings();
  if (!settings?.accessToken && !settings?.token) throw new Error("请先连接 Notion。");
  const targets = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const page = await notionRequest("search", settings, body);
    for (const item of page.results || []) {
      if (item.archived || item.in_trash) continue;
      if (item.object === "database") {
        const rawTitle = readTitle(item);
        targets.push({
          id: item.id,
          title: `🗂️ ${rawTitle}`,
          rawTitle,
          kind: "database",
          titleProperty: titlePropertyName(item),
          urlProperty: urlPropertyName(item)
        });
      } else if (item.object === "page") {
        const rawTitle = readPageTitle(item);
        targets.push({
          id: item.id,
          title: `📄 ${rawTitle}`,
          rawTitle,
          kind: "page",
          titleProperty: "title"
        });
      }
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor && targets.length < 300);

  targets.sort((a, b) => {
    if (a.kind === "database" && b.kind !== "database") return -1;
    if (a.kind !== "database" && b.kind === "database") return 1;
    return 0;
  });
  return targets;
}

async function connectWithToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) throw new Error("请粘贴 Notion 集成密钥（以 ntn_ 或 secret_ 开头）。");
  const me = await rawNotionRequest("users/me", token, null, "GET");
  const workspaceName = me?.bot?.workspace_name || me?.name || "Notion";
  const tempSettings = { authMode: "token", token, workspaceName };
  const targets = await listApiTargets(tempSettings);
  const preferred = targets[0];
  const updated = await saveStoredSettings({
    authMode: "token",
    token,
    accessToken: "",
    refreshToken: "",
    workspaceName,
    databaseId: preferred?.id || "",
    targetKind: preferred?.kind || "database",
    targetTitle: preferred?.title || "",
    titleProperty: preferred?.titleProperty || "Name",
    urlProperty: preferred?.urlProperty || ""
  });
  return { settings: updated, targets };
}

async function createClipDatabaseInNotion() {
  const settings = await getStoredSettings();
  if (settings.authMode === "web") {
    const session = await syncWebSession(settings.workspaceId);
    const pageId = await ensureWebContainerPage(session, { ...settings, autoContainerPageId: "" });
    const { targets } = await listWebTargets(settings);
    return {
      databaseId: pageId,
      title: "📄 📚 Nori 网页剪藏",
      kind: "web_page",
      targets
    };
  }

  const targets = await listApiTargets(settings);
  const parentPage = targets.find((t) => t.kind === "page" && t.id === settings.databaseId)
    || targets.find((t) => t.kind === "page");
  if (!parentPage) {
    throw new Error("请先在 Notion 中将至少一个页面授权给该连接（在页面右上角 ··· → Connections 中添加），然后即可一键自动建库。");
  }

  const created = await notionRequest("databases", settings, {
    parent: { type: "page_id", page_id: parentPage.id },
    icon: { type: "emoji", emoji: "📚" },
    title: [{ type: "text", text: { content: "Nori 网页剪藏" } }],
    properties: {
      "标题": { title: {} },
      "原文链接": { url: {} },
      "创建时间": { created_time: {} }
    }
  });

  const updatedTargets = await listApiTargets(settings);
  await saveStoredSettings({
    databaseId: created.id,
    targetKind: "database",
    targetTitle: "🗂️ Nori 网页剪藏",
    titleProperty: "标题",
    urlProperty: "原文链接"
  });
  return {
    databaseId: created.id,
    title: "🗂️ Nori 网页剪藏",
    kind: "database",
    targets: updatedTargets
  };
}

async function exchangeLocalOAuthCode({ clientId, clientSecret, code, redirectUri }) {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.message || payload.error || `OAuth 换取令牌失败 (HTTP ${response.status})`);
  }
  const tempSettings = {
    authMode: "oauth",
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || "",
    workspaceName: payload.workspace_name || "Notion",
    workspaceId: payload.workspace_id || "",
    oauthClientId: clientId,
    oauthClientSecret: clientSecret
  };
  const targets = await listApiTargets(tempSettings);
  const preferred = targets[0];
  const updated = await saveStoredSettings({
    ...tempSettings,
    token: "",
    databaseId: preferred?.id || "",
    targetKind: preferred?.kind || "database",
    targetTitle: preferred?.title || "",
    titleProperty: preferred?.titleProperty || "Name",
    urlProperty: preferred?.urlProperty || ""
  });
  return { settings: updated, targets };
}

// ============================================================================
// 3. 统一状态获取、自动连接与一键剪藏保存
// ============================================================================

async function getConnectionStatus({ autoDetectWeb = true, includeTargets = true } = {}) {
  let settings = await getStoredSettings();
  const hasApiAuth = Boolean(settings.accessToken || settings.token);

  if ((!settings.authMode && !hasApiAuth && autoDetectWeb) || settings.authMode === "web") {
    try {
      const { session, targets } = await listWebTargets(settings);
      const selected = targets.find((t) => t.id === settings.databaseId) || targets[0];
      settings = await saveStoredSettings({
        authMode: "web",
        webUserId: session.userId,
        userName: session.userName,
        workspaceId: session.spaceId,
        workspaceName: session.workspaceName,
        databaseId: selected?.id || AUTO_TARGET_ID,
        targetKind: selected?.kind || "web_auto",
          targetTitle: selected?.title || "✨ 自动创建「📚 网页剪藏」页面",
        collectionId: selected?.collectionId || "",
        titleProperty: selected?.titleProperty || "title"
      });
      return {
        connected: true,
        authMode: "web",
        workspaceName: settings.workspaceName,
        userName: settings.userName,
        settings,
        targets: includeTargets ? targets : []
      };
    } catch {
      // Fall through if web session unavailable
    }
  }

  if (hasApiAuth) {
    let targets = [];
    if (includeTargets) {
      try {
        targets = await listApiTargets(settings);
        if (!settings.databaseId && targets[0]) {
          settings = await saveStoredSettings({
            databaseId: targets[0].id,
            targetKind: targets[0].kind,
            targetTitle: targets[0].title,
            titleProperty: targets[0].titleProperty || "Name",
            urlProperty: targets[0].urlProperty || ""
          });
        }
      } catch {
        // Keep existing settings if offline
      }
    }
    return {
      connected: true,
      authMode: settings.accessToken ? "oauth" : "token",
      workspaceName: settings.workspaceName || "Notion",
      settings,
      targets
    };
  }

  return {
    connected: false,
    hasBrowserCookie: false,
    settings,
    targets: []
  };
}

async function saveClip(clip) {
  let settings = await getStoredSettings();

  if (!settings.authMode && !settings.accessToken && !settings.token) {
    const status = await getConnectionStatus({ autoDetectWeb: true, includeTargets: true });
    if (status.connected) {
      settings = status.settings;
    }
  }

  if (settings.authMode === "web") {
    return saveClipViaWebSession(clip, settings);
  }

  if (!settings?.accessToken && !settings?.token) {
    throw new Error("请先点击「直接登录 Notion」或配置 Notion 连接。");
  }

  if (!settings.databaseId) {
    const targets = await listApiTargets(settings);
    if (!targets.length) throw new Error("未找到可用的 Notion 页面或数据库，请先在 Notion 中授权至少一个页面。");
    settings = await saveStoredSettings({
      databaseId: targets[0].id,
      targetKind: targets[0].kind,
      targetTitle: targets[0].title,
      titleProperty: targets[0].titleProperty || "Name",
      urlProperty: targets[0].urlProperty || ""
    });
  }

  const title = Array.from(String(clip.title || "未命名网页").trim()).slice(0, 200).join("") || "未命名网页";
  const notionBlocks = toNotionBlocks(clip.blocks, clip.url, clip.byline).slice(0, 500);
  const isPageParent = settings.targetKind === "page";

  const createPayload = isPageParent
    ? {
        parent: { page_id: settings.databaseId },
        properties: {
          title: { title: [{ text: { content: title } }] }
        },
        children: notionBlocks.slice(0, 100)
      }
    : {
        parent: { database_id: noriSettingsOrId(settings) },
        properties: {
          [settings.titleProperty || "Name"]: { title: [{ text: { content: title } }] },
          ...(settings.urlProperty && clip.url ? { [settings.urlProperty]: { url: clip.url } } : {})
        },
        children: notionBlocks.slice(0, 100)
      };

  const page = await notionRequest("pages", settings, createPayload);

  for (let offset = 100; offset < notionBlocks.length; offset += 100) {
    await notionRequest(`blocks/${page.id}/children`, settings, {
      children: notionBlocks.slice(offset, offset + 100)
    }, "PATCH");
  }
  return { url: page.url, title };
}

function noriSettingsOrId(settings) {
  return String(settings.databaseId || "").trim();
}

// ============================================================================
// 3. WebDAV 导出与「网页剪藏」目录自动创建
// ============================================================================

function sanitizeMdFilename(rawTitle) {
  const cleaned = String(rawTitle || "未命名文章")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 96);
  return cleaned || "未命名文章";
}

function formatClipTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildMarkdownFromClip(clip) {
  if (clip?.markdown && typeof clip.markdown === "string") {
    return clip.markdown;
  }
  const title = String(clip?.title || "未命名网页").trim();
  const url = String(clip?.url || "").trim();
  const byline = String(clip?.byline || "").trim();
  const clippedAt = formatClipTimestamp();
  const escYaml = (str) => String(str || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const lines = [
    "---",
    `title: "${escYaml(title)}"`,
    ...(url ? [`source: "${escYaml(url)}"`] : []),
    ...(byline ? [`author: "${escYaml(byline)}"`] : []),
    `date: "${clippedAt}"`,
    "---",
    "",
    `# ${title}`,
    ""
  ];
  if (url) {
    lines.push(`> 原文链接：[${url}](${url})${byline ? ` · 作者：${byline}` : ""} · 剪藏时间：${clippedAt}`, "");
  }

  let numIndex = 1;
  for (const block of clip?.blocks || []) {
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
      lines.push(text.split(/\r?\n/).map((l) => `> ${l}`).join("\n"), "");
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

function encodeBasicAuth(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

async function ensureWebdavOriginRule(webdavUrl) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    const u = new URL(webdavUrl);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_WEBDAV_RULE_ID],
      addRules: [
        {
          id: DNR_WEBDAV_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "origin", operation: "remove" }
            ]
          },
          condition: {
            urlFilter: `${u.origin}/*`,
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    });
  } catch {}
}

async function webdavCheckOrCreateCollection(colUrl, authHeader) {
  const propRes = await fetch(colUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader,
      Depth: "0"
    }
  });
  if (propRes.status === 401) {
    throw new Error("WebDAV 账号或应用密码不正确（坚果云请在「账户信息 → 安全选项 → 第三方应用管理」中使用应用密码）。");
  }
  if (propRes.status === 200 || propRes.status === 207) {
    return { ok: true, existed: true };
  }
  const mkRes = await fetch(colUrl, {
    method: "MKCOL",
    headers: {
      Authorization: authHeader
    }
  });
  if (mkRes.status === 401) {
    throw new Error("WebDAV 账号或应用密码不正确。");
  }
  if ([200, 201, 204, 405].includes(mkRes.status)) {
    return { ok: true, created: true };
  }
  return { ok: false, status: mkRes.status };
}

async function ensureWebdavClipFolder(rawConfig) {
  const webdavUrl = String(rawConfig?.webdavUrl || "").trim();
  const webdavUsername = String(rawConfig?.webdavUsername || "").trim();
  const webdavPassword = String(rawConfig?.webdavPassword || "").trim();
  const webdavFolder = String(rawConfig?.webdavFolder || "网页剪藏").trim().replace(/^\/+|\/+$/g, "") || "网页剪藏";

  if (!webdavUrl || !webdavUsername || !webdavPassword) {
    const err = new Error("请先在设置页配置 WebDAV 服务器地址、账号与应用密码。");
    err.needConfig = true;
    throw err;
  }

  let parsed;
  try {
    parsed = new URL(webdavUrl);
  } catch {
    throw new Error("WebDAV 服务器地址格式不正确，请填写完整 http:// 或 https:// 地址。");
  }

  await ensureWebdavOriginRule(parsed.href);
  const authHeader = encodeBasicAuth(webdavUsername, webdavPassword);
  let baseUrl = parsed.href.replace(/\/+$/, "") + "/";

  // 如果用户填的 baseUrl 末尾已经包含该文件夹名，直接校验该目录
  const decodedPath = decodeURIComponent(parsed.pathname).replace(/\/+$/, "");
  const segments = webdavFolder.split("/").map((s) => s.trim()).filter(Boolean);
  if (decodedPath.endsWith(`/${webdavFolder}`)) {
    const check = await webdavCheckOrCreateCollection(baseUrl, authHeader);
    if (!check.ok) {
      throw new Error(`无法访问或创建 WebDAV 目录（HTTP ${check.status}）。`);
    }
    return { folderUrl: baseUrl, displayPath: `/${webdavFolder}`, authHeader };
  }

  // 逐级检查/创建目录（例如 /网页剪藏/）
  let currentUrl = baseUrl;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const nextUrl = `${currentUrl}${encodeURIComponent(seg)}/`;
    const res = await webdavCheckOrCreateCollection(nextUrl, authHeader);
    if (!res.ok) {
      // 针对坚果云默认不允许直接在 /dav/ 根目录新建同步文件夹的情况，自动尝试在 /dav/我的坚果云/ 下创建「网页剪藏」
      if (i === 0 && /jianguoyun\.com/i.test(parsed.hostname) && decodedPath === "/dav") {
        const fallbackBase = `${baseUrl}${encodeURIComponent("我的坚果云")}/`;
        const fbRoot = await webdavCheckOrCreateCollection(fallbackBase, authHeader);
        if (fbRoot.ok) {
          currentUrl = fallbackBase;
          const retryUrl = `${currentUrl}${encodeURIComponent(seg)}/`;
          const retryRes = await webdavCheckOrCreateCollection(retryUrl, authHeader);
          if (retryRes.ok) {
            currentUrl = retryUrl;
            continue;
          }
        }
      }
      throw new Error(`在 WebDAV 上创建「${seg}」文件夹失败（HTTP ${res.status}）。若是坚果云，请确认已开启允许创建顶层文件夹，或将地址填为 https://dav.jianguoyun.com/dav/我的坚果云/`);
    }
    currentUrl = nextUrl;
  }

  const finalDecodedPath = decodeURIComponent(new URL(currentUrl).pathname).replace(/\/+$/, "");
  return {
    folderUrl: currentUrl,
    displayPath: finalDecodedPath,
    authHeader
  };
}

async function testAndSaveWebdavConfig(config) {
  const webdavUrl = String(config?.webdavUrl || "").trim();
  const webdavUsername = String(config?.webdavUsername || "").trim();
  const webdavPassword = String(config?.webdavPassword || "").trim();
  const webdavFolder = String(config?.webdavFolder || "网页剪藏").trim().replace(/^\/+|\/+$/g, "") || "网页剪藏";

  const folderInfo = await ensureWebdavClipFolder({
    webdavUrl,
    webdavUsername,
    webdavPassword,
    webdavFolder
  });

  await saveStoredSettings({
    webdavUrl,
    webdavUsername,
    webdavPassword,
    webdavFolder,
    webdavConnected: true
  });

  return {
    folderUrl: folderInfo.folderUrl,
    displayPath: folderInfo.displayPath
  };
}

async function saveClipToWebdav(clip) {
  const settings = await getStoredSettings();
  const folderInfo = await ensureWebdavClipFolder(settings);
  const markdown = buildMarkdownFromClip(clip);
  const fileName = clip?.fileName && clip.fileName.endsWith(".md")
    ? clip.fileName
    : `${sanitizeMdFilename(clip?.title || "未命名网页")}.md`;
  const fileUrl = `${folderInfo.folderUrl}${encodeURIComponent(fileName)}`;

  const putRes = await fetch(fileUrl, {
    method: "PUT",
    headers: {
      Authorization: folderInfo.authHeader,
      "Content-Type": "text/markdown; charset=utf-8"
    },
    body: markdown
  });

  if (putRes.status === 401) {
    throw new Error("WebDAV 认证失败，请检查账号与应用密码。");
  }
  if (!putRes.ok && ![200, 201, 204].includes(putRes.status)) {
    throw new Error(`上传到 WebDAV 失败（HTTP ${putRes.status}）。`);
  }

  return {
    fileName,
    fileUrl,
    displayPath: `${folderInfo.displayPath}/${fileName}`
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "NORI_GET_STATUS") {
    getConnectionStatus({
      autoDetectWeb: message.autoDetectWeb !== false,
      includeTargets: message.includeTargets !== false
    })
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "获取连接状态失败。" }));
    return true;
  }
  if (message?.type === "NORI_WEB_LOGIN") {
    loginViaNotionWebWindow()
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Notion 登录失败。" }));
    return true;
  }
  if (message?.type === "NORI_TOKEN_CONNECT") {
    connectWithToken(message.token)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "密钥连接失败。" }));
    return true;
  }
  if (message?.type === "NORI_EXCHANGE_OAUTH") {
    exchangeLocalOAuthCode(message)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "OAuth 授权失败。" }));
    return true;
  }
  if (message?.type === "NORI_CREATE_CLIP_DATABASE") {
    createClipDatabaseInNotion()
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "自动创建剪藏库失败。" }));
    return true;
  }
  if (message?.type === "NORI_LIST_DATABASES") {
    getConnectionStatus({ autoDetectWeb: true, includeTargets: true })
      .then((res) => sendResponse({ ok: true, databases: res.targets || [], targets: res.targets || [], settings: res.settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "读取 Notion 目标列表失败。" }));
    return true;
  }
  if (message?.type === "NORI_LIST_TARGETS") {
    getConnectionStatus({ autoDetectWeb: true, includeTargets: true })
      .then((res) => sendResponse({ ok: true, databases: res.targets || [], targets: res.targets || [], settings: res.settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "读取 Notion 目标列表失败。" }));
    return true;
  }
  if (message?.type === "NORI_SAVE_TO_NOTION") {
    saveClip(message.clip).then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Notion 保存失败。" }));
    return true;
  }
  if (message?.type === "NORI_TEST_WEBDAV") {
    testAndSaveWebdavConfig(message.config)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, needConfig: Boolean(error.needConfig), error: error.message || "WebDAV 连接失败。" }));
    return true;
  }
  if (message?.type === "NORI_SAVE_TO_WEBDAV") {
    saveClipToWebdav(message.clip)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, needConfig: Boolean(error.needConfig), error: error.message || "WebDAV 保存失败。" }));
    return true;
  }
  if (message?.type === "NORI_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  return undefined;
});
