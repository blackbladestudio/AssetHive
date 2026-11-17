const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "electron/main.js"), "utf8").replace(/\r\n/g, "\n");
const start = mainSource.indexOf('  ipcMain.handle("app:openExternal",');
const end = mainSource.indexOf("\n  });", start);
assert.ok(start >= 0 && end > start, "external link IPC handler exists");
const handlerSource = mainSource.slice(start, end) + "\n  });";

function fixture(failure) {
  const opened = [];
  let handler;
  new Function("ipcMain", "shell", handlerSource)(
    { handle: (_name, callback) => { handler = callback; } },
    { openExternal: async (url) => {
      if (failure) throw failure;
      opened.push(url);
    } }
  );
  return { opened, open: (url) => handler({}, url) };
}

test("existing web links still open externally", async () => {
  const f = fixture();
  for (const url of ["https://github.com/Biscuits47", "http://localhost:5173"]) {
    assert.deepEqual(await f.open(url), { ok: true });
  }
  assert.deepEqual(f.opened, ["https://github.com/Biscuits47", "http://localhost:5173"]);
});

test("Feishu contact links preserve the invitation page's native protocol and token", async () => {
  const f = fixture();
  for (const scheme of ["lark", "feishu"]) {
    const url = `${scheme}://client/contact/add_friend?token=contact-token-123`;
    assert.deepEqual(await f.open(url), { ok: true });
    assert.equal(f.opened.at(-1), url);
  }
});

test("unrelated protocols, routes, hosts and malformed contact links are rejected", async () => {
  const f = fixture();
  for (const url of [
    undefined, "", "javascript:alert(1)", "file:///C:/Windows/notepad.exe", "ms-settings:privacy",
    "lark://applink.feishu.cn/client/contact/add_friend?token=contact-token-123",
    "lark://applink.feishu.cn/client/chat/open?openId=other-user",
    "lark://client.evil.example/contact/add_friend?token=contact-token-123",
    "lark://client/contact/add_friend",
    "lark://client/contact/add_friend?token=",
    "lark://client/contact/add_friend?token=contact-token-123&url=file:///C:/Windows/notepad.exe"
  ]) {
    assert.equal((await f.open(url)).ok, false, String(url));
  }
  assert.deepEqual(f.opened, []);
});

test("OS launch failures return an actionable error", async () => {
  const f = fixture(new Error("No Feishu protocol handler installed"));
  const result = await f.open("lark://client/contact/add_friend?token=contact-token-123");
  assert.deepEqual(result, { ok: false, message: "No Feishu protocol handler installed" });
});

function contributorLink() {
  const source = ts.createSourceFile("App.tsx", fs.readFileSync(path.join(root, "src/ui/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let link;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "a" && node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(source) === "className" && attr.initializer?.text === "about-collab-tag about-collab-link")) link = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(link, "Doubao contributor link exists");
  const attribute = (name) => link.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(source) === name);
  return { url: attribute("href").initializer.text, callback: attribute("onClick").initializer.expression.getText(source) };
}

test("clicking Doubao reaches the native contact IPC without opening a web page", async () => {
  const link = contributorLink();
  const f = fixture();
  let prevented = false;
  const callback = new Function("bridge", "bridgeAvailable", "showStatus", "t", `return (${link.callback});`)(
    { openExternal: f.open }, true, () => { throw new Error("Unexpected launch error"); }, (zh) => zh
  );
  await callback({ currentTarget: { href: link.url }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(f.opened, [link.url]);
  assert.equal(new URL(link.url).protocol, "lark:");
  assert.equal(new URL(link.url).hostname, "client");
  assert.equal(new URL(link.url).pathname, "/contact/add_friend");
});

test("a failed contact launch is reported to the user", async () => {
  const link = contributorLink();
  const f = fixture(new Error("Feishu is unavailable"));
  const statuses = [];
  const callback = new Function("bridge", "bridgeAvailable", "showStatus", "t", `return (${link.callback});`)(
    { openExternal: f.open }, true, (message) => statuses.push(message), (zh) => zh
  );
  await callback({ currentTarget: { href: link.url }, preventDefault: () => {} });
  assert.equal(statuses.length, 1);
  assert.match(statuses[0], /无法打开飞书名片.*Feishu is unavailable/);
});
