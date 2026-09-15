# 使い方

> [!CAUTION]
> Neon Xangiは実験段階です。使い捨て可能なcredentialと機密情報を含まないテスト用workspaceから始めてください。setupやスモークテストの成功を、安全性の証明として扱わないでください。

[English](en/usage.md)

## AIガイド付きSetup

通常の導入は1行です。installerはplatformに合うmanaged bundleとchecksumをGitHub Releaseから取得し、`~/.local/bin/neonxangi`を配置します。

```bash
curl -fsSL https://raw.githubusercontent.com/karaage0703/neonxangi/main/install.sh | sh
```

まずxangiと共通の`setup-ai-tools.sh`で、`codex`、`claude-code`、`github-copilot`のいずれかを準備します。`neonxangi setup`はPATH上の認証済み対応CLIを検出し、案内用AIとの対話を開始します。対話では最初に、sandbox内のxangiが実際に使うAI backendを選びます。続いて[ai-assistant-workspace](https://github.com/karaage0703/ai-assistant-workspace)を未使用の`~/neonxangi-workspace`（使用済みなら連番付き）へ新規cloneする案を推奨します。空のテスト用workspaceも選択でき、その場合は型付き`neonxangi setup --apply`がdirectoryを作成します。個人情報や実データを含む既存workspaceは探索せず、利用者が明示した場合だけ使います。最初のprofileはread-onlyの`observe`です。

hostへxangiをinstallする必要はありません。Neon Xangiはversion固定したxangiと対応AI CLIをBlueprintのsandbox imageに導入します。workload初回起動時は、通常backendではxangiの型付き`setup --apply`を実行し、Local LLMでは同じ型付きsetup storeへ設定を保存します。xangiの設定は`/var/lib/xangi`の専用writable stateに保存され、hostの既存xangi設定と分離されます。

managed bundleはNode.js runtimeと固定版OpenShell CLIを同梱します。Node.js 22.16以上、npm、別のOpenShell binaryが必要なのはsource checkoutの開発時だけです。利用者がbundle path、checksum、runtime pathを入力する必要はありません。

Codexを選んだ場合、sandbox作成時にhostのmode 0600な`~/.codex/auth.json`を所有者確認付きで読み、OAuth credentialをOpenShell providerへ登録します。値はNeon Xangiの設定、CLI引数、画面、logへ出さず、短時間のOpenShell子process環境だけでgatewayへ渡します。sandbox内には実値ではなくOpenShellのplaceholderが生成されます。

詳細指示はmode 0600の一時fileへ置き、AI process終了時に削除します。表示promptにはそのpathと短い開始指示だけを渡します。platform tokenやsecret値を会話やコマンド引数へ渡してはいけません。AIガイドはOpenShell sandbox作成前にhost上で動くため、これはOS境界によるcredential隔離ではありません。platform credentialは対話終了後、次の設定GUIへ入力してください。

```bash
neonxangi setup
neonxangi settings
```

AI CLIが無い、または使わない場合は`neonxangi settings`から開始できます。

## 更新

`neonxangi update`は最新Releaseのmanaged bundle、checksum、installerを取得して検証し、新しいversionへ切り替えます。設定、credential、snapshotはversion別のapplication directoryとは別に保持されます。実行中のhost processは自動で再起動しないため、更新後に状態を確認して`neonxangi stop`と`neonxangi start`を実行してください。すでに最新版の場合は変更せず正常終了します。

```bash
neonxangi update
```

## 設定Console

`neonxangi settings`はsandbox未作成でもloopback Consoleを起動し、認証済みbrowserを自動で開きます。通常は管理tokenの入力やcopyは不要です。root URLを手動で開いた場合だけ復旧用のtoken入力欄が表示され、その用途とpathを画面内で説明します。GUIでは次を扱います。

- workspace、profile、sandbox名
- Discord/Slackの有効化、token、user/channel allowlist
- user、Bot、channel、autoreply allowlist
- 保存前の検証、マスク済み全設定、Doctor結果
- 稼働後のruntime状態、policy、承認、audit

入力したtokenはNeon Xangiの専用`secrets/`へmode 0600で保存し、APIや画面へ返しません。空欄で保存すると設定済みtokenを維持します。変更は起動中Gatewayへ自動反映しないため、画面に表示される「再起動が必要」に従い、影響を確認してから`neonxangi stop`と`neonxangi start`を実行してください。

## Onboard（自動化・手動CLI）

`neonxangi onboard`は自動化向けの低水準CLIです。mode 0600のJSON設定を書き、Ed25519 signing keyとConsole tokenを生成します。この経路だけは既存secret fileの絶対pathを明示できます。通常利用では`neonxangi settings`へtokenを直接入力してください。

token専用fileの代わりに既存xangiのmode 0600な`.env`を使う場合は、`--discord-token-file`へ`.env`のpath、`--discord-token-key DISCORD_TOKEN`を指定します。Neon Xangiは指定keyだけを読み、token値を設定fileへcopyしません。

対応するworkloadは、Codex、Claude Code、xangi Local LLM、GitHub Copilot CLIのいずれかを使うxangi 1 instance、workspace 1つ、Discord/Slack Platform Gatewayです。Local LLMは`http://host.openshell.internal:<port>`形式の接続先とmodel IDを設定し、そのhost・portだけをPolicyへ追加します。sandbox内ではloopback relayが`/v1/models`、`/v1/chat/completions`、`/api/tags`、`/api/chat`だけを固定した接続先へ中継します。OpenShellがsandbox対応を案内していないCursor、Grok、Antigravityは現時点の選択肢へ含めません。まずplatformを設定せず、localの境界から確認してください。

Discord Gatewayは許可したuserとchannelの組み合わせのうち、DM、Botへのmention、許可済みthread、または`--discord-auto-reply-channel`へ明示したchannelに応答します。Bot投稿は既定で拒否します。Bot間試験では`onboard --discord-bot BOT_ID`で相手を個別許可できますが、Gateway自身の投稿は常に拒否され、同じBotへの連続応答は`--discord-bot-max-consecutive`（既定3）で停止します。`*`による全Bot許可はありません。

Slack GatewayはSocket Modeで接続します。`--slack-token-file`には`SLACK_BOT_TOKEN`と`SLACK_APP_TOKEN`を含むmode 0600のdotenvを指定し、`--slack-user`と`--slack-channel`を必ず明示します。通常channelでメンションなし応答が必要なchannelだけ`--slack-auto-reply-channel`にも追加します。DM、app mention、許可済みthread返信は処理対象です。

両Gatewayは受信時に👀を付け、xangiのSSE eventに沿って考慮中・tool・本文を投稿または編集し、終了時に👀を外します。platform APIのraw tokenはhost processにだけ存在し、sandboxへ渡す共有secretはRemote Platform Adapter専用の起動時ランダム値です。

## Profile

- `observe`: workspaceはread-only。一般的な外部network policyは許可しません。
- `develop`: workspaceはread/write。package registryとGitHub readを許可します。pushにはhost Brokerと承認が必要です。
- `research`: workspaceはread-only。名前を指定したpublic research endpointだけを許可します。
- `operate`: workspaceはread/writeで、strict Landlock互換です。副作用はBrokerを経由する必要があります。
- `isolated`: 使い捨てworkspace、strict Landlock、一般的なoutbound accessなしです。

Profileは許可するjobを宣言するもので、単一方向に強くなるsecurity levelではありません。

## コマンド

```text
neonxangi doctor
neonxangi setup [--apply --backend BACKEND --workspace PATH --profile PROFILE]
  [--local-llm-base-url URL --local-llm-model MODEL]
neonxangi settings [--no-open]
neonxangi update
neonxangi onboard
neonxangi sandbox create|delete|rebuild
neonxangi start|status|logs|stop|connect
neonxangi policy show|diff|apply
neonxangi snapshot
neonxangi restore SNAPSHOT EMPTY_DESTINATION
neonxangi uninstall --yes [--keep-credentials]
```

削除、rebuild、policy適用、uninstallには`--yes`が必要です。Restoreは空でないdestinationを拒否します。Consoleは認証済みTLS proxyなしではloopback以外へbindできません。

## 復旧

1. `neonxangi status`と`neonxangi logs`を実行します。
2. `neonxangi doctor`でgateway、version、設定の失敗を切り分けます。
3. snapshotを作成して検証します。
4. `sandbox rebuild --yes`を使います。credentialを除くxangi/Integration stateをarchiveし、host snapshot manifestを検証してsandboxを置換し、stateを復元してからworkloadを開始します。
5. 隔離状態に確信が持てない場合はhost planeを停止してsandboxを削除します。channel/provider credentialは各正本systemで失効させてください。
