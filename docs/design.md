# アーキテクチャ

> [!CAUTION]
> Neon Xangiは実験段階です。この設計は意図した境界を説明するものであり、独立した検証を経たセキュリティ保証ではありません。

[English](en/design.md)

## セキュリティ上の位置づけ

Neon Xangiは、xangi、AI CLI process、model出力、skill、extension、downloadしたcode、workspace内容を、まとめて1つの非信頼Agent Workloadとして扱います。OpenShellがOSとnetworkの境界を担い、Neon Xangiがnetwork filterだけでは表現できないchannel、identity、capability、承認、auditの境界を担います。

```text
Discord ─┐                                               │
         ├─ host Platform Gateway ─ signed turn/SSE ─────┤
Slack ───┘                                               │
Admin ── loopback Console ── Controller ── OpenShell ─────┼─ sandbox
                              │                          │  ├─ Integration
                              ├─ capability signer       │  ├─ xangi
                              ├─ audit log               │  ├─ 選択したAI CLI
                              └─ Tool Broker ◀───────────┘  └─ workspace
```

raw channel credential、Ed25519 private key、policy変更、承認判断、snapshot管理、sandbox破棄はhostに残します。sandboxが受け取るのはpublic verification key、uploadしたworkspace、OpenShellが構成するprovider accessです。

xangiはhostの前提softwareではなく、version固定Blueprintがsandbox image内へ導入するAgent runtimeです。workloadの初回起動はxangi自身の型付きsetup CLIまたはsetup storeを通し、Agent backendと`/workspace`をxangi側stateへ保存します。Neon Xangiはxangiの設定形式を独自実装しません。

## Setupと設定管理

managed bundleはNode.jsと互換性を固定したOpenShell CLIを含み、launcherが同梱binaryを既定値として選びます。これによりinstallation後の最初の製品commandを`neonxangi setup`へ固定し、利用者からruntime pathとchecksumを隠します。初回setupはxangiのguided onboardingと同じ分離を採用します。host上の決定的な事前確認が固定allowlistからAI CLIを検出し、mode 0600の一時指示fileを介して日本語の対話を開始します。AIはsandbox内のxangiで使うbackendをCodex、Claude Code、xangi Local LLM、GitHub Copilot CLIから明示的に選ばせ、次に`ai-assistant-workspace`の新規cloneを第一候補にし、空workspaceまたは利用者が明示した既存workspaceも選択肢として扱います。OpenShell作成前のAI CLIはhost user権限で動くため、秘密値を入力させず、platform credentialの設定を後段のConsoleへ分離します。

Consoleの設定APIは編集可能fieldをruntime、Discord、Slackの固定schemaへ限定し、未知field、wildcard、allowlist外autoreply、存在しないworkspace、不正sandbox名を拒否します。POSTされたtokenは専用secret fileへmode 0600でatomicに保存し、GETはraw secretや内部pathを返さず検証成否だけを返します。稼働中Gatewayへhot applyせずrestart requiredとして表示します。`settings`単独modeと稼働中hostは同じAPI/UIを共有します。CLIから開くbrowserは60秒有効・one-useのticketを8時間のHttpOnly/SameSite cookieへ交換して自動認証し、永続管理tokenをURLやbrowser storageへ渡しません。root URLを直接開いた場合だけ手動復旧tokenの説明を表示します。

## Capability契約

CapabilityはEd25519で署名した`nx1` tokenです。claimはissuer、sandbox、xangi conversation、platform user、channel、workspace、許可するcapability/action/resourceの組、期限、nonceを束縛します。有効期間は最大5分で、通常のturnは2分です。IntegrationとBrokerは署名変更、期限切れ、subject/resource不一致、nonce replayを拒否します。

Capability認可はOpenShellによる強制の代替ではありません。application codeが侵害されても、filesystemとnetwork policyが同じ禁止経路を拒否する必要があります。

## Turnの経路

1. host GatewayがDiscord/Slack user/channel allowlistを検証し、event IDを重複排除します。
2. Controllerがeventのsubjectとworkspaceに束縛した1 turn用capabilityへ署名します。
3. Bridgeはhost Controllerが所有・監視するloopback OpenShell gRPC service forwardを通じて、正規化した内容をsandbox Integrationへ転送します。
4. Integrationは署名、identity、scope、期限、nonceを検証し、認証付きRemote Platform eventへ正規化します。
5. xangiはplatform種別を維持した通常session、workspace binding、Agent、共通lifecycle eventで処理し、OpenShell管理のprovider routeまたはLocal LLM用loopback relay経由で選択したAI backendを実行します。relayの接続先は設定時に固定し、推論・model列挙の4 API pathだけを許可します。platform tokenは環境変数に存在しません。
6. Integrationは`started`、本文差分、tool、error、完了をSSE中継します。host Gatewayだけが👀、返信・編集、thread投稿をDiscord/Slack APIへ実行できます。
7. hostとsandboxのaudit recordは共通のcorrelation IDを持ちます。

## 副作用と承認

read actionはcapabilityに明記されている場合に実行できます。read以外のBroker actionは実行せず、承認待ちを作成します。承認recordは正確なcapability、action、resourceに束縛され、1回だけ消費できます。承認後の試行には別の新しいcapabilityが必要です。

## Lifecycle

`doctor`はhost、OpenShell version/gateway、workspace、profile、backend、host identityを確認します。`sandbox create`はversion固定済みblueprintをbuildし、選択したbackendのproviderを接続し、workspaceとpublic keyだけをsandboxへ渡して、xangiとIntegrationを開始します。`observe`と`research`ではworkspaceをimage build時に取り込み、sandboxへworkspace write権限を一度も付与しません。`start`は管理対象のIntegration forward、Bridge、Broker、Consoleを、PID/log fileを持つhostのdetached processとして開始します。Policy変更には事前diffと明示的な`--yes`が必要です。Rebuildは置換前にcredentialを含まないhost/xangi/Integration stateをsnapshotし、workload開始前に復元します。

## Version管理

`blueprint/manifest.yaml`を互換性情報の正本とします。imageはOpenShell runtime environment連携とRemote Platform Adapterを収録したxangi v0.56.4のcommit `726ecfc7f1e6d9bf7d553c203cff0a7b0a43b84e`を固定します。downstream patchは適用しません。対応OpenShellは`>=0.0.116,<0.1.0`です。runtimeで任意のlatest versionは取得しません。
