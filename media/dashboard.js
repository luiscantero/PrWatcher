// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is provided by VS Code.
  const vscode = acquireVsCodeApi();
  /** @type {{ filter: string, search: string, flat: boolean, collapsed: Record<string, boolean>, closedOpen: Record<string, boolean> }} */
  const ui = Object.assign({ filter: "all", search: "", flat: false, collapsed: {}, closedOpen: {} }, vscode.getState() || {});
  // The separate Active filter was merged into the first one.
  if (ui.filter === "active") {
    ui.filter = "all";
  }
  /** @type {any} */
  let state;

  const toolbar = /** @type {HTMLElement} */ (document.getElementById("toolbar"));
  const content = /** @type {HTMLElement} */ (document.getElementById("content"));

  /**
   * @param {string} tag
   * @param {Record<string, any>} [props]
   * @param {...any} children
   * @returns {HTMLElement}
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key.startsWith("on")) {
        el.addEventListener(key.slice(2), value);
      } else if (key === "className") {
        el.className = value;
      } else {
        el.setAttribute(key, String(value));
      }
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) {
        continue;
      }
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  /** @param {string} name @param {string} [cls] @param {string} [title] */
  function icon(name, cls, title) {
    const [glyph, modifier] = name.split("~");
    return h("span", {
      className: `codicon codicon-${glyph}${modifier ? ` codicon-modifier-${modifier}` : ""}${cls ? ` ${cls}` : ""}`,
      title,
      "aria-label": title,
      role: title ? "img" : undefined,
    });
  }

  function save() {
    vscode.setState(ui);
  }

  /** @param {string} command @param {any[]} [args] */
  function run(command, args) {
    vscode.postMessage({ type: "command", command, args });
  }

  /** @param {string} url */
  function open(url) {
    vscode.postMessage({ type: "open", url });
  }

  /** @param {string | undefined} iso */
  function ago(iso) {
    if (!iso) {
      return "";
    }
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
      return `${hours}h ago`;
    }
    return `${Math.round(hours / 24)}d ago`;
  }

  /** @param {string | undefined} iso */
  function remaining(iso) {
    if (!iso) {
      return "";
    }
    const hours = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 3600000));
    return hours < 1 ? "less than an hour" : `${hours}h`;
  }

  /** @param {string} iso */
  function fullDate(iso) {
    return new Date(iso).toLocaleString();
  }

  const PHASES = {
    draft: ["git-pull-request-draft", "muted"],
    conflicts: ["warning", "warn"],
    validationFailed: ["error", "bad"],
    rejected: ["circle-slash", "bad"],
    waitingForAuthor: ["debug-pause", "warn"],
    reapproval: ["history", "warn"],
    needsReview: ["eye", "info"],
    validationRunning: ["sync~spin", "info"],
    blocked: ["lock", "warn"],
    ready: ["pass", "good"],
    autoComplete: ["pass-filled", "good"],
    merged: ["git-merge", "merged"],
    abandoned: ["git-pull-request-closed", "muted"],
  };

  /** Phases whose icon says it all, so their label is only in the icon's tooltip. */
  const QUIET_PHASES = new Set(["validationRunning", "ready", "merged", "abandoned"]);

  const CHECK_ICONS = {
    approved: ["pass", "good", "passed"],
    rejected: ["error", "bad", "failed"],
    broken: ["warning", "bad", "broken"],
    expired: ["history", "warn", "expired, queue it again"],
    running: ["sync~spin", "info", "running"],
    queued: ["clock", "info", "queued"],
  };

  /** @param {number} vote */
  function voteText(vote) {
    if (vote >= 10) return "approved";
    if (vote >= 5) return "approved with suggestions";
    if (vote <= -10) return "rejected";
    if (vote <= -5) return "waiting for author";
    return "no vote yet";
  }

  /** @param {any} pr */
  function reviewersCell(pr) {
    const cell = h("div", { className: "reviewers" });
    if (pr.status !== "active") {
      return cell;
    }
    const lines = [...pr.reviewers]
      .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.required) - Number(a.required) || b.vote - a.vote || Number(a.group) - Number(b.group))
      .map((/** @type {any} */ r) => {
        const notes = [r.required ? "required" : "", r.stale ? "of an earlier push" : "", r.declined ? "declined" : "", r.me ? (r.group ? "your group" : "you") : ""].filter(Boolean);
        return `• ${r.name}: ${voteText(r.vote)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
      });
    cell.title = lines.length > 0 ? `Reviewers:\n${lines.join("\n")}` : "No reviewers";
    const needed = pr.requiredApprovals;
    const enough = needed !== undefined ? pr.approvals >= needed : pr.approvals > 0;
    cell.append(h("span", { className: `approvals ${enough ? "good" : "muted"}` }, needed !== undefined ? `${pr.approvals}/${needed}` : `${pr.approvals}`));
    const people = pr.reviewers.filter((/** @type {any} */ r) => !r.group);
    const extra = [
      { count: people.filter((/** @type {any} */ r) => r.vote === -5).length, glyph: "debug-pause", cls: "warn" },
      { count: people.filter((/** @type {any} */ r) => r.vote === -10).length, glyph: "close", cls: "bad" },
    ];
    for (const e of extra) {
      if (e.count > 0) {
        cell.append(h("span", { className: `approvals ${e.cls}` }, icon(e.glyph), String(e.count)));
      }
    }
    return cell;
  }

  /** @param {any} pr */
  function checksCell(pr) {
    const cell = h("div", { className: "checks" });
    if (pr.status !== "active") {
      return cell;
    }
    const builds = pr.checks.filter((/** @type {any} */ c) => c.kind === "build" && (c.blocking || c.status === "rejected" || c.status === "broken"));
    // Optional policies do not block completion, so only blocking ones are shown (and optional builds that failed, above).
    const others = pr.checks.filter((/** @type {any} */ c) => c.kind !== "build" && c.kind !== "reviewers" && c.blocking);
    for (const c of builds) {
      const [glyph, cls, text] = CHECK_ICONS[c.status];
      const title = `${c.name}: ${text}${c.blocking ? "" : " (optional)"}`;
      const el = h("span", { className: `check${c.blocking ? "" : " optional"}${c.url ? " link" : ""}`, title }, icon(glyph, cls, title));
      if (c.url) {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          open(c.url);
        });
      }
      cell.append(el);
    }
    // One icon for the other policies: a lock with the unmet (or pending) ones, green when all are met.
    const met = others.filter((/** @type {any} */ c) => c.status === "approved");
    const unmet = others.filter((/** @type {any} */ c) => c.status !== "approved");
    if (others.length > 0) {
      const list = (/** @type {any[]} */ cs) => cs.map((c) => `• ${c.name}${c.status === "running" || c.status === "queued" ? " (pending)" : ""}`).join("\n");
      const sections = [unmet.length > 0 ? `Policies not met:\n${list(unmet)}` : "", met.length > 0 ? `Policies met:\n${list(met)}` : ""].filter(Boolean);
      const title = sections.join("\n\n");
      cell.append(
        unmet.length > 0
          ? h("span", { className: "check summary warn", title }, icon("lock"), String(unmet.length))
          : h("span", { className: "check summary good", title }, icon("pass"), String(met.length)),
      );
    }
    return cell;
  }

  /** @param {any} pr */
  function extrasCell(pr) {
    const cell = h("div", { className: "extras" });
    if (pr.conflicts) {
      cell.append(icon("warning", "warn", "Merge conflicts"));
    }
    if (pr.unresolvedComments > 0) {
      const title = `${pr.unresolvedComments} unresolved comment thread(s)`;
      cell.append(h("span", { className: "comments warn", title }, icon("comment-discussion"), String(pr.unresolvedComments)));
    }
    if (pr.autoComplete) {
      const strategy = pr.autoComplete.mergeStrategy ? `, ${pr.autoComplete.mergeStrategy}` : "";
      cell.append(icon("rocket", "good", `Auto-complete set by ${pr.autoComplete.setBy}${strategy}`));
    }
    const copy = h("button", { className: "icon-button row-action", title: "Copy link", "aria-label": "Copy link" }, icon("copy"));
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "copy", text: pr.url });
    });
    cell.append(copy);
    return cell;
  }

  /** @param {any} pr @param {any} repo */
  function row(pr, repo) {
    const [glyph, cls] = PHASES[/** @type {keyof typeof PHASES} */ (pr.phase)] || ["git-pull-request", ""];
    const closed = pr.status !== "active";
    const meta = [];
    if (ui.flat) {
      meta.push(repo.name);
    }
    meta.push(pr.author);
    const when = closed
      ? `${pr.status === "completed" ? "merged" : "abandoned"} ${ago(pr.closed)} · hidden in ${remaining(pr.expires)}`
      : `opened ${ago(pr.created)}`;
    // The icon already says these; the label only adds what it cannot (who, which build, which policy).
    const showLabel = !QUIET_PHASES.has(pr.phase) && pr.phaseLabel !== "Needs review";
    const title = h("a", { className: "title", href: pr.url, title: `${pr.title}\n!${pr.id} · ${pr.source} → ${pr.target}` }, pr.title);
    title.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      open(pr.url);
    });
    const el = h(
      "div",
      {
        className: `pr${closed ? " closed" : ""}${pr.needsMyReview ? " needs-me" : ""}`,
        tabindex: "0",
        role: "row",
      },
      h("div", { className: "phase" }, icon(glyph, cls, pr.phaseLabel)),
      h(
        "div",
        { className: "main" },
        h(
          "div",
          { className: "line1" },
          title,
          pr.draft ? h("span", { className: "badge muted" }, "Draft") : null,
          pr.mine ? h("span", { className: "badge" }, "Yours") : null,
        ),
        h(
          "div",
          { className: "line2" },
          showLabel ? h("span", { className: `phase-label ${cls}` }, `${pr.phaseLabel} · `) : null,
          h("span", { title: closed ? fullDate(pr.closed) : fullDate(pr.created) }, `${meta.join(" · ")} · ${when}`),
          h("span", { className: "branch", title: `${pr.source} → ${pr.target}` }, ` · → ${pr.target}`),
        ),
      ),
      reviewersCell(pr),
      checksCell(pr),
      extrasCell(pr),
    );
    el.addEventListener("click", () => open(pr.url));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        open(pr.url);
      }
    });
    return el;
  }

  /** @param {any} pr */
  function matches(pr) {
    switch (ui.filter) {
      case "review":
        if (!pr.needsMyReview) return false;
        break;
      case "mine":
        if (!pr.mine) return false;
        break;
      case "closed":
        if (pr.status === "active") return false;
        break;
    }
    const q = ui.search.trim().toLowerCase();
    if (!q) {
      return true;
    }
    return [pr.title, pr.author, String(pr.id), pr.source, pr.target, pr.phaseLabel].some((s) => s && s.toLowerCase().includes(q));
  }

  /** @param {any} a @param {any} b */
  function order(a, b) {
    const active = Number(b.status === "active") - Number(a.status === "active");
    if (active !== 0) {
      return active;
    }
    return a.status === "active" ? Date.parse(b.created) - Date.parse(a.created) : Date.parse(b.closed) - Date.parse(a.closed);
  }

  function renderToolbar() {
    const all = state ? state.repos.flatMap((/** @type {any} */ r) => r.prs) : [];
    const count = (/** @type {(pr: any) => boolean} */ f) => all.filter(f).length;
    const filters = [
      // Active pull requests, with the merged ones collapsed below.
      ["all", "Active", count((pr) => pr.status === "active")],
      ["review", "Needs review", count((pr) => pr.needsMyReview)],
      ["mine", "Mine", count((pr) => pr.mine && pr.status === "active")],
      ["closed", "Recently closed", count((pr) => pr.status !== "active")],
    ];
    const search = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "Filter by title, author, branch…", value: ui.search, "aria-label": "Filter" }));
    search.addEventListener("input", () => {
      ui.search = search.value;
      save();
      renderContent();
    });
    const updated = state?.loading ? "Refreshing…" : state?.updated ? `Updated ${ago(state.updated)}` : "";
    const previous = toolbar.querySelector("input");
    const focused = previous !== null && document.activeElement === previous;
    const selection = focused ? [previous.selectionStart, previous.selectionEnd] : undefined;
    toolbar.replaceChildren(
      h(
        "div",
        { className: "filters", role: "tablist" },
        filters.map(([id, label, n]) => {
          const b = h("button", { className: `filter${ui.filter === id ? " selected" : ""}`, role: "tab", "aria-selected": ui.filter === id ? "true" : "false" }, label, h("span", { className: "count" }, String(n)));
          b.addEventListener("click", () => {
            ui.filter = /** @type {string} */ (id);
            save();
            render();
          });
          return b;
        }),
      ),
      h("div", { className: "spacer" }),
      search,
      h("span", { className: "updated", title: state?.updated ? fullDate(state.updated) : undefined }, updated),
      toolButton(ui.flat ? "list-tree" : "list-flat", ui.flat ? "Group by repository" : "Show as one list", () => {
        ui.flat = !ui.flat;
        save();
        render();
      }),
      toolButton(state?.loading ? "sync~spin" : "refresh", "Refresh", () => run("prWatcher.refresh")),
      toolButton("add", "Add repository…", () => run("prWatcher.addRepository")),
      toolButton("gear", "Settings", () => run("prWatcher.openSettings")),
    );
    if (selection) {
      search.focus();
      search.setSelectionRange(selection[0], selection[1]);
    }
  }

  /** @param {string} glyph @param {string} title @param {() => void} onclick */
  function toolButton(glyph, title, onclick) {
    const b = h("button", { className: "icon-button", title, "aria-label": title }, icon(glyph));
    b.addEventListener("click", onclick);
    return b;
  }

  /** @param {string} glyph @param {string} text @param {string} [label] @param {() => void} [action] @param {string} [cls] */
  function banner(glyph, text, label, action, cls) {
    const b = h("div", { className: `banner ${cls || ""}` }, icon(glyph), h("span", {}, text));
    if (label && action) {
      const button = h("button", { className: "primary" }, label);
      button.addEventListener("click", action);
      b.append(button);
    }
    return b;
  }

  /** @param {any} repo @param {any[]} prs */
  function repoSection(repo, prs) {
    const collapsed = !!ui.collapsed[repo.key];
    const header = h(
      "div",
      { className: "repo-header", role: "button", tabindex: "0", "aria-expanded": collapsed ? "false" : "true" },
      icon(collapsed ? "chevron-right" : "chevron-down"),
      icon("repo"),
      h("span", { className: "repo-name" }, repo.name),
      h("span", { className: "muted" }, `${repo.organization}/${repo.project}`),
      h("span", { className: "authors", title: "Whose pull requests are shown" }, icon("person"), repo.authorsLabel),
      h("span", { className: "count", title: "Active pull requests" }, String(prs.filter((/** @type {any} */ pr) => pr.status === "active").length)),
      repo.error ? icon("error", "bad", repo.error) : null,
      h("span", { className: "spacer" }),
    );
    const actions = [
      ["link-external", "Open pull requests in the browser", () => open(`${repo.url}/pullrequests?_a=active`)],
      ["person", "Edit watched authors…", () => run("prWatcher.editAuthors", [repo.key])],
      ["close", "Remove repository…", () => run("prWatcher.removeRepository", [repo.key])],
    ];
    for (const [glyph, title, action] of actions) {
      const b = toolButton(/** @type {string} */ (glyph), /** @type {string} */ (title), /** @type {() => void} */ (action));
      b.addEventListener("click", (e) => e.stopPropagation());
      header.append(b);
    }
    const toggle = () => {
      ui.collapsed[repo.key] = !collapsed;
      save();
      renderContent();
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()));
    const section = h("section", { className: "repo" }, header);
    if (!collapsed) {
      if (repo.error) {
        section.append(h("div", { className: "repo-error" }, icon("error", "bad"), ` ${repo.error}`));
      }
      section.append(prList(prs.map((pr) => ({ pr, repo })), repo.key, false));
    }
    return section;
  }

  /**
   * Active pull requests, then the merged (and abandoned) ones under a collapsed toggle, except in the Recently closed filter.
   * @param {{ pr: any, repo: any }[]} items @param {string} key @param {boolean} flat
   */
  function prList(items, key, flat) {
    if (items.length === 0) {
      return h("div", { className: "empty" }, emptyText());
    }
    const active = items.filter(({ pr }) => pr.status === "active");
    const closed = items.filter(({ pr }) => pr.status !== "active");
    const list = h("div", { className: `list${flat ? " flat" : ""}`, role: "table" }, active.map(({ pr, repo }) => row(pr, repo)));
    if (closed.length === 0) {
      return list;
    }
    if (ui.filter === "closed") {
      list.append(...closed.map(({ pr, repo }) => row(pr, repo)));
      return list;
    }
    const open = !!ui.closedOpen[key];
    const label = closed.every(({ pr }) => pr.status === "completed") ? "Merged" : "Merged or abandoned";
    const toggle = h(
      "div",
      { className: "closed-toggle", role: "button", tabindex: "0", "aria-expanded": open ? "true" : "false", title: `Closed in the last ${state.retentionHours} hours` },
      icon(open ? "chevron-down" : "chevron-right"),
      icon("git-merge", "merged"),
      h("span", {}, label),
      h("span", { className: "count" }, String(closed.length)),
    );
    const flip = () => {
      ui.closedOpen[key] = !open;
      save();
      renderContent();
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), flip()));
    list.append(toggle);
    if (open) {
      list.append(...closed.map(({ pr, repo }) => row(pr, repo)));
    }
    return list;
  }

  function emptyText() {
    switch (ui.filter) {
      case "review":
        return "Nothing needs your review.";
      case "mine":
        return "No pull requests of yours.";
      case "closed":
        return `Nothing merged or abandoned in the last ${state.retentionHours} hours.`;
      default:
        return ui.search ? "No pull requests match the filter." : "No pull requests.";
    }
  }

  function renderContent() {
    const children = [];
    if (!state) {
      content.replaceChildren(h("div", { className: "empty" }, icon("loading~spin"), " Loading…"));
      return;
    }
    if (state.signIn) {
      children.push(banner("account", state.signIn, "Sign In", () => run("prWatcher.signIn"), "warn"));
    }
    for (const p of state.problems) {
      children.push(banner("warning", `Ignored repository ${p.entry}: it ${p.message}.`, "Open Settings", () => run("prWatcher.openSettings"), "warn"));
    }
    if (state.repos.length === 0) {
      children.push(
        h(
          "div",
          { className: "welcome" },
          icon("git-pull-request", "large"),
          h("p", {}, "Watch pull requests of your team across Azure DevOps repositories."),
          (() => {
            const b = h("button", { className: "primary" }, "Add Repository…");
            b.addEventListener("click", () => run("prWatcher.addRepository"));
            return b;
          })(),
        ),
      );
    } else if (ui.flat) {
      const prs = state.repos.flatMap((/** @type {any} */ r) => r.prs.filter(matches).map((/** @type {any} */ pr) => ({ pr, repo: r })));
      prs.sort((/** @type {any} */ a, /** @type {any} */ b) => order(a.pr, b.pr));
      for (const r of state.repos.filter((/** @type {any} */ r) => r.error)) {
        children.push(banner("error", `${r.name}: ${r.error}`, undefined, undefined, "bad"));
      }
      children.push(prList(prs, "*", true));
    } else {
      for (const repo of state.repos) {
        children.push(repoSection(repo, repo.prs.filter(matches).sort(order)));
      }
    }
    content.replaceChildren(...children);
  }

  function render() {
    renderToolbar();
    renderContent();
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "state") {
      state = event.data.state;
      render();
    }
  });
  // Keep relative times current.
  setInterval(render, 60_000);
  render();
  vscode.postMessage({ type: "ready" });
})();
