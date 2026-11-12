// A live feed of one PostHog project's events, shown as a side panel. Works in any layout; in a
// Nightdrive one it takes Nightdrive's titles (look.js).
// props (all optional): { project: <project id>, label?: "Staging", prod?: true,
//          host?: "https://eu.posthog.com", block?: "<this block's id in the layout>" }
// Without a project in its props, it asks: US or EU cloud, a personal API key, then which project
// (kept per block in shared "posthog.projects"). The key lives in the system keychain.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, theme, props, layout, setShared, shared, window } from "herdr";
import { title } from "./look.js";

// PostHog Cloud US; EU projects pass host: "https://eu.posthog.com".
const DEFAULT_HOST = "https://us.posthog.com";
// Keychain service. The account is the host, so one key serves every panel on that host.
const SERVICE = "posthog-feed";
const POLL_MS = 10000;          // ~360 queries/hour per shown panel; the project allows 2,400
const BACKFILL_MS = 15 * 60000;
const PAGE = 500;
const KEEP = 500;
const ROW_H = 46;

// Rows are keyed by ingestion time (created_at), not event time: mobile SDKs batch,
// and events captured offline can land hours late. The event-time bound keeps the scan small.
const sql = (cursorMs) => `
  SELECT toString(uuid),
         toUnixTimestamp64Milli(timestamp),
         toUnixTimestamp64Milli(created_at),
         event,
         coalesce(person.properties.email, person.properties.name, distinct_id),
         coalesce(properties.$os, properties.$lib, ''),
         coalesce(properties.$screen_name, properties.$pathname, properties.$feature_flag,
                  properties.$exception_types, '')
  FROM events
  WHERE timestamp >= now() - INTERVAL 2 DAY
    AND created_at >= fromUnixTimestamp64Milli(${Math.floor(cursorMs)})
  ORDER BY created_at ASC
  LIMIT ${PAGE}`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const HOSTS = [["US", "https://us.posthog.com"], ["EU", "https://eu.posthog.com"]];
const CHOICES = "posthog.projects"; // block -> { project, name, host }

