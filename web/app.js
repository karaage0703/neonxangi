/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
const state = { token: "" };
const error = document.querySelector("#error");
const login = document.querySelector("#login");
const consoleView = document.querySelector("#console");
const result = document.querySelector("#settings-result");
const navigation = document.querySelector("#console-nav");
const refreshButton = document.querySelector("#refresh");

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || `Request failed: ${response.status}`);
  return value;
}

function text(tag, value) {
  const element = document.createElement(tag);
  element.textContent = String(value);
  return element;
}

function renderStatus(value) {
  const grid = document.querySelector("#status-grid");
  grid.replaceChildren();
  const fields = {
    Sandbox設定: value.sandbox || "未設定",
    権限profile: value.profile || "未設定",
    "Host Broker": value.broker?.healthy
      ? "稼働中"
      : value.settings_mode
        ? "まだ起動していません"
        : "停止中",
    設定画面: value.console?.healthy ? "稼働中" : "停止中",
  };
  for (const [label, field] of Object.entries(fields)) {
    const item = document.createElement("div");
    item.append(text("dt", label), text("dd", field));
    grid.append(item);
  }
}

function renderPolicy(value) {
  const notice = document.querySelector("#policy-notice");
  const facts = document.querySelector("#policy-facts");
  const groups = document.querySelector("#capability-groups");
  const networks = document.querySelector("#network-list");
  const platforms = document.querySelector("#platform-list");
  const output = document.querySelector("#policy-output");
  const summary = value.summary || {};

  notice.className = `policy-notice ${value.source === "active" ? "is-active" : "is-warning"}`;
  notice.replaceChildren(
    text(
      "strong",
      value.source === "active"
        ? `Sandbox「${value.sandbox}」に現在適用中`
        : "設定上のPolicyを表示中",
    ),
    text(
      "p",
      value.source === "active"
        ? value.matches_config
          ? "保存済み設定と一致しています。"
          : "保存済み設定と異なります。反映にはsandboxの再作成が必要です。"
        : "実行中のsandboxからPolicyを取得できませんでした。次回sandbox作成時の設定を表示しています。",
    ),
  );

  facts.replaceChildren();
  const factValues = {
    Profile: value.profile || "未設定",
    Backend: value.backend || "未設定",
    Workspace:
      summary.workspace_access === "read-only" ? "読み取り専用" : "読み書き可",
    Landlock: summary.landlock === "strict" ? "strict" : "best effort",
  };
  for (const [label, field] of Object.entries(factValues)) {
    const item = document.createElement("div");
    item.append(text("dt", label), text("dd", field));
    facts.append(item);
  }

  groups.replaceChildren();
  for (const definition of [
    { state: "allowed", label: "できること" },
    { state: "limited", label: "制限付き" },
    { state: "blocked", label: "できないこと" },
  ]) {
    const group = document.createElement("article");
    group.className = `capability-group state-${definition.state}`;
    group.append(text("h3", definition.label));
    const list = document.createElement("ul");
    for (const capability of (summary.capabilities || []).filter(
      (item) => item.state === definition.state,
    )) {
      const item = document.createElement("li");
      item.append(
        text("strong", capability.label),
        text("p", capability.detail),
      );
      list.append(item);
    }
    if (!list.children.length)
      list.append(text("li", "該当項目はありません。"));
    group.append(list);
    groups.append(group);
  }

  networks.replaceChildren();
  for (const network of summary.networks || []) {
    const item = document.createElement("div");
    item.className = "network-policy";
    item.append(text("strong", network.name));
    const endpointList = document.createElement("ul");
    for (const endpoint of network.endpoints)
      endpointList.append(
        text("li", `${endpoint.host}:${endpoint.port} · ${endpoint.access}`),
      );
    item.append(endpointList);
    networks.append(item);
  }
  if (!networks.children.length)
    networks.append(text("p", "許可された通信先はありません。"));

  platforms.replaceChildren();
  for (const [name, platform] of Object.entries(value.platforms || {})) {
    const item = document.createElement("div");
    item.className = "platform-policy";
    item.append(
      text(
        "strong",
        `${name === "slack" ? "Slack" : "Discord"} · ${platform.enabled ? "有効" : "無効"}`,
      ),
      text(
        "p",
        platform.enabled
          ? `許可user ${platform.allowed_users}件 / channel ${platform.allowed_channels}件 / 自動応答 ${platform.auto_reply_channels}件`
          : "メッセージを受信・送信しません。",
      ),
    );
    platforms.append(item);
  }

  output.textContent = [
    `表示元: ${value.source === "active" ? "OpenShell active policy" : "設定上の次回適用policy"}`,
    `定義file: ${value.path || "未設定"}`,
    `読み取り専用: ${(summary.read_only_paths || []).join(", ") || "なし"}`,
    `読み書き可: ${(summary.read_write_paths || []).join(", ") || "なし"}`,
  ].join("\n");
}

