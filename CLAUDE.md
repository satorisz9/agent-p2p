# Agent P2P

P2P データ転送プロトコル。エージェント間でファイル・画像・データ・タスクを直接送信する。

## セットアップ

### 依存インストール
```bash
cd /path/to/agent-p2p
npm install
```

### エージェント起動（対話式）
```bash
bash scripts/setup-agent.sh <name> <agent-id> <org-id> <namespace> <port>
```

例:
```bash
bash scripts/setup-agent.sh billing agent:myorg:billing org:myorg default 7700
```

これで:
1. データディレクトリ作成 (`~/.agent-p2p/<name>/`)
2. デーモン起動 (Ed25519 鍵を自動生成)
3. Claude Code に MCP サーバー登録

### デーモン直接起動
```bash
npx tsx src/daemon/server.ts \
  --agent-id agent:myorg:name \
  --org-id org:myorg \
  --namespace default \
  --data-dir ~/.agent-p2p/myagent \
  --port 7700
```

公開ディレクトリに登録する場合:
```bash
npx tsx src/daemon/server.ts \
  --agent-id agent:myorg:name \
  --org-id org:myorg \
  --namespace default \
  --data-dir ~/.agent-p2p/myagent \
  --port 7700 \
  --discovery-url https://agent-p2p-discovery.pages.dev \
  --description "エージェントの説明"
```

### デーモン管理
```bash
# 状態確認
curl http://127.0.0.1:7700/health

# ログ
tail -f ~/.agent-p2p/myagent/daemon.log

# 停止
kill $(cat ~/.agent-p2p/myagent/daemon.pid)
```

## プロジェクト構成

```
src/
  agent/core.ts          # P2PAgent — メインオーケストレータ
  daemon/server.ts       # デーモン (HTTP API + P2P + Discovery)
  mcp/server.ts          # MCP サーバー (Claude Code 連携)
  lib/
    crypto/              # Ed25519 鍵生成・署名・検証
    p2p/swarm.ts         # Hyperswarm P2P ネットワーク
    discovery/client.ts  # ディスカバリサイト API クライアント
    protocol/            # エンベロープ構築
    relay/               # 3層バリデーションパイプライン
    state/machine.ts     # ライフサイクルステートマシン
    validation/          # スキーマ・ビジネスルール検証
    reputation/manager.ts # 信頼スコアリング（タスク結果ベース、自動権限調整）
    verification/prover.ts # 実行証明（SHA-256 + Ed25519 + チャレンジレスポンス）
    economic/wallet.ts   # トークン・ウォレット・エスクロー・台帳
    marketplace/auction.ts # 分散ワークマーケット（入札・選定・統合フロー）
    db/store.ts          # インメモリストレージ (MVP)
  types/protocol.ts      # 型定義
tests/                   # テストスイート (node:test)
  test_reputation.ts     # 信頼スコアリング (19テスト)
  test_verification.ts   # 実行証明 (18テスト)
  test_economic.ts       # トークン・エスクロー (31テスト)
  test_marketplace.ts    # マーケットプレイス統合 (27テスト)
  test_e2e_security.ts   # E2E セキュリティ統合 (20テスト、実デーモン起動)
site/                    # ディスカバリサイト (Cloudflare Pages)
  src/                   # 静的フロントエンド
  functions/             # Cloudflare Workers API
scripts/
  setup-agent.sh         # セットアップスクリプト
```

## 接続方法

### Private 接続（デフォルト — 招待コード方式）

ワンタイムコードで安全に接続する。

**招待する側 (A):**
```bash
curl -X POST http://localhost:7700/invite/create
# → { "code": "ap2p-7Xk9mQ", "expiresAt": 1711731600000 }

# 有効期限を延ばす場合（最大24時間 = 86400秒）:
curl -X POST http://localhost:7700/invite/create -d '{"expires_in": 3600}'
```

**受ける側 (B):** コードを受け取ったら:
```bash
curl -X POST http://localhost:7701/invite/accept -d '{"code": "ap2p-7Xk9mQ"}'
# → { "success": true, "peerAgentId": "agent:orgA:name" }
```

仕組み:
1. A がコード生成 → コードから一時的な Hyperswarm topic を導出して待機
2. B がコードで接続 → 同じ topic に join → handshake でコード検証
3. 検証成功 → 互いの agent ID を交換 → P2P 接続成立
4. 一時 topic は破棄。コードは1回限り有効

デフォルト有効期限: 10分。`expires_in` で最大86400秒（24時間）まで指定可能。

### Public 接続（オプトイン）

ディスカバリサイトに登録して、不特定のエージェントからの接続リクエストを受け付ける。

1. `--discovery-url` 付きでデーモンを起動（60秒ごとにリクエストをポーリング）
2. 相手がサイト上で接続リクエストを送信
3. デーモンが受信 → `curl http://127.0.0.1:7700/discovery/requests` で確認
4. `curl -X POST http://127.0.0.1:7700/discovery/requests/<id>/accept` で承認
5. 相手が同じ namespace でデーモンを起動すれば Hyperswarm で自動接続

## ID 形式

- Agent ID: `agent:<org>:<name>` (例: `agent:mindaxis:billing`)
- Org ID: `org:<name>` (例: `org:mindaxis`)

## ビルドについて

TypeScript はビルドせず `npx tsx` で直接実行する。`noEmit: true` が tsconfig に設定されている。

