# 脅威モデル

> [!CAUTION]
> この実験的な脅威モデルは完全ではなく、独立したセキュリティreviewを受けていません。「必須invariant」はtest・reviewすべき設計要件であり、証明済みの保証ではありません。

[English](en/threat-model.md)

## 保護対象

- Discord、Slack、providerのcredential
- capability signing key
- 許可したworkspace外のfile
- OpenShellとcontainer runtimeのcontrol socket
- policy、snapshot、restore、destroyの権限
- message送信、repository write、購入、本番変更などの外部副作用
- auditの整合性とsubject attribution

## 想定する攻撃者・侵害

- 悪意あるpromptまたはattachment
- 侵害されたskill、extension、dependency、AI CLI
- userの意図を超えるmodel生成command
- forwardされたendpointを呼び出そうとする別local process
- replayまたは改変されたcapability
- 侵害されたsandbox内xangi process

## 必須invariant

- Agent Workloadにraw platform/provider credentialが存在しない。
- workloadは自身のOpenShell policyを変更できず、sandboxを管理できない。
- filesystem traversal、symlink escape、private network access、未登録network destinationを拒否する。
- capability利用はsandbox、session、user、channel、workspace、resource、action、期限、nonceに束縛される。
- すべての外部副作用には狭いscopeのcapabilityが必要で、必要な場合はone-use host承認も要求する。
- 認可またはaudit永続化が失敗した場合、危険な操作はfail closedになる。
- snapshotからcredential、signing key、live capability、socket、lock、PID fileを除外する。

## 対象外

- host kernel、OpenShell driver、firmware、hardwareの脆弱性
- 悪意あるhost administrator
- 設定済みCPU、memory、disk、time limit内のdenial of service
- システムが完全に安全であるという主張
- multi-tenant隔離。初期releaseはsingle-operator reference stackです。
- 独立したpenetration test、形式検証、supply chain audit、網羅的な脆弱性評価
