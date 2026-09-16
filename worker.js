const allowed = new Set(["https://peige880-lab232.github.io", "http://127.0.0.1:5173", "http://localhost:5173"]);

function cors(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "https://peige880-lab232.github.io",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Group-Key",
    Vary: "Origin",
  };
}
function out(request, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(request) } });
}
const uid = () => crypto.randomUUID();
const round = value => Math.round(value * 100) / 100;
async function digest(value) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(raw)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function secret() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function names(value) {
  return Array.isArray(value) ? [...new Set(value.filter(x => typeof x === "string").map(x => x.trim()).filter(Boolean))].slice(0, 50) : [];
}
function jsonArray(value) {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function render(row) {
  const legacyPeople = jsonArray(row.people_json);
  const payers = jsonArray(row.payers_json);
  const shares = jsonArray(row.shares_json);
  return {
    id: row.id, date: new Date(row.created_at).toLocaleDateString("zh-TW"),
    payer: row.payer, item: row.item, amount: Number(row.amount), people: legacyPeople, note: row.note,
    payments: payers.length ? payers : (row.payer ? [{ person: row.payer, amount: Number(row.amount) }] : []),
    splits: shares.length ? shares : legacyPeople.map(person => ({ person, percentage: 100 / legacyPeople.length })),
  };
}
function allocations(value, groupPeople, valueKey) {
  if (!Array.isArray(value) || !value.length || value.length > groupPeople.length) return null;
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const person = typeof entry?.person === "string" ? entry.person.trim() : "";
    const amount = Number(entry?.[valueKey]);
    if (!person || seen.has(person) || !groupPeople.includes(person) || !Number.isFinite(amount) || amount < 0) return null;
    seen.add(person);
    result.push({ person, [valueKey]: round(amount) });
  }
  return result;
}
async function access(request, env, groupId) {
  const key = request.headers.get("X-Group-Key");
  return key ? env.DB.prepare("SELECT id, name, people_json FROM groups WHERE id = ? AND key_hash = ?").bind(groupId, await digest(key)).first() : null;
}
async function createShortLink(env, group, key) {
  if (!env.SHORTLINK || !env.SHORTLINK_ADMIN_TOKEN) return null;
  // A stable code lets existing groups recover their short link after a reload.
  const code = group.id.replaceAll("-", "").slice(0, 12);
  const target = `https://peige880-lab232.github.io/shared-ledger/#${new URLSearchParams({ group: group.id, key, name: group.name })}`;
  const response = await env.SHORTLINK.fetch(`https://share-ledge/api/links/${code}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": env.SHORTLINK_ADMIN_TOKEN }, body: JSON.stringify({ target, status: 302 }),
  });
  return response.ok ? `https://share-ledge.peige880.workers.dev/${code}` : null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(request) });
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    try {
      if (request.method === "POST" && parts.join("/") === "groups") {
        const body = await request.json();
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
        const people = names(body.people);
        if (!name || !people.length) return out(request, { error: "請提供群組名稱與至少一位成員。" }, 400);
        const id = uid(), key = secret(), group = { id, name, people };
        await env.DB.prepare("INSERT INTO groups (id,key_hash,name,people_json,created_at) VALUES (?,?,?,?,?)").bind(id, await digest(key), name, JSON.stringify(people), new Date().toISOString()).run();
        return out(request, { group, key, shortUrl: await createShortLink(env, group, key) }, 201);
      }
      if (parts[0] !== "groups" || !parts[1]) return out(request, { error: "找不到服務路徑。" }, 404);
      const group = await access(request, env, parts[1]);
      if (!group) return out(request, { error: "邀請連結無效或沒有存取權。" }, 403);
      const publicGroup = { id: group.id, name: group.name, people: jsonArray(group.people_json) };
      if (request.method === "GET" && parts.length === 2) {
        const rows = await env.DB.prepare("SELECT * FROM expenses WHERE group_id = ? ORDER BY created_at DESC").bind(group.id).all();
        return out(request, { group: publicGroup, expenses: rows.results.map(render), shortUrl: await createShortLink(env, publicGroup, request.headers.get("X-Group-Key")) });
      }
      if (request.method === "POST" && parts[2] === "expenses" && parts.length === 3) {
        const body = await request.json();
        const item = typeof body.item === "string" ? body.item.trim().slice(0, 200) : "";
        const amount = round(Number(body.amount));
        const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
        const payers = allocations(body.payments, publicGroup.people, "amount");
        const shares = allocations(body.splits, publicGroup.people, "percentage");
        const paidTotal = payers ? round(payers.reduce((total, payer) => total + payer.amount, 0)) : 0;
        if (!item || !Number.isFinite(amount) || amount <= 0 || !payers?.length || !shares?.length || payers.some(payer => payer.amount <= 0) || shares.some(share => share.percentage <= 0) || Math.abs(paidTotal - amount) > 0.01) {
          return out(request, { error: "帳目資料不完整，實付合計必須等於總金額，且每位分攤成員的比例必須大於 0。" }, 400);
        }
        const id = uid(), created_at = new Date().toISOString();
        const legacyPeople = shares.map(share => share.person);
        const payer = payers[0].person;
        await env.DB.prepare("INSERT INTO expenses (id,group_id,payer,item,amount,people_json,note,created_at,payers_json,shares_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(id, group.id, payer, item, amount, JSON.stringify(legacyPeople), note, created_at, JSON.stringify(payers), JSON.stringify(shares)).run();
        return out(request, { expense: render({ id, payer, item, amount, people_json: JSON.stringify(legacyPeople), note, created_at, payers_json: JSON.stringify(payers), shares_json: JSON.stringify(shares) }) }, 201);
      }
      if (request.method === "DELETE" && parts[2] === "expenses" && parts.length === 4) {
        await env.DB.prepare("DELETE FROM expenses WHERE id = ? AND group_id = ?").bind(parts[3], group.id).run();
        return out(request, { ok: true });
      }
      return out(request, { error: "找不到服務路徑。" }, 404);
    } catch (error) { return out(request, { error: "伺服器暫時無法處理此要求。" }, 500); }
  },
};