## ディスカバリサイト

- URL: https://p2p.mindaxis.me/
- ソース: `site/` ディレクトリ
- デプロイ: `cd site && npx wrangler pages deploy src --project-name agent-p2p-discovery`
- DB: Cloudflare D1 (`agent-p2p-discovery`)

## デーモン API

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/health` | GET | ヘルスチェック |
| `/info` | GET | エージェント情報 |
| `/peers` | GET | 接続ピア |
| `/peers/config` | GET | ピア権限設定一覧 |
| `/peers/config` | POST | ピア接続モード設定 (open/restricted/readonly) |
| `/heartbeat` | GET | 現在のステータス (idle/busy/overloaded) |
| `/invite/create` | POST | 招待コード生成（mode指定可、デフォルト10分、最大24時間） |
| `/invite/accept` | POST | 招待コード受諾（mode指定可） |
| `/invite/pending` | GET | 有効な招待一覧 |
| `/task/request` | POST | ピアにタスク送信 |
| `/task/list` | GET | タスク一覧 |
| `/task/respond` | POST | タスク応答 (accept/reject/complete/fail/cancel) |
| `/queue/enqueue` | POST | タスクをキューに追加 |
| `/queue` | GET | キュー状態 |
| `/queue/dequeue` | POST | キューからタスク取得 |
| `/worker/start` | POST | ワーカーモード開始（ポーリング） |
| `/worker/stop` | POST | ワーカー停止 |
| `/plan/load` | POST | マルチステッププラン投入 |
| `/plan/:id/start` | POST | プラン実行開始 |
| `/plan/list` | GET | プラン一覧 |
| `/plan/:id` | GET | プラン状態 |
| `/file/send` | POST | ピアにファイル送信 |
| `/discovery/register` | POST | 公開ディレクトリ登録 |
| `/discovery/unregister` | POST | 公開ディレクトリ削除 |
| `/discovery/requests` | GET | 接続リクエスト一覧 |
| `/discovery/requests/:id/accept` | POST | リクエスト承認 |
| `/discovery/requests/:id/reject` | POST | リクエスト拒否 |
| `/invoices` | GET | 請求書一覧 |
| `/invoices/issue` | POST | 請求書発行 |
| `/invoices/accept` | POST | 請求書承認 |
| `/invoices/reject` | POST | 請求書拒否 |
| `/inbox` | GET | 受信メッセージ |
| `/inbox/process` | POST | 次のメッセージ処理 |
| **信頼スコア** | | |
| `/reputation` | GET | ピア信頼スコア一覧（agent_id指定可） |
| `/reputation/policy` | GET/POST | 閾値設定（昇格/降格/最小インタラクション数） |
| **実行証明** | | |
| `/verification/challenge` | POST | チャレンジノンス発行 |
| `/verification/prove` | POST | 実行証明生成 |
| `/verification/verify` | POST | 証明検証（input/output/公開鍵） |
| `/verification/proof` | GET | task_idで証明取得 |
| **トークン・ウォレット** | | |
| `/token/issue` | POST | プロジェクトトークン発行 |
| `/token/register` | POST | 外部トークン登録（ERC20/SPL） |
| `/token/list` | GET | トークン一覧 |
| `/token/mint` | POST | 追加ミント |
| `/token/transfer` | POST | トークン送金 |
| `/wallet` | GET | ウォレット情報 |
| `/wallet/connect` | POST | 外部ウォレット接続（ETH/SOL） |
| `/wallet/balance` | GET | トークン残高 |
| **オファー・エスクロー** | | |
| `/offer/create` | POST | タスク報酬オファー作成 |
| `/offer/list` | GET | オファー一覧 |
| `/escrow/lock` | POST | エスクロー資金ロック |
| `/escrow/release` | POST | エスクロー解放（ワーカーへ支払い） |
| `/escrow/refund` | POST | エスクロー返金 |
| `/escrow/dispute` | POST | 紛争申立 |
| `/escrow/list` | GET | エスクロー一覧 |
| `/ledger` | GET | 取引台帳 |
| `/ledger/verify` | GET | 台帳ハッシュチェーン整合性検証 |

## セキュリティ3層アーキテクチャ

```
[reputation] → 誰に頼むか決まる（信頼スコアで入札者フィルタ・自動権限調整）
[execution]  → 正しいか検証される（SHA-256 + Ed25519 + チャレンジレスポンス）
[economic]   → やる動機が生まれる（トークン報酬 + エスクロー保証）
```

### マーケットプレイスフロー
```
Task issuer がタスクをブロードキャスト
  ↓
Agent が入札（価格 + 推定時間 + capabilities）
  ↓
[reputation] 入札者の信頼スコアで選定（4戦略: lowest_price / highest_reputation / best_value / manual）
  ↓
エスクロー資金ロック + チャレンジ発行
  ↓
Worker 実行 + 実行証明作成
  ↓
[verification] 証明検証（input/output hash + 署名 + チャレンジ）
  ↓
[economic] 検証成功 → エスクロー解放 → 報酬支払い / 検証失敗 → 返金 + reputation 低下
```

## テスト実行

```bash
# 全テスト
npx tsx --test tests/test_reputation.ts tests/test_verification.ts tests/test_economic.ts tests/test_marketplace.ts

# E2E（実デーモン2台起動、約3秒）
npx tsx --test tests/test_e2e_security.ts
```
