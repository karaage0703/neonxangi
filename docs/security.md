# セキュリティ確認

> [!CAUTION]
> これは実験的な確認checklistであり、完了したセキュリティ評価ではありません。合格しても、脆弱性がないことや本番運用が安全であることは証明できません。OpenShell driver、host、policy、credential経路、運用環境ごとに個別のreviewとtestが必要です。

[English](en/security.md)

利用を検討する前に、対応対象とするOpenShell driverごとに次の確認を実行してください。

## 自動確認

```bash
npm ci
npm run check
neonxangi doctor
```

testはcapabilityの改変、期限、binding、replay、path traversal、one-use承認、fail-closed audit動作、snapshot除外と整合性、Integration identity確認、Bridgeからxangiまでの経路を対象にします。このcoverageは実装済みtest caseの範囲に限られ、脆弱性評価ではありません。

## Sandboxスモークテスト

sandbox内で次をすべて確認します。

- `DISCORD_TOKEN`、`GITHUB_TOKEN`、`GH_TOKEN`、raw provider keyが存在しない。
- host home、SSH key、Docker socket、OpenShell management endpointのreadが失敗する。
- 許可したworkspace/state/tmp以外へのwriteが失敗する。
- `observe`と`research`ではworkspace内へのwriteも失敗する。
- `develop`でallowlist対象のGitHub GETは成功し、POSTとgit receive-packは失敗する。
- private networkとmetadata endpointへのaccessが失敗する。
- CodexでWeb検索、Apps、Browser、plugin、MCP toolが利用できない。
- sandbox内からのpolicy変更とsandbox削除が失敗する。
- 改変、期限切れ、workspace/user不一致、replayされたcapabilityが失敗する。

Codex OAuthは、OpenShell placeholderを参照する`auth.json`としてsandbox内だけへmaterializeします。access、refresh、account fieldはOpenShell proxyが解決するopaque placeholderで、localで解析するID tokenはsecretを含まないsynthetic JWTです。Snapshot対象からCodex auth directory、host signing key、live capability token、PID/lock/socket file、quarantine dataを除外します。

OpenShellの通信先allowlistが制御するのはsandbox内commandの直接通信です。provider側で実行されるWeb検索、Apps、Browser、plugin、MCPは別経路なので、Codex imageでは`/etc/codex/requirements.toml`を使って管理者権限で無効化します。通常の`config.toml`にも`web_search = "disabled"`を設定しますが、強制境界はproject設定から上書きできないsystem requirementsです。他のAI backend固有のhosted toolは個別に検証が必要です。

hostから許可済みDiscord round tripを確認し、BridgeとIntegrationのaudit eventをcorrelation IDで照合します。その後test sandboxを破棄し、process、mount、port forward、capabilityが残っていないことを確認します。

driver、OpenShell version、host kernel、policy、image digest、確認日を記録し、いずれかが変わったら再評価してください。本番credentialや機密データを扱う前には、独立したreviewと攻撃的testが別途必要です。
