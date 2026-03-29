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
