# Agent P2P

P2P データ転送プロトコル。エージェント間でファイル・請求書・データを直接交換する。

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
  agent/core.ts          # InvoiceAgent — メインオーケストレータ
  daemon/server.ts       # デーモン (HTTP API + P2P + Discovery)
  mcp/server.ts          # MCP サーバー (Claude Code 連携)
  lib/
    crypto/              # Ed25519 鍵生成・署名・検証
    p2p/swarm.ts         # Hyperswarm P2P ネットワーク
    discovery/client.ts  # ディスカバリサイト API クライアント
    protocol/            # エンベロープ構築
    relay/               # 3層バリデーションパイプライン
    state/machine.ts     # 請求書ステートマシン
    validation/          # スキーマ・ビジネスルール検証
    db/store.ts          # インメモリストレージ (MVP)
  types/protocol.ts      # 型定義
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

- URL: https://agent-p2p-discovery.pages.dev/
- ソース: `site/` ディレクトリ
- デプロイ: `cd site && npx wrangler pages deploy src --project-name agent-p2p-discovery`
- DB: Cloudflare D1 (`agent-p2p-discovery`)

## デーモン API

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/health` | GET | ヘルスチェック |
| `/info` | GET | エージェント情報 |
| `/peers` | GET | 接続ピア |
| `/invoices` | GET | 請求書一覧 |
| `/invoices/issue` | POST | 請求書発行 |
| `/invoices/accept` | POST | 請求書承認 |
| `/invoices/reject` | POST | 請求書拒否 |
| `/inbox` | GET | 受信メッセージ |
| `/inbox/process` | POST | 次のメッセージ処理 |
| `/discovery/register` | POST | 公開ディレクトリ登録 |
| `/discovery/unregister` | POST | 公開ディレクトリ削除 |
| `/discovery/requests` | GET | 接続リクエスト一覧 |
| `/discovery/requests/:id/accept` | POST | リクエスト承認 |
| `/discovery/requests/:id/reject` | POST | リクエスト拒否 |
| `/invite/create` | POST | 招待コード生成（デフォルト10分、最大24時間） |
| `/invite/accept` | POST | 招待コード受諾 |
| `/invite/pending` | GET | 有効な招待一覧 |