// The key, in the system keychain (macOS Keychain or Linux's Secret Service), one per host.
const platform = () => window()?.platform ?? "macos";
const keychain = () => (platform() === "macos" ? "macOS Keychain" : "keychain");
async function readKey(account) {
  const os = platform();
  const r = os === "macos" ? await exec("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { timeout: 8000 }).catch(() => null)
    : os === "linux" ? await exec("secret-tool", ["lookup", "service", SERVICE, "account", account], { timeout: 8000 }).catch(() => null) : null;
  return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
async function writeKey(account, key) {
  const os = platform();
  const r = os === "macos" ? await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", key], { timeout: 8000 })
    : os === "linux" ? await exec("sh", ["-c", `printf %s "$1" | secret-tool store --label="PostHog key" service ${SERVICE} account "$2"`, "sh", key, account], { timeout: 8000 })
    : { code: 1, stderr: "keeping the key isn't supported on this system yet" };
  if (r.code !== 0) throw new Error((r.stderr || "couldn't keep the key").trim());
}

// The projects a key can see, for the picker.
async function projects(key, host) {
  const res = await fetch(`${host}/api/projects/`, { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) { const err = new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`); err.status = res.status; throw err; }
  return (JSON.parse(text).results ?? []).map((p) => ({ id: Number(p.id), name: String(p.name ?? p.id) }));
}

async function query(key, host, projectId, hogql) {
  const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    // API queries are cached by default; a feed needs fresh rows.
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql }, refresh: "force_blocking", name: "herdr posthog panel" }),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()).results ?? [];
}

const pad = (n) => String(n).padStart(2, "0");
function when(ms) {
  const d = new Date(ms), now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time.slice(0, 5)}`;
}
function lateness(row) {
  const mins = Math.floor((row.created - row.ts) / 60000);
  if (mins < 1) return "";
  return mins < 120 ? `${mins}m late` : mins < 2880 ? `${Math.floor(mins / 60)}h late` : `${Math.floor(mins / 1440)}d late`;
}
const shortWho = (who) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(who) ? who.slice(0, 8) + "…" : who;

export default class PostHogFeed extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    // Its layout block, so it can pause while hidden. A stack needs one block (and one copy) per panel.
    this.block = given.block ?? "posthog";
    // The project: from props, else the one picked here before (shared "posthog.projects"), else asked.
    this.fixed = given.project != null;
    const chosen = this.fixed ? null : (shared(CHOICES) ?? {})[this.block];
    this.setProject(given.project ?? chosen?.project, given.label ?? chosen?.name, given.host ?? chosen?.host ?? DEFAULT_HOST);
    this.prod = given.prod === true;
    // In the panel dock (mods/nightdrive-dock) it shows when the dock says so, not by its own block.
    this.inDock = Boolean(given.dock);
    this.rows = []; this.seen = new Set();
    this.cursor = Date.now() - BACKFILL_MS;
    this.key = null; this.badKey = null; this.loaded = false;
    this.busy = false; this.nextAt = 0; this.error = null; this.lastOk = null;
    this.filter = ""; this.keyNote = null; this.saving = false;

    this.filterInput = InputState.new({ placeholder: "Filter events, people, screens" });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value().trim().toLowerCase(); cx.notify(); });
    this.keyInput = InputState.new({ placeholder: "phx_…" });
    this.keyInput.set_masked(true);
    this.keyInput.on("submit", (_e, cx) => this.saveKey(cx));
    this.idInput = InputState.new({ placeholder: "Project id: the number after /project/ in its URL" });
    this.idInput.on("submit", (_e, cx) => this.pickId(cx));

    this.tick(cx);
    cx.timer.every(POLL_MS, (cx) => this.tick(cx));
  }

  // Polls only while its block is on screen, then catches up from its cursor:
  // nothing above it hidden, and every stack above it showing the branch it's on.
  visible() {
    if (this.inDock) return (shared("dock")?.shown ?? []).includes(this.block);
    const root = layout(), id = this.block;
    if (!find(root, id)) return true;
    const shown = (node) => {
      if (!node || node.hidden) return false;
      if (node.id === id) return true;
      const kids = node.children ?? [];
      if (node.type === "stack") return shown(kids.find((c) => c.id === node.active) ?? kids[0]);
      return kids.some(shown);
    };
    return shown(root);
  }

  setProject(id, name, host) {
    this.host = String(host ?? DEFAULT_HOST).replace(/\/+$/, "");
    this.account = this.host.replace(/^https?:\/\//, "");
    this.projectId = Number(id);
    this.configured = Number.isInteger(this.projectId) && this.projectId > 0;
    this.label = name ?? (this.configured ? `Project ${this.projectId}` : "No project");
  }

  // Keeps a project picked here (not one from props) for this block, and starts the feed.
  choose(project, cx) {
    const all = { ...(shared(CHOICES) ?? {}) };
    all[this.block] = { project: project.id, name: project.name, host: this.host };
    setShared(CHOICES, all);
    this.setProject(project.id, project.name, this.host);
    this.picking = false;
    this.rows = []; this.seen = new Set(); this.cursor = Date.now() - BACKFILL_MS; this.lastOk = null; this.error = null;
    this.tick(cx);
    cx.notify();
  }

  pickId(cx) {
    const id = Number(this.idInput.value().trim());
    if (!Number.isInteger(id) || id <= 0) { this.pickNote = "A project id is a number."; cx.notify(); return; }
    this.choose({ id, name: (this.choices ?? []).find((x) => x.id === id)?.name ?? `Project ${id}` }, cx);
  }

  // The picker's list: the projects the key can see (it needs the Project: Read scope for this).
  loadChoices(cx) {
    if (this.loadingChoices || !this.key) return;
    this.loadingChoices = true; this.pickNote = null;
    cx.spawn(async (cx) => {
      try { this.choices = await projects(this.key, this.host); }
      catch (e) { this.choices = []; this.pickNote = `PostHog didn't list the projects (${e.status ? `HTTP ${e.status}` : e.message ?? e}): type the id instead.`; }
      this.loadingChoices = false;
      cx.notify();
    });
  }

  tick(cx) {
    if (this.busy) return;
    // No project yet: only the key is needed, then the picker.
    if (!this.configured) {
      if (this.key || this.loaded) return;
      this.busy = true;
      cx.spawn(async (cx) => {
        try { this.key = await readKey(this.account); } finally { this.loaded = true; this.busy = false; cx.notify(); }
      });
      return;
    }
    if (Date.now() < this.nextAt || (this.loaded && !this.visible())) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.key) {
          const stored = await readKey(this.account);
          this.key = stored && stored !== this.badKey ? stored : null;
          this.loaded = true;
          if (!this.key || !this.visible()) return;
        }
        let page;
        do {
          page = await query(this.key, this.host, this.projectId, sql(this.cursor));
          this.add(page);
        } while (page.length === PAGE);
        this.error = null; this.lastOk = Date.now();
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          this.badKey = this.key; this.key = null;
          this.keyNote = `PostHog refused the saved key (HTTP ${e.status}). Paste a new one with the Query: Read scope.`;
        } else if (e.status === 429) {
          this.error = "Rate limited by PostHog; pausing a minute."; this.nextAt = Date.now() + 60000;
        } else {
          this.error = `Can't reach PostHog: ${e.message ?? e}`; this.nextAt = Date.now() + 30000;
        }
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  add(page) {
    for (const [id, ts, created, event, who, platform, place] of page) {
      this.cursor = Math.max(this.cursor, created);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.rows.unshift({ id, ts, created, event, who: who ?? "", platform: platform ?? "", place: place ?? "" });
    }
    if (this.rows.length > KEEP) this.rows.length = KEEP;
    if (this.seen.size > 5000) this.seen = new Set(this.rows.map((r) => r.id));
  }

  saveKey(cx) {
    const key = this.keyInput.value().trim();
    if (this.saving) return;
    if (!/^phx_[A-Za-z0-9]+$/.test(key)) { this.keyNote = "Personal API keys start with phx_."; cx.notify(); return; }
    this.saving = true; this.keyNote = null;
    cx.spawn(async (cx) => {
      try {
        // With a project, the key must be able to query it; without one yet, to list projects.
        if (this.configured) await query(key, this.host, this.projectId, "SELECT 1");
        else this.choices = await projects(key, this.host).catch((e) => { if (e.status === 401) throw e; this.pickNote = "This key can't list projects (it needs Project: Read): type the id instead."; return []; });
        await writeKey(this.account, key);
        this.key = key; this.badKey = null; this.keyInput.set_value("");
        this.saving = false; this.tick(cx);
      } catch (e) {
        this.keyNote = e.status ? `PostHog rejected that key (HTTP ${e.status}).` : `Couldn't save the key: ${e.message ?? e}`;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  open(url) {
    const os = platform();
    const [cmd, args] = os === "macos" ? ["open", [url]] : os === "windows" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    exec(cmd, args).catch(() => {});
  }

  color(event, t) {
    const lower = event.toLowerCase();
    if (event === "$exception" || lower.includes("error") || lower.includes("fail")) return t.ansi1;
    if (event === "$identify") return t.ansi5;
    if (event === "$pageview" || event === "$screen") return t.foreground;
    if (event.startsWith("$") || event.startsWith("Application ")) return t.dim;
    return t.ansi2;
  }

  eventUrl(r) {
    return `${this.host}/project/${this.projectId}/events/${r.id}/${encodeURIComponent(new Date(r.ts).toISOString())}`;
  }

  // Runs inside the list's layout pass: no handlers here (they throw); clicks go
  // through the list's on_item_click.
  row(r, t) {
    const late = lateness(r);
    return v_flex().h(ROW_H).flex_none().px(12).justify_center().gap(2)
      .border_b(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(this.color(r.event, t)).child(r.event))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(when(r.ts))))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
        .when(Boolean(r.platform), (el) => el.child(div().flex_none().max_w(90).truncate().text_color(t.ansi6).child(r.platform)))
        .child(div().flex_none().max_w(150).truncate().child(shortWho(r.who)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.place))
        .when(Boolean(late), (el) => el.child(div().flex_none().text_color(t.blocked).child(late))));
  }

  keyForm(t) {
    const keysUrl = this.configured ? `${this.host}/project/${this.projectId}/settings/user-api-keys` : `${this.host}/settings/user-api-keys`;
    return v_flex().p(14).gap(10).text_size(12.5).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child("Connect PostHog"))
      .when(!this.fixed && !this.configured, (el) => el.child(h_flex().gap(6).items_center().child(div().child("Cloud"))
        .children(HOSTS.map(([name, url]) => div().id(`ph-host-${name}`).h(24).px(10).flex().items_center().cursor_pointer().text_size(11)
          .border_1().border_color(this.host === url ? t.accent : t.border).text_color(this.host === url ? t.accent : t.muted)
          .on_click((_e, cx) => { this.setProject(null, null, url); this.key = null; this.loaded = false; this.tick(cx); cx.notify(); }).child(name)))))
      .child(div().child(`This panel reads events with a PostHog personal API key. Create one with the Query: Read${this.configured ? "" : " and Project: Read"} scopes and paste it here. It's kept in your ${keychain()} and shared by every PostHog panel on ${this.account}.`))
      .child(div().id("create-key").text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click(() => this.open(keysUrl)).child("Create a key in PostHog ↗"))
      .child(h_flex().gap(8)
        .child(div().id("key-field").flex_1().min_w(0).h(32).px(10).flex().items_center().border_1().border_color(t.input)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.keyInput).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("save-key").h(32).px(14).flex().items_center().bg(t.solid).text_color(t.solid_foreground)
          .cursor_pointer().on_click((_e, cx) => this.saveKey(cx)).child(this.saving ? "Checking…" : "Save")))
      .when(Boolean(this.keyNote), (el) => el.child(div().text_color(t.ansi1).child(this.keyNote)));
  }

  // Which project to follow: the ones the key can see, or an id typed in.
  picker(t) {
    const list = this.choices ?? [];
    return v_flex().p(14).gap(10).text_size(12.5).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child("Which project?"))
      .when(this.choices == null, (el) => el.child(div().text_color(t.dim).child("Listing your projects…")))
      .children(list.map((x) => h_flex().id(`ph-pick-${x.id}`).h(34).px(10).gap(8).items_center().cursor_pointer()
        .border_1().border_color(x.id === this.projectId ? t.accent : t.border).hover((s) => s.bg(t.hover).border_color(t.accent))
        .on_click((_e, cx) => this.choose(x, cx))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.name))
        .child(div().text_size(11).text_color(t.dim).child(String(x.id)))))
      .child(h_flex().gap(8)
        .child(div().id("ph-id").flex_1().min_w(0).h(32).px(10).flex().items_center().border_1().border_color(t.input)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.idInput).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("ph-id-go").h(32).px(14).flex().items_center().bg(t.solid).text_color(t.solid_foreground)
          .cursor_pointer().on_click((_e, cx) => this.pickId(cx)).child("Use")))
      .when(Boolean(this.pickNote), (el) => el.child(div().text_color(t.ansi1).child(this.pickNote)));
  }

  render(cx) {
    const t = theme();
    // A key but no project yet (or a change asked for): the picker, which lists the projects once.
    if (this.key && (!this.configured || this.picking) && this.choices == null && !this.loadingChoices) cx.timer.after(1, (cx) => this.loadChoices(cx));
    const shown = this.visible();
    if (shown && !this.wasShown) this.tick(cx); // catch up as soon as it's opened
    this.wasShown = shown;

    const f = this.filter;
    const list = f ? this.rows.filter((r) => `${r.event} ${r.who} ${r.place} ${r.platform}`.toLowerCase().includes(f)) : this.rows;
    const status = !this.configured ? ["No project", t.blocked] : !this.loaded ? ["Connecting", t.dim]
      : !this.key ? ["No key", t.blocked] : this.error ? ["Error", t.ansi1] : ["Live", t.ansi2];
    const listId = `${this.block}-list`;

    return v_flex().id(this.block).size_full().min_h(0).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/posthog/activity.svg").size(14).text_color(t.muted))
        .child(h_flex().gap(6).items_center().children(title(t, "POSTHOG")))
        .child(div().id("ph-project").px(5).py(1).border_1().text_size(10)
          .border_color(this.prod ? t.ansi1 : t.border).text_color(this.prod ? t.ansi1 : t.muted)
          // A project picked here (not set by the layout) can be changed: click its name.
          .when(!this.fixed && Boolean(this.key), (el) => el.cursor_pointer().hover((s) => s.border_color(t.accent)).tooltip("Change project")
            .on_click((_e, cx) => { this.picking = !this.picking; if (this.picking) this.choices = null; cx.notify(); }))
          .child(this.label))
        .child(div().flex_1())
        .child(div().size(6).bg(status[1]))
        .child(div().text_size(11).text_color(t.muted).child(status[0])))
      .when(Boolean(this.key) && (!this.configured || this.picking), (el) => el.child(this.picker(t)))
      .when(Boolean(this.key) && this.configured && !this.picking, (el) => el
        .child(h_flex().h(40).flex_none().px(10).items_center().border_b(1).border_color(t.border)
          .child(div().id("filter").flex_1().min_w(0).h(28).px(8).flex().items_center().border_1().border_color(t.border)
            .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.filterInput).h_full().text_size(12).text_color(t.foreground))))
        .child(div().flex_1().min_h(0).relative()
          .child(v_virtual_list(listId, list.length, ROW_H, (i) => list[i].id,
            (range) => list.slice(range.start, range.end).map((r) => this.row(r, t))).size_full()
            .on_item_click((id) => { const r = this.rows.find((x) => x.id === id); if (r) this.open(this.eventUrl(r)); }))
          .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0())
          .when(!list.length, (e) => e.child(div().absolute().top(10).px(14).text_size(12).text_color(t.dim)
            .child(f ? "No events match the filter" : this.lastOk ? "No events in the last 15 minutes yet. New ones appear here as they arrive." : "Loading events…"))))
        .when(Boolean(this.error), (e) => e.child(div().px(12).py(6).flex_none().border_t(1).border_color(t.border).text_size(11).text_color(t.ansi1).child(this.error))))
      .when(!this.key && this.loaded, (el) => el.child(this.keyForm(t)));
  }
}
