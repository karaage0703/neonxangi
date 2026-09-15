# Neon Xangi Consoleデザイン

[English](en/console-design.md)

Consoleはchat画面ではなく、host上のsetup・設定・運用instrumentです。compactなdark canvas、cobaltのstatus accent、明示的なtrust boundary表現、密度の高いmonospace運用dataを使います。最初に「接続先と応答範囲を設定する」目的と3つの手順を示し、設定、稼働状況、権限ポリシー、承認、操作履歴の順にlinearにします。抽象的なhero copyや、説明なしのsecurity用語を主要見出しに使いません。

## Tokenとcomponent

- Canvasとsurfaceは黒に近いblueのOKLCH値を使い、card装飾を増やさずborderを視認可能にします。
- displayはSpace Grotesk/Avenir Next、bodyはIBM Plex Sans/Segoe UI、運用dataはIBM Plex Mono/SFMonoのfont stackです。
- controlには最小44 pxのhit target、視認可能なfocus ring、明示的なhover/pressed/disabled stateを持たせます。
- formはfieldsetと常時表示labelで意味を分け、help、required、検証errorをplaceholderや色だけに依存させません。保存・検証・Doctorはloading、success、errorをaria-liveで通知します。
- status cellはtablet幅で4列から2列、375 px以下で1列へ畳みます。
- 横長のaudit dataはpageを広げず、keyboard focus可能なhorizontal scroller内に置きます。
- 権限画面は「許可・制限付き・ブロック」を文章と状態ラベルで示し、色だけに依存させません。AI backend経由のWeb機能とsandboxからの直接通信を別項目にします。
- 現在のsandboxから取得したactive policyを優先し、取得できない時は設定上の次回適用policyであることをbannerで明示します。

## 制約

- credential値は描画しません。`neonxangi settings`は短寿命のone-time ticketをHttpOnly cookieへ交換してbrowserを自動認証します。永続管理tokenをURLやbrowser storageへ渡しません。URLを直接開いた場合だけ用途を説明した手動復旧欄を表示し、入力値はtabを閉じるまでのmemoryにだけ保持します。
- credential設定はmode 0600 fileのpath、dotenv key、検証成否だけを描画します。保存後のruntime反映にはrestartが必要だと明示します。
- 承認actionは判断controlより先にoperationとresourceを必ず表示します。
- errorはARIA live alertを使い、reduced-motion preferenceでは不要なtransitionを無効にします。
- 320〜414 pxのmobile幅でdocument-levelのhorizontal overflowを発生させません。
- 認証前は未表示sectionへのnavigationを隠し、認証後はdesktop/mobileの両方で設定・稼働状況・権限・履歴へ移動できるようにします。