function showConsole() {
  login.hidden = true;
  consoleView.hidden = false;
  navigation.hidden = false;
  refreshButton.hidden = false;
  const target = window.location.hash
    ? document.querySelector(window.location.hash)
    : null;
  if (target) requestAnimationFrame(() => target.scrollIntoView());
}

function showLogin() {
  login.hidden = false;
  consoleView.hidden = true;
  navigation.hidden = true;
  refreshButton.hidden = true;
}

function lines(value) {
  return (value || []).join("\n");
}
function values(id) {
  return document
    .querySelector(id)
    .value.split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function setPlatformState(platform) {
  const enabled = document.querySelector(`#${platform}-enabled`).checked;
  const fields = document.querySelector(`[data-platform="${platform}"]`);
  fields.classList.toggle("is-disabled", !enabled);
  for (const control of fields.querySelectorAll("input, textarea"))
    control.disabled = !enabled;
}

function fillForm(value) {
  const { runtime, discord, slack, secrets } = value;
  document.querySelector("#workspace").value = runtime.workspace || "";
  document.querySelector("#backend").value = runtime.backend || "codex";
  document.querySelector("#local-llm-base-url").value =
    runtime.local_llm_base_url || "";
  document.querySelector("#local-llm-model").value =
    runtime.local_llm_model || "";
  document.querySelector("#profile").value = runtime.profile || "observe";
  document.querySelector("#sandbox-name").value =
    runtime.sandbox_name || "neonxangi";
  document.querySelector("#discord-enabled").checked = discord.enabled;
  document.querySelector("#discord-token").value = "";
  document.querySelector("#discord-limit").value =
    discord.bot_max_consecutive || 3;
  document.querySelector("#discord-users").value = lines(discord.allowed_users);
  document.querySelector("#discord-bots").value = lines(discord.allowed_bots);
  document.querySelector("#discord-channels").value = lines(
    discord.allowed_channels,
  );
  document.querySelector("#discord-auto").value = lines(
    discord.auto_reply_channels,
  );
  document.querySelector("#slack-enabled").checked = slack.enabled;
  document.querySelector("#slack-bot-token").value = "";
  document.querySelector("#slack-app-token").value = "";
  document.querySelector("#slack-users").value = lines(slack.allowed_users);
  document.querySelector("#slack-channels").value = lines(
    slack.allowed_channels,
  );
  document.querySelector("#slack-auto").value = lines(
    slack.auto_reply_channels,
  );
  document.querySelector("#discord-secret-state").textContent = secrets.discord
    ?.valid
    ? "Bot tokenは設定済みです（値は非表示）"
    : "Bot tokenは未設定です";
  document.querySelector("#slack-secret-state").textContent =
    secrets.slack_bot?.valid && secrets.slack_app?.valid
      ? "Bot/App tokenは設定済みです（値は非表示）"
      : "Bot/App tokenは未設定です";
  document.querySelector("#config-output").textContent = JSON.stringify(
    value,
    null,
    2,
  );
  setPlatformState("discord");
  setPlatformState("slack");
}

function readForm() {
  return {
    runtime: {
      workspace: document.querySelector("#workspace").value.trim(),
      backend: document.querySelector("#backend").value,
      local_llm_base_url: document
        .querySelector("#local-llm-base-url")
        .value.trim(),
      local_llm_model: document.querySelector("#local-llm-model").value.trim(),
      profile: document.querySelector("#profile").value,
      sandbox_name: document.querySelector("#sandbox-name").value.trim(),
    },
    discord: {
      enabled: document.querySelector("#discord-enabled").checked,
      token: document.querySelector("#discord-token").value.trim(),
      bot_max_consecutive: Number(
        document.querySelector("#discord-limit").value,
      ),
      allowed_users: values("#discord-users"),
      allowed_bots: values("#discord-bots"),
      allowed_channels: values("#discord-channels"),
      auto_reply_channels: values("#discord-auto"),
    },
    slack: {
      enabled: document.querySelector("#slack-enabled").checked,
      bot_token: document.querySelector("#slack-bot-token").value.trim(),
      app_token: document.querySelector("#slack-app-token").value.trim(),
      allowed_users: values("#slack-users"),
      allowed_channels: values("#slack-channels"),
      auto_reply_channels: values("#slack-auto"),
    },
  };
}

function renderChecks(value, message) {
  result.className = `result ${value.valid === false || value.ok === false ? "is-error" : "is-success"}`;
  result.replaceChildren(text("strong", message));
  if ((value.checks || []).length) {
    const list = document.createElement("ul");
    for (const check of value.checks)
      list.append(
        text(
          "li",
          `${check.status === "pass" ? "✓" : "×"} ${check.name}: ${check.detail}`,
        ),
      );
    result.append(list);
  }
}

async function withButton(button, action) {
  const original = button.textContent;
  button.disabled = true;
  button.classList.add("is-loading");
  button.textContent = "処理中…";
  error.textContent = "";
  try {
    return await action();
  } catch (cause) {
    result.className = "result is-error";
    result.textContent = cause.message;
    throw cause;
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.textContent = original;
  }
}

function renderApprovals(value) {
  const list = document.querySelector("#approval-list");
  list.replaceChildren();
  if (!value.approvals.length) {
    list.append(text("p", "承認待ちの操作はありません。"));
    return;
  }
  for (const approval of value.approvals) {
    const item = document.createElement("article");
    item.className = "approval";
    const copy = document.createElement("div");
    copy.append(
      text("strong", approval.summary),
      text(
        "p",
        `${approval.action} · ${approval.resource} · ${approval.status}`,
      ),
    );
    item.append(copy);
    if (approval.status === "pending") {
      const actions = document.createElement("div");
      actions.className = "approval-actions";
      for (const decision of ["deny", "approve"]) {
        const button = text("button", decision === "approve" ? "許可" : "拒否");
        button.className = decision;
        button.addEventListener("click", async () => {
          await api(`/api/approvals/${approval.id}/${decision}`, {
            method: "POST",
            body: "{}",
          });
          await refresh();
        });
        actions.append(button);
      }
      item.append(actions);
    }
    list.append(item);
  }
}

function renderAudit(value) {
  const body = document.querySelector("#audit-body");
  body.replaceChildren();
  for (const event of [...value.events].reverse()) {
    const row = document.createElement("tr");
    for (const [key, field] of [
      ["timestamp", event.timestamp],
      ["component", event.component],
      ["action", event.action],
      ["outcome", event.outcome],
      ["correlation", event.correlation_id],
    ]) {
      const cell = text("td", field);
      if (key === "outcome") cell.className = `outcome-${event.outcome}`;
      row.append(cell);
    }
    body.append(row);
  }
}

async function refresh() {
  error.textContent = "";
  try {
    const [status, policy, approvals, audit, config] = await Promise.all([
      api("/api/status"),
      api("/api/policy"),
      api("/api/approvals"),
      api("/api/audit"),
      api("/api/config"),
    ]);
    renderStatus(status);
    renderPolicy(policy);
    renderApprovals(approvals);
    renderAudit(audit);
    fillForm(config);
    showConsole();
  } catch (cause) {
    error.textContent =
      cause.message === "admin token required" ? "" : cause.message;
    showLogin();
  }
}

document.querySelector("#unlock").addEventListener("click", () => {
  state.token = document.querySelector("#token").value.trim();
  refresh();
});
document.querySelector("#token").addEventListener("keydown", (event) => {
  if (event.key === "Enter") document.querySelector("#unlock").click();
});
document.querySelector("#refresh").addEventListener("click", refresh);
for (const link of navigation.querySelectorAll("a")) {
  link.addEventListener("click", () => {
    for (const item of navigation.querySelectorAll("a"))
      item.removeAttribute("aria-current");
    link.setAttribute("aria-current", "location");
  });
}
for (const platform of ["discord", "slack"])
  document
    .querySelector(`#${platform}-enabled`)
    .addEventListener("change", () => setPlatformState(platform));
document
  .querySelector("#validate-settings")
  .addEventListener("click", (event) =>
    withButton(event.currentTarget, async () => {
      const value = await api("/api/config/validate", {
        method: "POST",
        body: JSON.stringify(readForm()),
      });
      renderChecks(
        value,
        value.valid ? "設定は保存できます。" : "修正が必要な項目があります。",
      );
    }),
  );
document.querySelector("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  withButton(document.querySelector("#save-settings"), async () => {
    const value = await api("/api/config", {
      method: "POST",
      body: JSON.stringify(readForm()),
    });
    fillForm(value.config);
    renderChecks(
      value,
      "保存しました。起動中のGatewayには再起動後に反映されます。",
    );
  });
});
document.querySelector("#run-doctor").addEventListener("click", (event) =>
  withButton(event.currentTarget, async () => {
    const value = await api("/api/doctor", { method: "POST", body: "{}" });
    renderChecks(
      value,
      value.ok
        ? "Doctorはすべて成功しました。"
        : "Doctorで確認が必要な項目があります。",
    );
  }),
);
refresh();
